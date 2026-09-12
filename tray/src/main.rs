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
mod tray;
mod ui;

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

    if cli.headless {
        headless(&settings, cli.verbose);
        return;
    }

    if let Err(err) = windowed(settings, path, cli.settings) {
        eprintln!("[ui] {err}");
        std::process::exit(1);
    }
}

/// Runs with the tray icon and the settings window.
fn windowed(
    settings: Settings,
    config_path: Option<std::path::PathBuf>,
    force_settings: bool,
) -> eframe::Result {
    let audio = audio::spawn(settings.volume);
    let session = session::spawn(
        audio.clone(),
        Mutes {
            count: settings.mute_count,
            beep: settings.mute_beep,
        },
    );
    // Without a host the supervisor has nothing to attempt; the window is how one is
    // supplied, and Apply starts it.
    let net = net::spawn(settings.address().unwrap_or_default(), session.updates());

    let (to_ui, from_tray) = crossbeam_channel::unbounded();

    // Nothing has been configured yet, so there is nothing for the tray to be quietly
    // doing in the background — put the window in front of the person who just launched it.
    let needs_setup = settings.address().is_none();

    // The tray cannot be installed before the event loop exists, and whether it installed
    // decides two things the window needs to know, so it is set up from the creation
    // callback and reported back through a channel.
    let (installed_tx, installed_rx) = crossbeam_channel::bounded(1);
    let mut wiring = ui::Wiring {
        settings,
        config_path,
        audio: audio.clone(),
        session: session.clone(),
        net: net.clone(),
        from_tray,
        // Both overwritten from the channel below, before the first pass runs.
        hide_on_close: true,
        start_visible: true,
        installed: Some(installed_rx),
    };
    wiring.start_visible = force_settings || needs_setup;

    ui::run(wiring, move |ctx| {
        let has_tray = tray::install(to_ui, ctx.clone());
        if !has_tray {
            // Without an icon there is no way back to a hidden window and no way to quit,
            // so the window has to stay in charge of its own lifetime.
            ctx.send_viewport_cmd(eframe::egui::ViewportCommand::Visible(true));
        }
        let _ = installed_tx.send(has_tray);

        // Keep the icon honest about the link without the window being open.
        std::thread::Builder::new()
            .name("cue-tray-status".into())
            .spawn(move || {
                let mut last = None;
                loop {
                    std::thread::sleep(Duration::from_millis(500));
                    let link = net.status();
                    let live = session.status();
                    let connected = matches!(link.state, LinkState::Connected);
                    let detail = match &link.state {
                        LinkState::Connected if live.running => {
                            format!("Running — {}", link.address)
                        }
                        LinkState::Connected => format!("Connected — {}", link.address),
                        LinkState::Connecting => format!("Connecting to {}", link.address),
                        LinkState::Failed(err) => format!("Not connected — {err}"),
                    };

                    let next = Some((connected, detail.clone()));
                    if next != last {
                        tray::set_connected(connected, &detail);
                        last = next;
                    }
                }
            })
            .expect("spawning the tray status thread");
    })
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
