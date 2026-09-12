//! The tray icon.
//!
//! Two backends with one interface. The tray owns no application state: it posts [`UiMsg`]
//! and is told what to display.

pub mod icon;

#[cfg(not(target_os = "linux"))]
mod native;
#[cfg(not(target_os = "linux"))]
pub use native::{install, set_connected};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{install, set_connected};
