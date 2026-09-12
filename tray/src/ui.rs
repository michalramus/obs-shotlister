//! The settings window.
//!
//! One window for the process lifetime, created hidden and toggled from the tray rather
//! than built and destroyed per click — tearing an eframe window down and back up churns
//! a lot of platform state, and on macOS the run loop has to stay alive for the menu bar
//! item anyway.
//!
//! Beyond the four settings, the window exists to make a problem diagnosable without
//! leaving the switching machine: which device is playing, what the link is actually doing,
//! and a button that makes a noise.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use eframe::egui;

use crate::audio::{AudioHandle, Cue};
use crate::config::{self, Settings};
use crate::engine::Mutes;
use crate::net::{LinkState, NetHandle};
use crate::session::SessionHandle;

/// Sent from the tray thread, which owns no state of its own.
///
/// Deliberately only two: the tray menu shows the window and quits, and every setting lives
/// in the window. A checkable "Mute beep" in the menu would have to be kept in step with
/// the window, and a mute toggle that shows the wrong state during a show is worse than one
/// extra click.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiMsg {
    Show,
    Quit,
}

/// Long enough that dragging the volume slider writes once, short enough that the config
/// is on disk well before anyone closes the lid.
const SAVE_DEBOUNCE: Duration = Duration::from_millis(500);

pub struct Wiring {
    pub settings: Settings,
    pub config_path: Option<PathBuf>,
    pub audio: AudioHandle,
    pub session: SessionHandle,
    pub net: NetHandle,
    pub from_tray: Receiver<UiMsg>,
    /// False when no tray icon was installed: without one, closing the window has to quit,
    /// or the program becomes unreachable and unkillable from the desktop.
    pub hide_on_close: bool,
    pub start_visible: bool,
    /// Carries whether the tray installed. The answer is only known once the event loop is
    /// up, which is after this struct is built.
    pub installed: Option<Receiver<bool>>,
}

/// Runs the window. `on_ctx` is handed the egui context once it exists: the tray needs it
/// to wake the event loop, because while the window is hidden eframe runs no pass at all
/// and a tray click would otherwise sit unread until something else caused a repaint.
pub fn run(wiring: Wiring, on_ctx: impl FnOnce(egui::Context) + Send + 'static) -> eframe::Result {
    let start_visible = wiring.start_visible;
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Shotlister Cue Tray")
            .with_inner_size([380.0, 460.0])
            .with_min_inner_size([340.0, 380.0])
            .with_visible(start_visible),
        ..Default::default()
    };

    eframe::run_native(
        "Shotlister Cue Tray",
        options,
        Box::new(move |cc| {
            on_ctx(cc.egui_ctx.clone());
            Ok(Box::new(App::new(wiring)))
        }),
    )
}

struct App {
    wiring: Wiring,
    /// The address fields are edited freely and only applied on the button: reconnecting on
    /// every keystroke would tear the socket down once per character typed.
    host_field: String,
    port_field: String,
    visible: bool,
    dirty_since: Option<Instant>,
    save_error: Option<String>,
}

impl App {
    fn new(wiring: Wiring) -> Self {
        let host_field = wiring.settings.host.clone();
        let port_field = wiring.settings.port.to_string();
        let visible = wiring.start_visible;
        App {
            wiring,
            host_field,
            port_field,
            visible,
            dirty_since: None,
            save_error: None,
        }
    }

    /// Marks the settings dirty and schedules the pass that will flush them. The repaint
    /// matters even when hidden: nothing else would wake the loop to write the file.
    fn touched(&mut self, ctx: &egui::Context) {
        self.dirty_since = Some(Instant::now());
        ctx.request_repaint_after(SAVE_DEBOUNCE + Duration::from_millis(50));
    }

    fn save_if_settled(&mut self) {
        let Some(since) = self.dirty_since else { return };
        if since.elapsed() < SAVE_DEBOUNCE {
            return;
        }
        self.dirty_since = None;

        let Some(path) = &self.wiring.config_path else {
            return;
        };
        self.save_error = self.wiring.settings.save(path).err().map(|e| e.to_string());
    }

    fn apply_address(&mut self, ctx: &egui::Context) {
        let (host, port) = config::split_host_port(&self.host_field);
        self.wiring.settings.host = host.clone();
        self.host_field = host;

        if let Some(port) = port.or_else(|| self.port_field.trim().parse().ok()) {
            self.wiring.settings.port = port;
        }
        self.port_field = self.wiring.settings.port.to_string();

        if let Some(address) = self.wiring.settings.address() {
            self.wiring.net.set_address(address);
        }
        self.touched(ctx);
    }

    fn set_visible(&mut self, ctx: &egui::Context, visible: bool) {
        self.visible = visible;
        ctx.send_viewport_cmd(egui::ViewportCommand::Visible(visible));
        if visible {
            ctx.send_viewport_cmd(egui::ViewportCommand::Focus);
        }
    }

    fn handle_tray(&mut self, ctx: &egui::Context) -> bool {
        while let Ok(msg) = self.wiring.from_tray.try_recv() {
            match msg {
                UiMsg::Show => self.set_visible(ctx, true),
                UiMsg::Quit => return true,
            }
        }
        false
    }

    fn push_mutes(&mut self, ctx: &egui::Context) {
        self.wiring.session.set_mutes(Mutes {
            count: self.wiring.settings.mute_count,
            beep: self.wiring.settings.mute_beep,
        });
        self.touched(ctx);
    }

