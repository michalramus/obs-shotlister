//! Compatibility probe: does rust_socketio's sync client talk to the main app's
//! socket.io 4.8.3 server, and do the four state events arrive in a shape we can parse?
//!
//! Kept as an example rather than deleted so it stays runnable as a field diagnostic:
//!
//!     cargo run --example spike -- http://192.168.1.20:3000

use std::env;
use std::sync::mpsc;
use std::time::Duration;

use rust_socketio::{client::ClientBuilder, Event, Payload, RawClient};

fn main() {
    let url = env::args()
        .nth(1)
        .unwrap_or_else(|| "http://127.0.0.1:3999".to_string());
    println!("connecting to {url}");

    let (tx, rx) = mpsc::channel::<String>();

    let log = move |name: &'static str, tx: mpsc::Sender<String>| {
        move |payload: Payload, _: RawClient| {
            let rendered = match payload {
                Payload::Text(values) => values
                    .iter()
                    .map(|v| v.to_string())
                    .collect::<Vec<_>>()
                    .join(", "),
                Payload::Binary(bytes) => format!("<{} binary bytes>", bytes.len()),
                #[allow(deprecated)]
                Payload::String(s) => s,
            };
            let _ = tx.send(format!("{name}: {rendered}"));
        }
    };

    let client = ClientBuilder::new(&url)
        .on("state:live", log("state:live", tx.clone()))
        .on("state:playback", log("state:playback", tx.clone()))
        .on("state:rundown", log("state:rundown", tx.clone()))
        .on("state:shot:hidden", log("state:shot:hidden", tx.clone()))
        .on(Event::Connect, {
            let tx = tx.clone();
            move |_, _| {
                let _ = tx.send("-- connected --".to_string());
            }
        })
        .on(Event::Close, {
            let tx = tx.clone();
            move |_, _| {
                let _ = tx.send("-- closed --".to_string());
            }
        })
        .on(Event::Error, {
            let tx = tx.clone();
            move |err, _| {
                let _ = tx.send(format!("-- error: {err:?} --"));
            }
        })
        .connect()
        .expect("connect failed");

    // Print whatever arrives for 20s, then leave.
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(line) => println!("{line}"),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let _ = client.disconnect();
    println!("done");
}
