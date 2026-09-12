//! The Live session as the Cue Tray sees it, and the timing rules it needs.
//!
//! A direct port of `effectiveDurationMs` / `computeRemainingMs` from
//! `src/shared/timing.ts`. Pure: no sockets, no audio, no clock of its own — time is
//! passed in as monotonic milliseconds so the engine's tests can drive it.
//!
//! Only what the countdown needs is modelled. Cameras, labels, transitions and the Rundown
//! itself are all deserialised and dropped: the Cue Tray shows no shotlist, so the only
//! facts that matter are how long each Shot runs and whether it has left the Live queue.

/// One Shot's turn on air, reduced to what the countdown depends on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shot {
    pub id: String,
    pub duration_ms: u64,
    /// The Shot has left the Live queue — already on air, or skipped.
    pub hidden: bool,
}

/// A change arriving from the main app, already translated off the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Update {
    /// `state:live`. `elapsed_ms` is how long the Shot has been live, not a timestamp:
    /// the switching computer does not share the operator's clock.
    Live {
        live_index: Option<usize>,
        elapsed_ms: Option<u64>,
    },
    /// `state:playback`.
    Playback { running: bool },
    /// `state:rundown`. Only the Shots survive the translation.
    Rundown { shots: Vec<Shot> },
    /// `state:shot:hidden`.
    ShotHidden { shot_id: String },
    /// The socket went away. Not a server event — the supervisor's own signal.
    LinkLost,
}

#[derive(Debug, Default, Clone)]
pub struct LiveModel {
    pub shots: Vec<Shot>,
    pub live_index: Option<usize>,
    /// Monotonic millisecond at which the live Shot went on air, anchored locally.
    pub anchor: Option<u64>,
    pub running: bool,
}

impl LiveModel {
    pub fn apply(&mut self, update: Update, now_ms: u64) {
        match update {
            Update::Live {
                live_index,
                elapsed_ms,
            } => {
                self.live_index = live_index;
                // `startedAtFromElapsed` in src/shared/live-view.ts, against our clock.
                self.anchor = elapsed_ms.map(|elapsed| now_ms.saturating_sub(elapsed));
            }
            Update::Playback { running } => self.running = running,
            Update::Rundown { shots } => self.shots = shots,
            Update::ShotHidden { shot_id } => {
                if let Some(shot) = self.shots.iter_mut().find(|s| s.id == shot_id) {
                    shot.hidden = true;
                }
            }
            Update::LinkLost => {
                // A stale anchor would keep counting down against a session that may have
                // been stopped, skipped or advanced while the link was down, and beep at
                // the wrong moment — which tells the switcher operator to cut at the wrong
                // moment. A silent tray is visibly broken; a lying one is worse. The
                // Shots are kept so the window can still show what was last loaded.
                self.running = false;
                self.live_index = None;
                self.anchor = None;
            }
        }
    }

    /// How long the live Shot runs for, including any immediately following hidden Shots.
    ///
    /// The operator never cuts to a hidden Shot, so the countdown has to span it. This is
    /// not hypothetical: `getShotsWithHiddenFlags` marks *skipped* Shots hidden, and those
    /// sit after the live one.
    pub fn effective_duration_ms(&self) -> Option<u64> {
        let live_index = self.live_index?;
        let live = self.shots.get(live_index)?;

        let trailing: u64 = self.shots[live_index + 1..]
            .iter()
            .take_while(|shot| shot.hidden)
            .map(|shot| shot.duration_ms)
            .sum();

        Some(live.duration_ms + trailing)
    }

