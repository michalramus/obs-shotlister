//! The command line.
//!
//! Every setting the window offers is also a flag, so the tray can run as a service on a
//! dedicated switching machine with no GUI and no config file. Flags are one-shot
//! overrides: they never rewrite what is on disk.

use std::path::PathBuf;

use clap::Parser;

use crate::config::{self, Settings};

#[derive(Debug, Parser)]
#[command(
    name = "shotlister-tray",
    about = "Plays a shotlister Live session's audio cues on the video switching computer"
)]
pub struct Cli {
    /// Run without a window or tray icon. Logs link and cue state to stdout.
    #[arg(long)]
    pub headless: bool,

    /// Open the settings window at startup. Useful where no system tray is available.
    #[arg(long)]
    pub settings: bool,

    /// Address of the machine running the main app. Accepts `10.0.0.5`, `10.0.0.5:3000`
    /// or a pasted `http://10.0.0.5:3000`.
    #[arg(long, value_name = "HOST")]
    pub host: Option<String>,

    /// Port the main app's server listens on.
    #[arg(long, value_name = "PORT")]
    pub port: Option<u16>,

    /// Playback volume, 0.0 to 1.0.
    #[arg(long, value_name = "LEVEL")]
    pub volume: Option<f32>,

    /// Start with the spoken countdown muted.
    #[arg(long)]
    pub mute_count: bool,

    /// Start with the expiry beep muted.
    #[arg(long)]
    pub mute_beep: bool,

    /// Play every cue once and exit. Verifies audio without a network.
    #[arg(long)]
    pub play_test: bool,

    /// Use this config file instead of the default location.
    #[arg(long, value_name = "PATH")]
    pub config: Option<PathBuf>,

    /// Log every state event as it arrives.
    #[arg(short, long)]
    pub verbose: bool,
}

impl Cli {
    pub fn config_path(&self) -> Option<PathBuf> {
        self.config.clone().or_else(config::default_path)
    }

    /// Lays the flags over the stored settings. A `--host` carrying its own port supplies
    /// the port too, unless `--port` said otherwise.
    pub fn overlay(&self, mut settings: Settings) -> Settings {
        if let Some(host) = &self.host {
            let (host, port) = config::split_host_port(host);
            settings.host = host;
            if let Some(port) = port {
                settings.port = port;
            }
        }
        if let Some(port) = self.port {
            settings.port = port;
        }
        if let Some(volume) = self.volume {
            settings.volume = volume.clamp(0.0, 1.0);
        }
        // Mute flags only ever turn muting on: a saved mute is not something a bare
        // service invocation should silently undo.
        settings.mute_count |= self.mute_count;
        settings.mute_beep |= self.mute_beep;
        settings
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Cli {
        Cli::parse_from(std::iter::once("shotlister-tray").chain(args.iter().copied()))
    }

    #[test]
    fn flags_override_the_stored_settings() {
        let stored = Settings {
            host: "10.0.0.5".into(),
            port: 3000,
            volume: 1.0,
            mute_count: false,
            mute_beep: false,
        };
        let cli = parse(&["--host", "192.168.1.20", "--volume", "0.25", "--mute-beep"]);
        let merged = cli.overlay(stored);

        assert_eq!(merged.host, "192.168.1.20");
        assert_eq!(merged.port, 3000);
        assert_eq!(merged.volume, 0.25);
        assert!(merged.mute_beep);
        assert!(!merged.mute_count);
    }

    #[test]
    fn a_host_carrying_a_port_supplies_both() {
        let cli = parse(&["--host", "http://10.0.0.5:4000"]);
        let merged = cli.overlay(Settings::default());

        assert_eq!(merged.host, "10.0.0.5");
        assert_eq!(merged.port, 4000);
    }

    #[test]
    fn an_explicit_port_wins_over_one_inside_the_host() {
        let cli = parse(&["--host", "10.0.0.5:4000", "--port", "5000"]);
        assert_eq!(cli.overlay(Settings::default()).port, 5000);
    }

    #[test]
    fn nothing_on_the_command_line_leaves_the_settings_alone() {
        let stored = Settings {
            host: "10.0.0.5".into(),
            port: 4000,
            volume: 0.3,
            mute_count: true,
            mute_beep: true,
        };
        assert_eq!(parse(&[]).overlay(stored.clone()), stored);
    }

    #[test]
    fn a_mute_flag_never_unmutes() {
        let stored = Settings {
            mute_count: true,
            ..Settings::default()
        };
        assert!(parse(&[]).overlay(stored).mute_count);
    }

    #[test]
    fn an_absurd_volume_is_clamped() {
        assert_eq!(
            parse(&["--volume", "42"]).overlay(Settings::default()).volume,
            1.0
        );
    }
}