    fn quit(&self, ctx: &egui::Context) {
        if let Some(path) = &self.wiring.config_path {
            let _ = self.wiring.settings.save(path);
        }
        self.wiring.net.shutdown();
        self.wiring.session.shutdown();
        self.wiring.audio.shutdown();
        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
    }
}

impl eframe::App for App {
    /// Runs even while the window is hidden, which is what lets a tray click reopen it and
    /// a pending save reach disk with nothing on screen.
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if let Some(installed) = &self.wiring.installed {
            if let Ok(has_tray) = installed.try_recv() {
                self.wiring.hide_on_close = has_tray;
                if !has_tray {
                    self.visible = true;
                }
                self.wiring.installed = None;
            }
        }

        if self.handle_tray(ctx) {
            self.quit(ctx);
            return;
        }
        self.save_if_settled();

        if ctx.input(|i| i.viewport().close_requested()) {
            if self.wiring.hide_on_close {
                // Closing the window is how people put a tray app away; quitting is the
                // tray menu's job, and doing it here would silence a live show by accident.
                ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
                self.set_visible(ctx, false);
            } else {
                self.quit(ctx);
                return;
            }
        }

        if self.visible {
            // Only while on screen: a hidden window that repaints is a laptop fan.
            ctx.request_repaint_after(Duration::from_millis(200));
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        egui::Frame::central_panel(ui.style()).show(ui, |ui| self.body(ui));
    }
}

impl App {
    fn body(&mut self, ui: &mut egui::Ui) {
        ui.add_space(4.0);
        self.status_section(ui);
        ui.add_space(12.0);
        ui.separator();
        ui.add_space(8.0);

        ui.label(egui::RichText::new("Main app").strong());
        egui::Grid::new("address")
            .num_columns(2)
            .spacing([8.0, 6.0])
            .show(ui, |ui| {
                ui.label("Address");
                ui.text_edit_singleline(&mut self.host_field);
                ui.end_row();

                ui.label("Port");
                ui.add(egui::TextEdit::singleline(&mut self.port_field).desired_width(70.0));
                ui.end_row();
            });

        ui.add_space(6.0);
        if ui.button("Apply").clicked() {
            let ctx = ui.ctx().clone();
            self.apply_address(&ctx);
        }

        ui.add_space(14.0);
        ui.separator();
        ui.add_space(8.0);

        ui.label(egui::RichText::new("Sound").strong());
        let mut volume = self.wiring.settings.volume;
        if ui
            .add(egui::Slider::new(&mut volume, 0.0..=1.0).text("Volume"))
            .changed()
        {
            self.wiring.settings.volume = volume;
            self.wiring.audio.set_volume(volume);
            let ctx = ui.ctx().clone();
            self.touched(&ctx);
        }

        let mut count = self.wiring.settings.mute_count;
        if ui.checkbox(&mut count, "Mute countdown").changed() {
            self.wiring.settings.mute_count = count;
            let ctx = ui.ctx().clone();
            self.push_mutes(&ctx);
        }
        let mut beep = self.wiring.settings.mute_beep;
        if ui.checkbox(&mut beep, "Mute beep").changed() {
            self.wiring.settings.mute_beep = beep;
            let ctx = ui.ctx().clone();
            self.push_mutes(&ctx);
        }

        ui.add_space(6.0);
        if ui.button("Test sound").clicked() {
            self.wiring.audio.play(Cue::Beep);
        }

        let health = self.wiring.audio.health();
        ui.add_space(4.0);
        match (&health.device, &health.error) {
            (Some(device), None) => ui.weak(format!("Output: {device}")),
            (_, Some(err)) => ui.colored_label(WARN, format!("Audio: {err}")),
            (None, None) => ui.weak("Output: not opened yet"),
        };

        if let Some(err) = &self.save_error {
            ui.add_space(6.0);
            ui.colored_label(WARN, format!("Could not save settings: {err}"));
        }
    }

    fn status_section(&mut self, ui: &mut egui::Ui) {
        let link = self.wiring.net.status();
        let live = self.wiring.session.status();

        let (colour, text) = match &link.state {
            LinkState::Connected => (OK, format!("Connected to {}", link.address)),
            LinkState::Connecting => (WARN, format!("Connecting to {}…", link.address)),
            LinkState::Failed(err) => (BAD, format!("Not connected — {err}")),
        };
        ui.horizontal(|ui| {
            ui.label(egui::RichText::new("●").color(colour));
            ui.label(text);
        });

        ui.add_space(6.0);
        // The Live position, so "the link is fine but nothing is running" is instantly
        // distinguishable from "the link is dead".
        let detail = match (&link.state, live.running, live.live_index, live.remaining_ms) {
            (LinkState::Connected, true, Some(index), Some(remaining)) => format!(
                "Shot {} of {} — {:.1}s left",
                index + 1,
                live.shot_count,
                remaining as f64 / 1000.0
            ),
            (LinkState::Connected, true, Some(index), None) => {
                format!("Shot {} of {} live", index + 1, live.shot_count)
            }
            (LinkState::Connected, _, _, _) => "No Live session running".to_string(),
            _ => "—".to_string(),
        };
        ui.weak(detail);
    }
}

const OK: egui::Color32 = egui::Color32::from_rgb(0x3f, 0xb9, 0x50);
const WARN: egui::Color32 = egui::Color32::from_rgb(0xd2, 0x9a, 0x2a);
const BAD: egui::Color32 = egui::Color32::from_rgb(0xd9, 0x53, 0x4f);
