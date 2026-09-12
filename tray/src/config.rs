//! Where the Cue Tray keeps its settings, and how the command line overrides them.
//!
//! Command line beats file beats default, and a flag never rewrites the file: a service
//! unit started with `--volume 0.5` must not quietly overwrite what somebody chose in the
//! window.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const DEFAULT_PORT: u16 = 3000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Address of the machine running the main app.
    pub host: String,
    pub port: u16,
    /// 0.0 to 1.0.
    pub volume: f32,
    pub mute_count: bool,
    pub mute_beep: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            host: String::new(),
            port: DEFAULT_PORT,
            volume: 1.0,
            mute_count: false,
            mute_beep: false,
        }
    }
}

impl Settings {
    /// The URL to hand the socket.io client, or `None` until a host is known.
    pub fn address(&self) -> Option<String> {
        (!self.host.trim().is_empty()).then(|| format!("http://{}:{}", self.host.trim(), self.port))
    }

    /// Reads the settings, falling back to defaults for anything missing or unreadable.
    ///
    /// A corrupt config must not stop the tray starting — the window can still be used to
    /// put it right, and in headless mode the flags supply what is needed anyway.
    pub fn load(path: &Path) -> (Self, Option<String>) {
        match fs::read_to_string(path) {
            Ok(raw) => match serde_json::from_str::<Settings>(&raw) {
                Ok(settings) => (settings.sanitised(), None),
                Err(err) => (
                    Settings::default(),
                    Some(format!("{}: {err}", path.display())),
                ),
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => (Settings::default(), None),
            Err(err) => (
                Settings::default(),
                Some(format!("{}: {err}", path.display())),
            ),
        }
    }

    /// Writes via a temporary file and a rename, so a crash mid-write cannot leave a
    /// half-written config that fails to load next launch.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        fs::rename(&tmp, path)
    }

    fn sanitised(mut self) -> Self {
        self.volume = self.volume.clamp(0.0, 1.0);
        if self.port == 0 {
            self.port = DEFAULT_PORT;
        }
        self.host = normalise_host(&self.host);
        self
    }
}

/// Accepts what people actually type: a bare address, one with a port, or a pasted URL.
/// Returns just the host; any port found is the caller's to apply.
pub fn split_host_port(input: &str) -> (String, Option<u16>) {
    let trimmed = input
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/');

    // Only split on a colon that is really a port separator — a bare IPv6 address has
    // several, and none of them are.
    if let Some((host, port)) = trimmed.rsplit_once(':') {
        if !host.is_empty() && !host.contains(':') {
            if let Ok(port) = port.parse::<u16>() {
                return (host.to_string(), Some(port));
            }
        }
    }
    (trimmed.to_string(), None)
}

fn normalise_host(input: &str) -> String {
    split_host_port(input).0
}

/// `~/.config/shotlistertray/config.json` and its equivalents.
pub fn default_path() -> Option<PathBuf> {
    directories::ProjectDirs::from("dev", "shotlister", "ShotlisterTray")
        .map(|dirs| dirs.config_dir().join("config.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_needs_a_host() {
        let mut s = Settings::default();
        assert_eq!(s.address(), None);
        s.host = "192.168.1.20".into();
        assert_eq!(s.address().as_deref(), Some("http://192.168.1.20:3000"));
    }

    #[test]
    fn accepts_the_forms_people_actually_paste() {
        for input in [
            "192.168.1.20",
            " 192.168.1.20 ",
            "http://192.168.1.20",
            "http://192.168.1.20/",
        ] {
            assert_eq!(split_host_port(input), ("192.168.1.20".into(), None), "{input}");
        }
        assert_eq!(
            split_host_port("http://192.168.1.20:4000"),
            ("192.168.1.20".into(), Some(4000))
        );
        assert_eq!(
            split_host_port("shotlister.local:8080"),
            ("shotlister.local".into(), Some(8080))
        );
    }

    #[test]
    fn a_bare_ipv6_address_is_not_mistaken_for_a_port() {
        assert_eq!(split_host_port("fe80::1"), ("fe80::1".into(), None));
    }

    #[test]
    fn a_missing_config_is_not_an_error() {
        let (settings, problem) = Settings::load(Path::new("/nonexistent/shotlister/config.json"));
        assert_eq!(settings, Settings::default());
        assert!(problem.is_none());
    }

    #[test]
    fn a_corrupt_config_falls_back_rather_than_failing_to_start() {
        let path = std::env::temp_dir().join("shotlister-tray-corrupt.json");
        fs::write(&path, b"{ not json").unwrap();

        let (settings, problem) = Settings::load(&path);
        assert_eq!(settings, Settings::default());
        assert!(problem.is_some(), "the window should say what went wrong");

        fs::remove_file(&path).ok();
    }

    #[test]
    fn a_partial_config_keeps_the_defaults_for_the_rest() {
        let path = std::env::temp_dir().join("shotlister-tray-partial.json");
        fs::write(&path, br#"{"host":"10.0.0.5"}"#).unwrap();

        let (settings, problem) = Settings::load(&path);
        assert!(problem.is_none());
        assert_eq!(settings.host, "10.0.0.5");
        assert_eq!(settings.port, DEFAULT_PORT);
        assert_eq!(settings.volume, 1.0);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn round_trips_through_a_file() {
        let path = std::env::temp_dir().join("shotlister-tray-roundtrip.json");
        let settings = Settings {
            host: "10.0.0.5".into(),
            port: 4000,
            volume: 0.4,
            mute_count: true,
            mute_beep: false,
        };
        settings.save(&path).unwrap();

        let (loaded, problem) = Settings::load(&path);
        assert!(problem.is_none());
        assert_eq!(loaded, settings);

        fs::remove_file(&path).ok();
    }

    #[test]
    fn an_out_of_range_volume_is_clamped_on_load() {
        let path = std::env::temp_dir().join("shotlister-tray-volume.json");
        fs::write(&path, br#"{"volume":9.0,"port":0}"#).unwrap();

        let (settings, _) = Settings::load(&path);
        assert_eq!(settings.volume, 1.0);
        assert_eq!(settings.port, DEFAULT_PORT);

        fs::remove_file(&path).ok();
    }
}
