//! The cue scheduler: decides which sounds fire, and when.
//!
//! A line-for-line port of the countdown in `src/shared/components/ShotlistWidget.tsx`
//! (the ticker effect). Pure and total — time comes in as monotonic milliseconds and cues
//! go out as return values, so the whole thing is driven directly from tests with no
//! clock trait, no mocking and no audio device.
//!
//! Fidelity to the TS matters more than elegance here. Where the original looks odd, the
//! oddity is reproduced and the reason recorded, because the operator window and the Cue
//! Tray beeping at different moments is precisely the failure this program must not have.

use crate::audio::Cue;
use crate::model::LiveModel;

/// How often the engine is ticked. The browser throttles its animation frames to the same
/// interval, so cue timing is accurate to ±50 ms in both places — matching, rather than
/// improving on, the operator window is the point.
pub const TICK_INTERVAL_MS: u64 = 50;

/// The countdown speaks only these numbers, even though `four.opus` and `five.opus` ship.
const FIRST_SPOKEN_SECOND: u64 = 3;

#[derive(Debug, Default, Clone, Copy)]
pub struct Mutes {
    pub count: bool,
    pub beep: bool,
}

#[derive(Debug, Default)]
pub struct CueEngine {
    /// Whole seconds remaining at the previous tick. The countdown fires on the *fall*
    /// between ticks, which is why the previous value is what gets spoken.
    prev_sec: Option<u64>,
    prev_ms: Option<u64>,
    /// One beep per Shot, however long the overrun runs on.
    beep_fired: bool,
    prev_live_index: Option<usize>,
    prev_anchor: Option<i64>,
}

