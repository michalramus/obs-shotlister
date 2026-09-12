//! Cue playback on its own thread.
//!
//! The audio device lives here rather than on the engine thread for two reasons: rodio's
//! sink is `!Send`, and device enumeration can stall for a couple of hundred milliseconds
//! when hardware is unplugged. Neither may ever delay a beep, so the engine only sends a
//! `Cue` down an unbounded channel and moves on.

pub mod cues;

use std::num::{NonZeroU16, NonZeroU32};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use arc_swap::ArcSwap;
use crossbeam_channel::{bounded, Receiver, RecvTimeoutError, Sender};
use rodio::cpal::traits::{DeviceTrait, HostTrait};
use rodio::source::Source;
use rodio::{buffer::SamplesBuffer, DeviceSinkBuilder, MixerDeviceSink};

pub use cues::Cue;

/// What the settings window shows about the output device. Its whole purpose is making a
/// wrong-default-device problem — routine on a machine full of capture hardware —
/// diagnosable at a glance rather than by elimination.
#[derive(Debug, Clone, Default)]
pub struct AudioHealth {
    /// Name of the device currently in use, if one opened.
    pub device: Option<String>,
    /// Why the last attempt to open a device failed.
    pub error: Option<String>,
}

/// The cue format, as the build script baked it in.
fn channels() -> rodio::ChannelCount {
    NonZeroU16::new(cues::CHANNELS).expect("cue channel count is non-zero")
}

fn sample_rate() -> rodio::SampleRate {
    NonZeroU32::new(cues::SAMPLE_RATE).expect("cue sample rate is non-zero")
}

enum Msg {
    Play(Cue),
    Shutdown,
}

/// Handle to the audio thread. Cloneable; dropping every clone does not stop the thread —
/// call [`AudioHandle::shutdown`] for that.
#[derive(Clone)]
pub struct AudioHandle {
    tx: Sender<Msg>,
    /// `f32` bit-cast into an atomic: read once per cue, written by the UI at slider rate.
    volume: Arc<AtomicU32>,
    health: Arc<ArcSwap<AudioHealth>>,
}

impl AudioHandle {
    pub fn play(&self, cue: Cue) {
        // A full channel would mean the audio thread has been wedged for a long time;
        // dropping the cue is better than blocking the engine's tick behind it.
        let _ = self.tx.try_send(Msg::Play(cue));
    }

    pub fn set_volume(&self, volume: f32) {
        self.volume
            .store(volume.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    pub fn volume(&self) -> f32 {
        f32::from_bits(self.volume.load(Ordering::Relaxed))
    }

    pub fn health(&self) -> Arc<AudioHealth> {
        self.health.load_full()
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(Msg::Shutdown);
    }
}

/// Starts the audio thread and returns a handle to it.
pub fn spawn(volume: f32) -> AudioHandle {
    // Bounded so a wedged device cannot grow the queue without limit. Sixteen is far more
    // than the two cues a single tick can produce.
    let (tx, rx) = bounded(16);
    let handle = AudioHandle {
        tx,
        volume: Arc::new(AtomicU32::new(volume.clamp(0.0, 1.0).to_bits())),
        health: Arc::new(ArcSwap::from_pointee(AudioHealth::default())),
    };

    let worker = handle.clone();
    std::thread::Builder::new()
        .name("cue-audio".into())
        .spawn(move || run(rx, worker))
        .expect("spawning the audio thread");

    handle
}

/// How long to wait before retrying after a device failure. Long enough not to spin while
/// an interface is unplugged, short enough that a replug is picked up before the next Shot.
const REOPEN_BACKOFF: Duration = Duration::from_secs(2);

fn run(rx: Receiver<Msg>, handle: AudioHandle) {
    let mut device: Option<MixerDeviceSink> = None;
    let mut next_attempt = Instant::now();

    loop {
        // Wake regularly even without cues so a replugged device is picked up before it is
        // needed, rather than the first cue after a failure being the one that is lost.
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Msg::Shutdown) | Err(RecvTimeoutError::Disconnected) => return,
            Ok(Msg::Play(cue)) => {
                if device.is_none() && Instant::now() >= next_attempt {
                    device = open(&handle, &mut next_attempt);
                }
                if let Some(sink) = &device {
                    let samples = cue.samples();
                    let source = SamplesBuffer::new(channels(), sample_rate(), samples)
                        .amplify(handle.volume());
                    // Added straight to the mixer rather than queued on a Player: on the
                    // expiry tick "one" and the beep fire together and must overlap, the
                    // way two independent HTMLAudioElements do in the browser.
                    sink.mixer().add(source);
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if device.is_none() && Instant::now() >= next_attempt {
                    device = open(&handle, &mut next_attempt);
                }
            }
        }
    }
}

fn open(handle: &AudioHandle, next_attempt: &mut Instant) -> Option<MixerDeviceSink> {
    *next_attempt = Instant::now() + REOPEN_BACKOFF;

    let Some(dev) = rodio::cpal::default_host().default_output_device() else {
        handle.health.store(Arc::new(AudioHealth {
            device: None,
            error: Some("no audio output device".into()),
        }));
        return None;
    };
    let name = dev.description().ok().map(|d| d.name().to_string());

    let builder = match DeviceSinkBuilder::from_device(dev) {
        Ok(b) => b,
        Err(err) => {
            handle.health.store(Arc::new(AudioHealth {
                device: name,
                error: Some(err.to_string()),
            }));
            return None;
        }
    };

    match builder.open_sink_or_fallback() {
        Ok(mut sink) => {
            // Without this, every reopen prints a warning to stderr on drop.
            sink.log_on_drop(false);
            handle.health.store(Arc::new(AudioHealth {
                device: name,
                error: None,
            }));
            Some(sink)
        }
        Err(err) => {
            handle.health.store(Arc::new(AudioHealth {
                device: name,
                error: Some(err.to_string()),
            }));
            None
        }
    }
}
