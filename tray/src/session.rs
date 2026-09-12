//! The engine thread: the one place that must always be on time.
//!
//! It owns the [`LiveModel`] outright — no locks, no shared mutable state — and does
//! nothing per tick but apply whatever messages have arrived and ask the pure
//! [`CueEngine`] what to play. Network stalls happen on the net thread and device stalls on
//! the audio thread, so neither can push a beep late.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use arc_swap::ArcSwap;
use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};

use crate::audio::AudioHandle;
use crate::engine::{CueEngine, Mutes, TICK_INTERVAL_MS};
use crate::model::{LiveModel, Update};

/// What the settings window shows about the Live session itself. Seeing the Shot and the
/// remaining seconds is what separates "the link is fine, nothing is running" from "the
/// link is dead" without leaving the machine.
#[derive(Debug, Clone, Default)]
pub struct SessionStatus {
    pub live_index: Option<usize>,
    pub shot_count: usize,
    pub remaining_ms: Option<u64>,
    pub running: bool,
}

#[derive(Clone)]
pub struct SessionHandle {
    updates: Sender<Update>,
    mute_count: Arc<AtomicBool>,
    mute_beep: Arc<AtomicBool>,
    status: Arc<ArcSwap<SessionStatus>>,
    stop: Arc<AtomicBool>,
}

impl SessionHandle {
    /// The sender the network thread pushes translated events into.
    pub fn updates(&self) -> Sender<Update> {
        self.updates.clone()
    }

    pub fn set_mutes(&self, mutes: Mutes) {
        self.mute_count.store(mutes.count, Ordering::Relaxed);
        self.mute_beep.store(mutes.beep, Ordering::Relaxed);
    }

    pub fn mutes(&self) -> Mutes {
        Mutes {
            count: self.mute_count.load(Ordering::Relaxed),
            beep: self.mute_beep.load(Ordering::Relaxed),
        }
    }

    pub fn status(&self) -> Arc<SessionStatus> {
        self.status.load_full()
    }

    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

pub fn spawn(audio: AudioHandle, mutes: Mutes) -> SessionHandle {
    let (tx, rx) = crossbeam_channel::unbounded();
    let handle = SessionHandle {
        updates: tx,
        mute_count: Arc::new(AtomicBool::new(mutes.count)),
        mute_beep: Arc::new(AtomicBool::new(mutes.beep)),
        status: Arc::new(ArcSwap::from_pointee(SessionStatus::default())),
        stop: Arc::new(AtomicBool::new(false)),
    };

    let worker = handle.clone();
    std::thread::Builder::new()
        .name("cue-engine".into())
        .spawn(move || run(rx, audio, worker))
        .expect("spawning the engine thread");

    handle
}

fn run(rx: Receiver<Update>, audio: AudioHandle, handle: SessionHandle) {
    let started = Instant::now();
    let mut model = LiveModel::default();
    let mut engine = CueEngine::new();
    let mut next = Instant::now();

    let tick = Duration::from_millis(TICK_INTERVAL_MS);

    while !handle.stop.load(Ordering::Relaxed) {
        next += tick;

        // Drain everything that arrived while we were waiting, then tick once. Applying an
        // update is microseconds of pure code, so a burst cannot delay the tick.
        loop {
            let wait = next.saturating_duration_since(Instant::now());
            match rx.recv_timeout(wait) {
                Ok(update) => model.apply(update, elapsed_ms(started)),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }

        let now = elapsed_ms(started);
        for cue in engine.tick(&model, handle.mutes(), now) {
            audio.play(cue);
        }

        handle.status.store(Arc::new(SessionStatus {
            live_index: model.live_index,
            shot_count: model.shots.len(),
            remaining_ms: model.remaining_ms(now),
            running: model.running,
        }));

        // After a long stall — a suspended laptop, a stop-the-world pause — resync rather
        // than firing a burst of catch-up ticks.
        if Instant::now() > next + tick {
            next = Instant::now();
        }
    }
}

fn elapsed_ms(started: Instant) -> i64 {
    started.elapsed().as_millis() as i64
}
