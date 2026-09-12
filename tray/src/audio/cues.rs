//! The cue sounds, decoded from `resources/audio/*.opus` at build time.
//!
//! The generated module holds raw little-endian `i16` at 48 kHz mono. Bytes rather than
//! `&[i16]` so `include_bytes!`'s alignment is irrelevant; they are widened once at startup.

include!(concat!(env!("OUT_DIR"), "/cues.rs"));

/// Which sound to play. The Cue Tray reproduces the operator window's unfiltered cues, so
/// there is no `beep-low` here — that belongs to the Phone view's camera-filter mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cue {
    /// A spoken countdown number, 1 to 3.
    Word(u8),
    /// The Shot has reached its end.
    Beep,
}

impl Cue {
    fn raw(self) -> &'static [u8] {
        match self {
            Cue::Word(1) => ONE_PCM,
            Cue::Word(2) => TWO_PCM,
            Cue::Word(3) => THREE_PCM,
            // The countdown never exceeds three, so anything else is a programming error
            // rather than a runtime condition; falling back to the beep keeps a show
            // running instead of going silent.
            Cue::Word(_) | Cue::Beep => BEEP_PCM,
        }
    }

    /// Decodes the embedded bytes into samples ready for the mixer.
    pub fn samples(self) -> Vec<i16> {
        self.raw()
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every cue is a short spoken word or tone. Bounds rather than exact counts, so
    /// re-recording an asset does not break the build, but a truncated or empty decode does.
    #[test]
    fn every_cue_decodes_to_a_plausible_length() {
        for cue in [Cue::Word(1), Cue::Word(2), Cue::Word(3), Cue::Beep] {
            let samples = cue.samples();
            let ms = samples.len() as u32 * 1000 / SAMPLE_RATE;
            assert!(
                (100..=1500).contains(&ms),
                "{cue:?} decoded to {ms} ms, outside the plausible range for a cue",
            );
        }
    }

    /// Guards against the decode silently producing zeroes, which would leave the tray
    /// looking healthy while playing nothing.
    #[test]
    fn every_cue_carries_audio() {
        for cue in [Cue::Word(1), Cue::Word(2), Cue::Word(3), Cue::Beep] {
            let peak = cue.samples().iter().map(|s| s.unsigned_abs()).max().unwrap();
            assert!(peak > 1000, "{cue:?} peaks at {peak}, effectively silent");
        }
    }

    /// The pre-skip trim in build.rs removes the encoder's priming samples. If it ever
    /// regresses, the cue opens on a click.
    #[test]
    fn cues_do_not_open_on_a_click() {
        for cue in [Cue::Word(1), Cue::Word(2), Cue::Word(3), Cue::Beep] {
            let samples = cue.samples();
            let first = samples[0].unsigned_abs();
            assert!(first < 8000, "{cue:?} starts at amplitude {first}");
        }
    }

    #[test]
    fn cues_are_mono_at_48k() {
        assert_eq!(SAMPLE_RATE, 48_000);
        assert_eq!(CHANNELS, 1);
    }
}
