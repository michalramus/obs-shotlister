//! Tray icon for Windows and macOS.
//!
//! Both deliver tray and menu events through the same native run loop eframe is already
//! spinning, so the icon is created on the main thread during window setup and events come
//! back through global handlers. Nothing here owns application state: the handlers only
//! post a [`UiMsg`] and wake the loop.

use std::cell::RefCell;

use crossbeam_channel::Sender;
use eframe::egui;
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIconBuilder, TrayIconEvent};

use super::icon;
use crate::ui::UiMsg;

// The icon must outlive its creation or it vanishes from the tray. It is created on, and
// only ever touched from, the main thread, which is where eframe stays for the whole run.
thread_local! {
    static TRAY: RefCell<Option<tray_icon::TrayIcon>> = const { RefCell::new(None) };
}

/// Installs the tray icon. Returns `false` if the platform refused, in which case the
/// caller keeps the window on screen rather than leaving an unreachable process running.
pub fn install(to_ui: Sender<UiMsg>, ctx: egui::Context) -> bool {
    let menu = Menu::new();
    let settings = MenuItem::new("Settings…", true, None);
    let quit = MenuItem::new("Quit", true, None);
    let settings_id = settings.id().clone();
    let quit_id = quit.id().clone();

    if menu
        .append_items(&[&settings, &PredefinedMenuItem::separator(), &quit])
        .is_err()
    {
        return false;
    }

    let Ok(image) = Icon::from_rgba(icon::rgba(false), icon::SIZE, icon::SIZE) else {
        return false;
    };

    let tray = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_icon(image)
        .with_tooltip("Shotlister Cue Tray")
        // macOS tints a template image to match the menu bar, light or dark.
        .with_icon_as_template(cfg!(target_os = "macos"))
        // Left click should open the window; the menu stays on the right button.
        .with_menu_on_left_click(false)
        .build();

    let Ok(tray) = tray else { return false };
    TRAY.with(|slot| *slot.borrow_mut() = Some(tray));

    {
        let to_ui = to_ui.clone();
        let ctx = ctx.clone();
        MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
            let msg = if event.id == settings_id {
                UiMsg::Show
            } else if event.id == quit_id {
                UiMsg::Quit
            } else {
                return;
            };
            let _ = to_ui.send(msg);
            // The window may be hidden, in which case nothing else would run a pass.
            ctx.request_repaint();
        }));
    }

    TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
        if let TrayIconEvent::Click {
            button: tray_icon::MouseButton::Left,
            button_state: tray_icon::MouseButtonState::Up,
            ..
        } = event
        {
            let _ = to_ui.send(UiMsg::Show);
            ctx.request_repaint();
        }
    }));

    true
}

/// Reflects the link state in the icon and its tooltip, so a dead link is visible without
/// opening anything.
pub fn set_connected(connected: bool, detail: &str) {
    TRAY.with(|slot| {
        let slot = slot.borrow();
        let Some(tray) = slot.as_ref() else { return };
        if let Ok(image) = Icon::from_rgba(icon::rgba(connected), icon::SIZE, icon::SIZE) {
            let _ = tray.set_icon(Some(image));
        }
        let _ = tray.set_tooltip(Some(detail));
    });
}