    /// Milliseconds left on the live Shot, clamped at zero.
    ///
    /// Zero is a normal, long-lived state: per ADR 0002 the countdown runs on into overrun
    /// and nothing auto-advances.
    pub fn remaining_ms(&self, now_ms: u64) -> Option<u64> {
        let anchor = self.anchor?;
        let total = self.effective_duration_ms()?;
        Some(total.saturating_sub(now_ms.saturating_sub(anchor)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shot(id: &str, duration_ms: u64, hidden: bool) -> Shot {
        Shot {
            id: id.into(),
            duration_ms,
            hidden,
        }
    }

    fn model(shots: Vec<Shot>, live_index: usize) -> LiveModel {
        LiveModel {
            shots,
            live_index: Some(live_index),
            anchor: Some(0),
            running: true,
        }
    }

    #[test]
    fn effective_duration_is_the_live_shot_alone_when_nothing_follows_is_hidden() {
        let m = model(
            vec![shot("a", 3000, false), shot("b", 1000, false)],
            0,
        );
        assert_eq!(m.effective_duration_ms(), Some(3000));
    }

    #[test]
    fn effective_duration_spans_consecutive_hidden_shots() {
        let m = model(
            vec![
                shot("a", 3000, false),
                shot("b", 1000, true),
                shot("c", 1000, true),
            ],
            0,
        );
        assert_eq!(m.effective_duration_ms(), Some(5000));
    }

    #[test]
    fn effective_duration_stops_at_the_first_visible_shot() {
        let m = model(
            vec![
                shot("a", 3000, false),
                shot("b", 1000, true),
                shot("c", 1000, false),
                shot("d", 1000, true),
            ],
            0,
        );
        assert_eq!(m.effective_duration_ms(), Some(4000));
    }

    #[test]
    fn effective_duration_is_none_when_the_live_index_is_out_of_range() {
        // Reachable for real: state:live and state:rundown arrive as separate messages, so
        // there is a window where the index points past the Shots we hold.
        let m = model(vec![shot("a", 3000, false)], 7);
        assert_eq!(m.effective_duration_ms(), None);
        assert_eq!(m.remaining_ms(1000), None);
    }

    #[test]
    fn effective_duration_is_none_when_nothing_is_live() {
        let m = LiveModel {
            shots: vec![shot("a", 3000, false)],
            ..Default::default()
        };
        assert_eq!(m.effective_duration_ms(), None);
    }

    #[test]
    fn remaining_counts_down_and_clamps_at_zero() {
        let m = model(vec![shot("a", 3000, false)], 0);
        assert_eq!(m.remaining_ms(0), Some(3000));
        assert_eq!(m.remaining_ms(1500), Some(1500));
        assert_eq!(m.remaining_ms(3000), Some(0));
        assert_eq!(m.remaining_ms(9000), Some(0), "overrun stays at zero");
    }

    #[test]
    fn live_update_anchors_elapsed_against_our_own_clock() {
        let mut m = LiveModel::default();
        m.apply(
            Update::Rundown {
                shots: vec![shot("a", 5000, false)],
            },
            0,
        );
        m.apply(
            Update::Live {
                live_index: Some(0),
                elapsed_ms: Some(2000),
            },
            10_000,
        );
        assert_eq!(m.anchor, Some(8000));
        assert_eq!(m.remaining_ms(10_000), Some(3000));
    }

    #[test]
    fn a_null_elapsed_clears_the_anchor() {
        let mut m = model(vec![shot("a", 5000, false)], 0);
        m.apply(
            Update::Live {
                live_index: Some(0),
                elapsed_ms: None,
            },
            10_000,
        );
        assert_eq!(m.anchor, None);
        assert_eq!(m.remaining_ms(10_000), None);
    }

    #[test]
    fn hiding_a_shot_extends_the_running_countdown() {
        let mut m = model(
            vec![shot("a", 3000, false), shot("b", 2000, false)],
            0,
        );
        assert_eq!(m.remaining_ms(1000), Some(2000));

        m.apply(
            Update::ShotHidden {
                shot_id: "b".into(),
            },
            1000,
        );
        assert_eq!(m.remaining_ms(1000), Some(4000));
    }

    #[test]
    fn hiding_an_unknown_shot_changes_nothing() {
        let mut m = model(vec![shot("a", 3000, false)], 0);
        m.apply(
            Update::ShotHidden {
                shot_id: "nope".into(),
            },
            0,
        );
        assert_eq!(m.effective_duration_ms(), Some(3000));
    }

    #[test]
    fn losing_the_link_stops_the_session_but_keeps_the_shots() {
        let mut m = model(vec![shot("a", 3000, false)], 0);
        m.apply(Update::LinkLost, 500);

        assert!(!m.running);
        assert_eq!(m.live_index, None);
        assert_eq!(m.anchor, None);
        assert_eq!(m.remaining_ms(500), None);
        assert_eq!(m.shots.len(), 1, "the window still shows the last rundown");
    }
}