impl CueEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Advances to `now_ms` and returns the cues to play, in the order they should start.
    ///
    /// Returns an empty `Vec`, which does not allocate, on the overwhelming majority of
    /// ticks.
    pub fn tick(&mut self, model: &LiveModel, mutes: Mutes, now_ms: i64) -> Vec<Cue> {
        // The browser tears its ticker down when playback stops, leaving the refs
        // untouched, so a stopped session neither fires cues nor disturbs the state.
        if !model.running {
            return Vec::new();
        }
        let Some(live_index) = model.live_index else {
            return Vec::new();
        };

        if Some(live_index) != self.prev_live_index || model.anchor != self.prev_anchor {
            self.rearm(live_index, model.anchor);
        }

        let remaining_ms = model.remaining_ms(now_ms);
        let remaining_sec = remaining_ms.map(|ms| ms / 1000);

        // Read the previous values before overwriting them, and only overwrite when the
        // new one exists — a Shot whose timing is momentarily unknown must not look like
        // a countdown that has reached zero.
        let prev_sec = self.prev_sec;
        if remaining_sec.is_some() {
            self.prev_sec = remaining_sec;
        }
        let prev_ms = self.prev_ms;
        if remaining_ms.is_some() {
            self.prev_ms = remaining_ms;
        }

        let mut cues = Vec::new();

        // A number is spoken at the *end* of its second: "three" plays as the countdown
        // falls from 3 to 2, so the word lands three seconds before the Shot expires.
        if !mutes.count {
            if let (Some(prev), Some(now)) = (prev_sec, remaining_sec) {
                if now < prev && (1..=FIRST_SPOKEN_SECOND).contains(&prev) {
                    cues.push(Cue::Word(prev as u8));
                }
            }
        }

        // The beep lands on the same tick as "one". `prev_ms > 0` means a Shot that is
        // already expired when we first see it — a late join — does not beep retroactively.
        if !mutes.beep && !self.beep_fired {
            if let (Some(0), Some(prev)) = (remaining_ms, prev_ms) {
                if prev > 0 {
                    self.beep_fired = true;
                    cues.push(Cue::Beep);
                }
            }
        }

        cues
    }

    /// Starts a fresh Shot: re-arms the beep and forgets the previous Shot's countdown.
    ///
    /// The anchor is compared as well as the index because the main app recomputes
    /// `elapsedMs` on every `state:live`, so a restart of the *same* Shot changes only the
    /// anchor — and must still re-arm.
    fn rearm(&mut self, live_index: usize, anchor: Option<i64>) {
        self.prev_sec = None;
        self.prev_ms = None;
        self.beep_fired = false;
        self.prev_live_index = Some(live_index);
        self.prev_anchor = anchor;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Shot, Update};

    fn shot(id: &str, duration_ms: u64, hidden: bool) -> Shot {
        Shot {
            id: id.into(),
            duration_ms,
            hidden,
        }
    }

    /// Drives the engine at the real tick rate, applying scripted updates at given times,
    /// and records every cue with the millisecond it fired at.
    struct Harness {
        model: LiveModel,
        engine: CueEngine,
        mutes: Mutes,
        now: i64,
        fired: Vec<(i64, Cue)>,
    }

    impl Harness {
        fn new(shots: Vec<Shot>) -> Self {
            let mut h = Harness {
                model: LiveModel::default(),
                engine: CueEngine::new(),
                mutes: Mutes::default(),
                now: 0,
                fired: Vec::new(),
            };
            h.apply(Update::Rundown { shots });
            h.apply(Update::Playback { running: true });
            h
        }

        /// The usual opening move: Shot `index` goes live now, from its start.
        fn go_live(&mut self, index: usize) -> &mut Self {
            self.apply(Update::Live {
                live_index: Some(index),
                elapsed_ms: Some(0),
            });
            self
        }

        fn apply(&mut self, update: Update) -> &mut Self {
            self.model.apply(update, self.now);
            self
        }

        fn mute(&mut self, mutes: Mutes) -> &mut Self {
            self.mutes = mutes;
            self
        }

        fn advance(&mut self, duration_ms: i64) -> &mut Self {
            let until = self.now + duration_ms;
            while self.now < until {
                self.now += TICK_INTERVAL_MS as i64;
                for cue in self.engine.tick(&self.model, self.mutes, self.now) {
                    self.fired.push((self.now, cue));
                }
            }
            self
        }

        /// Jumps the clock without ticking in between — a stalled process, or a laptop lid.
        fn skip(&mut self, duration_ms: i64) -> &mut Self {
            self.now += duration_ms;
            for cue in self.engine.tick(&self.model, self.mutes, self.now) {
                self.fired.push((self.now, cue));
            }
            self
        }

        fn cues(&self) -> Vec<Cue> {
            self.fired.iter().map(|(_, cue)| *cue).collect()
        }

        fn times(&self) -> Vec<i64> {
            self.fired.iter().map(|(at, _)| *at).collect()
        }
    }

    fn countdown_then_beep() -> Vec<Cue> {
        vec![Cue::Word(3), Cue::Word(2), Cue::Word(1), Cue::Beep]
    }

    #[test]
    fn a_stopped_session_is_silent() {
        let mut h = Harness::new(vec![shot("a", 5000, false)]);
        h.go_live(0)
            .apply(Update::Playback { running: false })
            .advance(10_000);
        assert!(h.cues().is_empty());
    }

    #[test]
    fn nothing_fires_before_a_shot_goes_live() {
        let mut h = Harness::new(vec![shot("a", 5000, false)]);
        h.advance(10_000);
        assert!(h.cues().is_empty());
    }

    #[test]
    fn a_five_second_shot_counts_down_and_beeps() {
        let mut h = Harness::new(vec![shot("a", 5000, false)]);
        h.go_live(0).advance(6000);

        assert_eq!(h.cues(), countdown_then_beep());
        // "three" three seconds in, "one" and the beep together at expiry.
        assert_eq!(h.times(), vec![2050, 3050, 4050, 5000]);
    }

    #[test]
    fn the_beep_fires_once_however_long_the_overrun_runs() {
        // ADR 0002: nothing auto-advances, so zero is a normal state that can last minutes.
        let mut h = Harness::new(vec![shot("a", 2000, false)]);
        h.go_live(0).advance(60_000);

        assert_eq!(h.cues().iter().filter(|c| **c == Cue::Beep).count(), 1);
    }

    #[test]
    fn muting_the_count_leaves_the_beep() {
        let mut h = Harness::new(vec![shot("a", 5000, false)]);
        h.mute(Mutes {
            count: true,
            beep: false,
        })
        .go_live(0)
        .advance(6000);

        assert_eq!(h.cues(), vec![Cue::Beep]);
    }

    #[test]
    fn muting_the_beep_leaves_the_count() {
        let mut h = Harness::new(vec![shot("a", 5000, false)]);
        h.mute(Mutes {
            count: false,
            beep: true,
        })
        .go_live(0)
        .advance(6000);

        assert_eq!(h.cues(), vec![Cue::Word(3), Cue::Word(2), Cue::Word(1)]);
    }

    #[test]
    fn the_countdown_spans_trailing_hidden_shots() {
        // The operator never cuts to a hidden Shot, so its time belongs to the live one.
        let mut h = Harness::new(vec![
            shot("a", 3000, false),
            shot("b", 1000, true),
            shot("c", 1000, true),
        ]);
        h.go_live(0).advance(6000);

        assert_eq!(h.cues(), countdown_then_beep());
        assert_eq!(h.times(), vec![2050, 3050, 4050, 5000]);
    }

    #[test]
    fn the_countdown_stops_at_the_first_visible_shot() {
        let mut h = Harness::new(vec![
            shot("a", 3000, false),
            shot("b", 1000, true),
            shot("c", 1000, false),
            shot("d", 1000, true),
        ]);
        h.go_live(0).advance(5000);

        assert_eq!(h.times(), vec![1050, 2050, 3050, 4000]);
    }

    #[test]
    fn hiding_a_shot_mid_countdown_pushes_expiry_back() {
        // Skipping the next Shot during a Live session hides it, and the countdown has to
        // lengthen to match — the case a naive port gets wrong.
        let mut h = Harness::new(vec![shot("a", 3000, false), shot("b", 2000, false)]);
        h.go_live(0).advance(500);
        h.apply(Update::ShotHidden {
            shot_id: "b".into(),
        });
        h.advance(6000);

        assert_eq!(h.cues(), countdown_then_beep());
        assert_eq!(h.times(), vec![2050, 3050, 4050, 5000], "expiry moved 3s -> 5s");
    }

    #[test]
    fn advancing_to_the_next_shot_rearms_the_beep() {
        let mut h = Harness::new(vec![shot("a", 2000, false), shot("b", 2000, false)]);
        h.go_live(0).advance(2500);
        h.go_live(1).advance(2500);

        assert_eq!(h.cues().iter().filter(|c| **c == Cue::Beep).count(), 2);
    }

    #[test]
    fn restarting_the_same_shot_rearms_the_beep() {
        // state:live carries elapsedMs, recomputed on every push, so a restart of the same
        // Shot changes only the anchor. It must still re-arm.
        let mut h = Harness::new(vec![shot("a", 2000, false)]);
        h.go_live(0).advance(2500);
        h.go_live(0).advance(2500);

        assert_eq!(h.cues().iter().filter(|c| **c == Cue::Beep).count(), 2);
    }

    #[test]
    fn a_new_shot_does_not_inherit_the_previous_countdown() {
        let mut h = Harness::new(vec![shot("a", 5000, false), shot("b", 10_000, false)]);
        // Cut away mid-countdown, between "three" and "two".
        h.go_live(0).advance(2500);
        assert_eq!(h.cues(), vec![Cue::Word(3)]);

        h.go_live(1).advance(5000);
        assert_eq!(
            h.cues(),
            vec![Cue::Word(3)],
            "the long Shot is nowhere near its countdown yet"
        );
    }

    #[test]
    fn a_clock_jump_across_the_countdown_speaks_once_rather_than_catching_up() {
        // The browser behaves the same way: one word per tick, no backlog.
        let mut h = Harness::new(vec![shot("a", 5000, false)]);
        h.go_live(0).advance(2000); // remaining 3s, prev_sec now 3
        h.skip(2000); // remaining 1s

        assert_eq!(h.cues(), vec![Cue::Word(3)]);
    }

    #[test]
    fn joining_late_does_not_replay_the_countdown() {
        let mut h = Harness::new(vec![shot("a", 5000, false)]);
        h.apply(Update::Live {
            live_index: Some(0),
            elapsed_ms: Some(4500),
        });
        h.advance(2000);

        assert_eq!(
            h.cues(),
            vec![Cue::Beep],
            "no retroactive words, but expiry is still marked"
        );
    }

    #[test]
    fn joining_after_expiry_is_silent() {
        let mut h = Harness::new(vec![shot("a", 5000, false)]);
        h.apply(Update::Live {
            live_index: Some(0),
            elapsed_ms: Some(9000),
        });
        h.advance(5000);

        assert!(h.cues().is_empty(), "the Shot was already in overrun");
    }

    #[test]
    fn a_zero_duration_shot_does_not_beep() {
        // Mirrors the TS `prevMs !== null && prevMs > 0` guard: there was never a moment
        // with time left, so nothing expired.
        let mut h = Harness::new(vec![shot("a", 0, false)]);
        h.go_live(0).advance(3000);

        assert!(h.cues().is_empty());
    }

    #[test]
    fn losing_the_link_mid_countdown_stops_the_cues() {
        let mut h = Harness::new(vec![shot("a", 5000, false)]);
        h.go_live(0).advance(2500);
        assert_eq!(h.cues(), vec![Cue::Word(3)]);

        h.apply(Update::LinkLost).advance(10_000);
        assert_eq!(h.cues(), vec![Cue::Word(3)], "nothing more after the link dies");
    }

    #[test]
    fn reconnecting_resumes_from_the_fresh_anchor() {
        let mut h = Harness::new(vec![shot("a", 5000, false)]);
        h.go_live(0).advance(2500);
        h.apply(Update::LinkLost).advance(30_000);

        // The handshake replays all three events on reconnect.
        h.apply(Update::Playback { running: true });
        h.apply(Update::Live {
            live_index: Some(0),
            elapsed_ms: Some(1000),
        });
        h.advance(5000);

        assert_eq!(
            h.cues(),
            vec![Cue::Word(3), Cue::Word(3), Cue::Word(2), Cue::Word(1), Cue::Beep],
        );
    }

    #[test]
    fn a_live_index_past_the_end_of_the_rundown_is_silent() {
        let mut h = Harness::new(vec![shot("a", 5000, false)]);
        h.go_live(7).advance(10_000);

        assert!(h.cues().is_empty());
    }

    #[test]
    fn an_absent_anchor_is_silent() {
        let mut h = Harness::new(vec![shot("a", 5000, false)]);
        h.apply(Update::Live {
            live_index: Some(0),
            elapsed_ms: None,
        });
        h.advance(10_000);

        assert!(h.cues().is_empty());
    }
}
