//! Tray icon for Linux, via StatusNotifierItem.
//!
//! `ksni` talks the D-Bus protocol directly from its own thread, with no GUI toolkit — the
//! alternative, GTK, wants the main thread that winit already has. SNI is what Cinnamon
//! (so Linux Mint), KDE, Xfce and GNOME's AppIndicator extension implement.
//!
//! Stock GNOME Shell has no SNI host at all, so the item is simply never shown. `install`
//! reports that, and the caller keeps the window on screen rather than leaving a process
//! the user can neither see nor quit.

use std::sync::Mutex;
use std::sync::OnceLock;

use crossbeam_channel::Sender;
use eframe::egui;
use ksni::blocking::{Handle, TrayMethods};
use ksni::menu::StandardItem;
use ksni::{Icon, MenuItem, ToolTip};

use super::icon;
use crate::ui::UiMsg;

struct CueTray {
    to_ui: Sender<UiMsg>,
    ctx: egui::Context,
    connected: bool,
    detail: String,
}

impl CueTray {
    fn post(&self, msg: UiMsg) {
        let _ = self.to_ui.send(msg);
        // The window may be hidden, in which case nothing else would run an egui pass.
        self.ctx.request_repaint();
    }
}

impl ksni::Tray for CueTray {
    fn id(&self) -> String {
        "dev.shotlister.ShotlisterTray".into()
    }

    fn title(&self) -> String {
        "Shotlister Cue Tray".into()
    }

    /// Left click opens the window, which is the whole interface.
    fn activate(&mut self, _x: i32, _y: i32) {
        self.post(UiMsg::Show);
    }

    fn icon_pixmap(&self) -> Vec<Icon> {
        vec![Icon {
            width: icon::SIZE as i32,
            height: icon::SIZE as i32,
            data: icon::argb(self.connected),
        }]
    }

    fn tool_tip(&self) -> ToolTip {
        ToolTip {
            title: "Shotlister Cue Tray".into(),
            description: self.detail.clone(),
            ..Default::default()
        }
    }

    fn menu(&self) -> Vec<MenuItem<Self>> {
        vec![
            StandardItem {
                label: "Settings…".into(),
                activate: Box::new(|tray: &mut Self| tray.post(UiMsg::Show)),
                ..Default::default()
            }
            .into(),
            MenuItem::Separator,
            StandardItem {
                label: "Quit".into(),
                activate: Box::new(|tray: &mut Self| tray.post(UiMsg::Quit)),
                ..Default::default()
            }
            .into(),
        ]
    }
}

static HANDLE: OnceLock<Mutex<Option<Handle<CueTray>>>> = OnceLock::new();

/// Installs the tray item. Returns `false` when no StatusNotifierItem host answered.
pub fn install(to_ui: Sender<UiMsg>, ctx: egui::Context) -> bool {
    let tray = CueTray {
        to_ui,
        ctx,
        connected: false,
        detail: "Starting…".into(),
    };

    match tray.spawn() {
        Ok(handle) => {
            let _ = HANDLE.set(Mutex::new(Some(handle)));
            true
        }
        Err(err) => {
            eprintln!(
                "[tray] no system tray available ({err}). \
                 On GNOME this needs the AppIndicator extension; showing the window instead."
            );
            false
        }
    }
}

/// Reflects the link state in the icon and its tooltip.
pub fn set_connected(connected: bool, detail: &str) {
    let Some(slot) = HANDLE.get() else { return };
    let Ok(slot) = slot.lock() else { return };
    let Some(handle) = slot.as_ref() else { return };

    handle.update(|tray: &mut CueTray| {
        tray.connected = connected;
        tray.detail = detail.to_string();
    });
}
