//! Shotlister Cue Tray.
//!
//! Runs on the video switching computer. Connects to the main app's socket.io server over
//! the LAN and plays the same audio cues the operator window plays — the spoken countdown
//! and the beep at Shot expiry — so the switcher operator hears them too.
//!
//! Read-only: it never emits, and the main app needs no knowledge of it.

mod audio;
mod cli;
mod config;
mod engine;
mod model;
mod net;
mod session;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use clap::Parser;

use cli::Cli;
use config::Settings;
use engine::Mutes;
use net::LinkState;

fn main() {
    let cli = Cli::parse();

    if cli.play_test {
        play_test();
        return;
    }

    let path = cli.config_path();
    let (stored, problem) = match &path {
        Some(path) => Settings::load(path),
        None => (Settings::default(), None),
    };
    if let Some(problem) = problem {
        eprintln!("[config] {problem} — falling back to defaults");
    }
    let settings = cli.overlay(stored);

    // The window is not built yet, so every run is headless for now.
    let _ = cli.settings;
    headless(&settings, cli.verbose);
}

/// Runs with no window and no tray: connect, play cues, log state changes. This is the
/// mode a service unit on a dedicated switching machine uses.
fn headless(settings: &Settings, verbose: bool) {
    let Some(address) = settings.address() else {
        eprintln!("no host configured — pass --host <address>");
        std::process::exit(2);
    };

    let audio = audio::spawn(settings.volume);
    let session = session::spawn(
        audio.clone(),
        Mutes {
            count: settings.mute_count,
            beep: settings.mute_beep,
        },
    );
    let net = net::spawn(address.clone(), session.updates());

    println!("cue tray — {address}");
    if settings.mute_count || settings.mute_beep {
        println!(
            "muted: {}{}{}",
            if settings.mute_count { "count" } else { "" },
            if settings.mute_count && settings.mute_beep {
                " and "
            } else {
                ""
            },
            if settings.mute_beep { "beep" } else { "" },
        );
    }

    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        // Includes SIGTERM, so `systemctl stop` exits cleanly rather than being killed.
        if let Err(err) = ctrlc::set_handler(move || stop.store(true, Ordering::Relaxed)) {
            eprintln!("[signals] {err} — ctrl-c will not shut down cleanly");
        }
    }

    let mut last = String::new();
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(250));

        let line = describe(&net, &session, verbose);
        if line != last {
            println!("{line}");
            last = line;
        }
    }

    println!("stopping");
    net.shutdown();
    session.shutdown();
    audio.shutdown();
}

/// One line of state, printed only when it changes so a quiet show stays quiet in the log.
fn describe(net: &net::NetHandle, session: &session::SessionHandle, verbose: bool) -> String {
    let link = net.status();
    let live = session.status();

    match &link.state {
        LinkState::Connecting => format!("connecting to {}", link.address),
        LinkState::Failed(err) => format!("disconnected: {err}"),
        LinkState::Connected if !live.running => "connected — session stopped".to_string(),
        LinkState::Connected => match (live.live_index, live.remaining_ms) {
            (Some(index), Some(remaining)) if verbose => format!(
                "shot {}/{} — {:.1}s left",
                index + 1,
                live.shot_count,
                remaining as f64 / 1000.0
            ),
            (Some(index), _) => format!("shot {}/{} live", index + 1, live.shot_count),
            _ => "connected — running".to_string(),
        },
    }
}

/// Plays every cue in countdown order, then the beep and "one" together, which is what the
/// expiry tick actually does — if the mixer were serialising them it would be audible here.
fn play_test() {
    let player = audio::spawn(1.0);

    for cue in audio::cues::ALL {
        println!("playing {cue:?}");
        player.play(cue);
        std::thread::sleep(Duration::from_millis(900));
    }

    println!("playing Word(1) and Beep together");
    player.play(audio::Cue::Word(1));
    player.play(audio::Cue::Beep);
    std::thread::sleep(Duration::from_millis(1200));

    let health = player.health();
    match (&health.device, &health.error) {
        (Some(device), None) => println!("output device: {device}"),
        (_, Some(err)) => println!("audio error: {err}"),
        (None, None) => println!("no audio device opened"),
    }

    player.shutdown();
}
