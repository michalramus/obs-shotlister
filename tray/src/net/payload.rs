//! The wire shapes of the four events the main app pushes, and their translation into
//! [`Update`].
//!
//! Deliberately permissive about everything the Cue Tray does not use. `Shot` alone carries
//! eight fields on the wire and the countdown needs two of them; parsing the rest strictly
//! would turn an unrelated change in the main app into a tray that stops beeping.

use serde::Deserialize;

use crate::model::{Shot, Update};

/// `state:live`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LivePayload {
    #[serde(default)]
    pub live_index: Option<usize>,
    /// How long the Shot has been live. Not a timestamp — the switching computer does not
    /// share the operator's clock.
    #[serde(default)]
    pub elapsed_ms: Option<u64>,
}

/// `state:playback`.
#[derive(Debug, Deserialize)]
pub struct PlaybackPayload {
    pub running: bool,
}

/// `state:rundown`. The Rundown and Cameras are not modelled: the Cue Tray shows no
/// shotlist, so nothing outside `shots` can affect a cue.
#[derive(Debug, Deserialize)]
pub struct RundownPayload {
    #[serde(default)]
    pub shots: Vec<ShotPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotPayload {
    pub id: String,
    pub duration_ms: u64,
    /// Absent on a stored Shot; present once the Live queue has an opinion about it.
    #[serde(default)]
    pub hidden: bool,
}

/// `state:shot:hidden`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotHiddenPayload {
    pub shot_id: String,
}

/// Translates one event into an [`Update`], or `None` if the name is not one we act on.
///
/// Unknown events are ignored rather than logged as errors: the main app is free to grow
/// new ones, and a Cue Tray that complains about them would be noise on every show.
pub fn parse(event: &str, json: &serde_json::Value) -> Result<Option<Update>, serde_json::Error> {
    let update = match event {
        "state:live" => {
            let p: LivePayload = serde_json::from_value(json.clone())?;
            Update::Live {
                live_index: p.live_index,
                elapsed_ms: p.elapsed_ms,
            }
        }
        "state:playback" => {
            let p: PlaybackPayload = serde_json::from_value(json.clone())?;
            Update::Playback { running: p.running }
        }
        "state:rundown" => {
            let p: RundownPayload = serde_json::from_value(json.clone())?;
            Update::Rundown {
                shots: p
                    .shots
                    .into_iter()
                    .map(|s| Shot {
                        id: s.id,
                        duration_ms: s.duration_ms,
                        hidden: s.hidden,
                    })
                    .collect(),
            }
        }
        "state:shot:hidden" => {
            let p: ShotHiddenPayload = serde_json::from_value(json.clone())?;
            Update::ShotHidden { shot_id: p.shot_id }
        }
        _ => return Ok(None),
    };
    Ok(Some(update))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real payloads, captured from a server speaking the main app's protocol. Parsing
    /// them here is what catches drift between `src/shared/types.ts` and this module.
    fn fixture(name: &str) -> serde_json::Value {
        let raw = match name {
            "state-live" => include_str!("../../tests/fixtures/state-live.json"),
            "state-live-idle" => include_str!("../../tests/fixtures/state-live-idle.json"),
            "state-playback" => include_str!("../../tests/fixtures/state-playback.json"),
            "state-rundown" => include_str!("../../tests/fixtures/state-rundown.json"),
            "state-rundown-empty" => include_str!("../../tests/fixtures/state-rundown-empty.json"),
            "state-shot-hidden" => include_str!("../../tests/fixtures/state-shot-hidden.json"),
            other => panic!("no fixture {other}"),
        };
        serde_json::from_str(raw).expect("fixture is not valid JSON")
    }

    #[test]
    fn parses_a_live_position() {
        assert_eq!(
            parse("state:live", &fixture("state-live")).unwrap(),
            Some(Update::Live {
                live_index: Some(1),
                elapsed_ms: Some(2821),
            })
        );
    }

    #[test]
    fn parses_an_idle_live_position() {
        assert_eq!(
            parse("state:live", &fixture("state-live-idle")).unwrap(),
            Some(Update::Live {
                live_index: None,
                elapsed_ms: None,
            })
        );
    }

    #[test]
    fn parses_playback() {
        assert_eq!(
            parse("state:playback", &fixture("state-playback")).unwrap(),
            Some(Update::Playback { running: true })
        );
    }

    #[test]
    fn parses_a_shot_leaving_the_queue() {
        assert_eq!(
            parse("state:shot:hidden", &fixture("state-shot-hidden")).unwrap(),
            Some(Update::ShotHidden {
                shot_id: "s2".into()
            })
        );
    }

    /// Keeps only duration and hidden, and treats an absent `hidden` as visible — the
    /// shape a stored Shot arrives in before the Live queue has touched it.
    #[test]
    fn reduces_a_rundown_to_what_the_countdown_needs() {
        let Some(Update::Rundown { shots }) =
            parse("state:rundown", &fixture("state-rundown")).unwrap()
        else {
            panic!("expected a rundown")
        };

        assert_eq!(
            shots,
            vec![
                Shot {
                    id: "s1".into(),
                    duration_ms: 5000,
                    hidden: false
                },
                Shot {
                    id: "s2".into(),
                    duration_ms: 4000,
                    hidden: true
                },
                Shot {
                    id: "s3".into(),
                    duration_ms: 6000,
                    hidden: false
                },
            ]
        );
    }

    /// The main app sends this whenever no Rundown is loaded.
    #[test]
    fn parses_an_empty_rundown() {
        assert_eq!(
            parse("state:rundown", &fixture("state-rundown-empty")).unwrap(),
            Some(Update::Rundown { shots: vec![] })
        );
    }

    #[test]
    fn ignores_events_it_does_not_act_on() {
        assert_eq!(
            parse("state:something-new", &serde_json::json!({})).unwrap(),
            None
        );
    }

    /// A Shot without a duration is not something the countdown can guess at, so the
    /// event is refused rather than silently treated as zero.
    #[test]
    fn rejects_a_shot_missing_its_duration() {
        let json = serde_json::json!({ "shots": [{ "id": "s1" }] });
        assert!(parse("state:rundown", &json).is_err());
    }
}
