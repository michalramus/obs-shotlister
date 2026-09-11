//! Shotlister Cue Tray.
//!
//! Runs on the video switching computer. Connects to the main app's socket.io server over
//! the LAN and plays the same audio cues the operator window plays — the spoken countdown
//! and the beep at Shot expiry — so the switcher operator hears them too.
//!
//! Read-only: it never emits, and the main app needs no knowledge of it.

fn main() {
    println!("shotlister-tray");
}
