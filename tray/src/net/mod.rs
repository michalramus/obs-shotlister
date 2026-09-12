//! Talking to the main app.
//!
//! One socket.io connection, supervised on its own thread. The supervisor — not
//! `rust_socketio`'s built-in retry — is the single reconnection authority, so there is one
//! place that decides when to give up and rebuild, and changing the address at runtime is
//! the same code path as recovering from a dropped link rather than a special case.

pub mod payload;

use std::sync::Arc;
use std::time::Duration;

use arc_swap::ArcSwap;
use crossbeam_channel::{select, unbounded, Receiver, Sender};
use rust_socketio::client::ClientBuilder;
use rust_socketio::{Event, Payload, RawClient};

use crate::model::Update;

/// What the settings window and the tray tooltip show about the link.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum LinkState {
    #[default]
    Connecting,
    Connected,
    /// Not reachable. Carries the real error, because "disconnected" on its own does not
    /// distinguish a typo in the address from a firewall from a stopped main app.
    Failed(String),
}

#[derive(Debug, Clone, Default)]
pub struct LinkStatus {
    pub state: LinkState,
    pub address: String,
}

enum Cmd {
    SetAddress(String),
    Shutdown,
}

/// The socket's own lifecycle, reported by its callbacks back to the supervisor.
enum Lifecycle {
    Dead(String),
}

#[derive(Clone)]
pub struct NetHandle {
    cmd_tx: Sender<Cmd>,
    status: Arc<ArcSwap<LinkStatus>>,
}

impl NetHandle {
    /// Points the tray at a different main app. The current connection is torn down and
    /// rebuilt; no restart.
    pub fn set_address(&self, address: impl Into<String>) {
        let _ = self.cmd_tx.send(Cmd::SetAddress(address.into()));
    }

    pub fn shutdown(&self) {
        let _ = self.cmd_tx.send(Cmd::Shutdown);
    }

    pub fn status(&self) -> Arc<LinkStatus> {
        self.status.load_full()
    }
}

const BACKOFF_INITIAL: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(5);

/// Starts the supervisor. `updates` receives every translated event, plus
/// [`Update::LinkLost`] whenever the connection goes away.
pub fn spawn(address: String, updates: Sender<Update>) -> NetHandle {
    let (cmd_tx, cmd_rx) = unbounded();
    let handle = NetHandle {
        cmd_tx,
        status: Arc::new(ArcSwap::from_pointee(LinkStatus {
            state: LinkState::Connecting,
            address: address.clone(),
        })),
    };

    let worker = handle.clone();
    std::thread::Builder::new()
        .name("cue-net".into())
        .spawn(move || supervise(address, updates, cmd_rx, worker))
        .expect("spawning the network thread");

    handle
}

fn supervise(
    mut address: String,
    updates: Sender<Update>,
    cmd_rx: Receiver<Cmd>,
    handle: NetHandle,
) {
    let mut backoff = BACKOFF_INITIAL;

    loop {
        handle.publish(LinkState::Connecting, &address);

        let (life_tx, life_rx) = unbounded();
        let client = build(&address, &updates, &life_tx);

        let client = match client {
            Ok(client) => {
                backoff = BACKOFF_INITIAL;
                handle.publish(LinkState::Connected, &address);
                Some(client)
            }
            Err(err) => {
                handle.publish(LinkState::Failed(err), &address);
                None
            }
        };

        // Either wait for the live connection to die, or sit out the backoff before the
        // next attempt. A command interrupts both.
        let outcome = if client.is_some() {
            select! {
                recv(life_rx) -> reason => match reason {
                    Ok(Lifecycle::Dead(why)) => Outcome::Dropped(why),
                    Err(_) => Outcome::Dropped("connection closed".into()),
                },
                recv(cmd_rx) -> cmd => Outcome::from(cmd.ok()),
            }
        } else {
            select! {
                recv(cmd_rx) -> cmd => Outcome::from(cmd.ok()),
                default(backoff) => {
                    backoff = (backoff * 2).min(BACKOFF_MAX);
                    Outcome::Retry
                }
            }
        };

        if let Some(client) = client {
            let _ = client.disconnect();
        }
        // Whatever happens next, the session we were tracking is no longer trustworthy.
        let _ = updates.send(Update::LinkLost);

        match outcome {
            Outcome::Shutdown => return,
            Outcome::Retry => {}
            Outcome::Dropped(why) => {
                handle.publish(LinkState::Failed(why), &address);
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
            Outcome::Readdress(next) => {
                address = next;
                backoff = BACKOFF_INITIAL;
            }
        }
    }
}

enum Outcome {
    Shutdown,
    Retry,
    Dropped(String),
    Readdress(String),
}

impl From<Option<Cmd>> for Outcome {
    fn from(cmd: Option<Cmd>) -> Self {
        match cmd {
            Some(Cmd::SetAddress(address)) => Outcome::Readdress(address),
            // A dropped command channel means the rest of the program is gone.
            Some(Cmd::Shutdown) | None => Outcome::Shutdown,
        }
    }
}

impl NetHandle {
    fn publish(&self, state: LinkState, address: &str) {
        self.status.store(Arc::new(LinkStatus {
            state,
            address: address.to_string(),
        }));
    }
}

fn build(
    address: &str,
    updates: &Sender<Update>,
    life_tx: &Sender<Lifecycle>,
) -> Result<rust_socketio::client::Client, String> {
    let mut builder = ClientBuilder::new(address)
        // The supervisor owns reconnection; two retry loops would be impossible to reason
        // about, and only one of them can also handle an address change.
        .reconnect(false);

    for event in [
        "state:live",
        "state:playback",
        "state:rundown",
        "state:shot:hidden",
    ] {
        let updates = updates.clone();
        builder = builder.on(event, move |raw, _: RawClient| {
            // Callbacks run on the socket's own thread. Translate, hand off, return —
            // never touch audio or the UI from here.
            for value in values(raw) {
                match payload::parse(event, &value) {
                    Ok(Some(update)) => {
                        let _ = updates.send(update);
                    }
                    Ok(None) => {}
                    Err(err) => eprintln!("[net] {event}: {err}"),
                }
            }
        });
    }

    for (event, label) in [(Event::Close, "closed"), (Event::Error, "error")] {
        let life_tx = life_tx.clone();
        builder = builder.on(event, move |raw, _: RawClient| {
            let detail = values(raw)
                .first()
                .map(|v| v.to_string())
                .unwrap_or_default();
            let _ = life_tx.send(Lifecycle::Dead(if detail.is_empty() {
                label.to_string()
            } else {
                format!("{label}: {detail}")
            }));
        });
    }

    builder.connect().map_err(|err| err.to_string())
}

/// socket.io delivers an event's arguments as a list; ours always carry exactly one object,
/// but the shape is handled generally so a stray argument cannot panic a callback.
fn values(payload: Payload) -> Vec<serde_json::Value> {
    match payload {
        Payload::Text(values) => values,
        #[allow(deprecated)]
        Payload::String(text) => serde_json::from_str(&text).into_iter().collect(),
        Payload::Binary(_) => Vec::new(),
    }
}
