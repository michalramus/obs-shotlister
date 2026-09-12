//! Shotlister Cue Tray.
//!
//! Runs on the video switching computer. Connects to the main app's socket.io server over
//! the LAN and plays the same audio cues the operator window plays — the spoken countdown
//! and the beep at Shot expiry — so the switcher operator hears them too.
//!
//! Read-only: it never emits, and the main app needs no knowledge of it.

mod audio;
mod model;

use std::time::Duration;

fn main() {
    // A proper CLI arrives with the settings work; until then this is the only flag, and
    // it exists so audio can be verified by ear before any networking is involved.
    if std::env::args().any(|a| a == "--play-test") {
        play_test();
        return;
    }

    println!("shotlister-tray");
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
