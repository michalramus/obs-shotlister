//! Shotlister Cue Tray.
//!
//! Runs on the video switching computer. Connects to the main app's socket.io server over
//! the LAN and plays the same audio cues the operator window plays — the spoken countdown
//! and the beep at Shot expiry — so the switcher operator hears them too.
//!
//! Read-only: it never emits, and the main app needs no knowledge of it.

mod audio;
mod engine;
mod model;
mod net;
mod session;

use std::time::Duration;

use engine::Mutes;
use net::LinkState;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // A proper CLI arrives with the settings work; these two flags exist so the pieces
    // can be exercised as they land.
    if args.iter().any(|a| a == "--play-test") {
        play_test();
        return;
    }

    let Some(address) = args.first() else {
        eprintln!("usage: shotlister-tray <http://host:3000>");
        eprintln!("       shotlister-tray --play-test");
        std::process::exit(2);
    };

    run(address);
}

fn run(address: &str) {
    let audio = audio::spawn(1.0);
    let session = session::spawn(audio.clone(), Mutes::default());
    let net = net::spawn(address.to_string(), session.updates());

    println!("connecting to {address} — ctrl-c to stop");

    // Until the window exists, report the link and the Live position as they change so the
    // thing is observable while it runs.
    let mut last = String::new();
    loop {
        std::thread::sleep(Duration::from_millis(250));

        let link = net.status();
        let live = session.status();
        let line = match &link.state {
            LinkState::Connecting => "connecting…".to_string(),
            LinkState::Failed(err) => format!("disconnected: {err}"),
            LinkState::Connected => match (live.running, live.live_index, live.remaining_ms) {
                (true, Some(index), Some(remaining)) => format!(
                    "connected — shot {}/{}, {:.1}s left",
                    index + 1,
                    live.shot_count,
                    remaining as f64 / 1000.0
                ),
                (true, _, _) => "connected — running".to_string(),
                _ => "connected — stopped".to_string(),
            },
        };

        if line != last {
            println!("{line}");
            last = line;
        }
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
