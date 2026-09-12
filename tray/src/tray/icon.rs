//! The tray glyph, drawn rather than shipped.
//!
//! Both tray backends want raw pixels, so generating them costs less than an image decoder
//! in the binary and sidesteps every question about where an asset file lives once the
//! program is installed.
//!
//! The mark is a ring with a centre dot — a cue mark. It is deliberately not the main app's
//! icon: at 22 px a detailed app icon reads as a smudge, and the two programs are not the
//! same thing.

/// Tray icons are drawn small. 32 px covers the usual 16-24 px slots with room for the
/// scaling most desktops apply.
pub const SIZE: u32 = 32;

/// `true` once the tray is connected to a main app; the ring hollows out when it is not, so
/// a dead link is visible without opening anything.
pub fn rgba(connected: bool) -> Vec<u8> {
    let size = SIZE as f32;
    let centre = size / 2.0;
    let outer = centre - 2.0;
    let inner = outer - 4.5;
    let dot = 4.5;

    let mut pixels = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            // Sample from pixel centres so the coverage estimate is symmetric.
            let dx = x as f32 + 0.5 - centre;
            let dy = y as f32 + 0.5 - centre;
            let distance = (dx * dx + dy * dy).sqrt();

            let ring = coverage(outer - distance).min(coverage(distance - inner));
            let centre_dot = if connected {
                coverage(dot - distance)
            } else {
                0.0
            };

            let alpha = ring.max(centre_dot);
            // White, left to the desktop to tint. Every tray implementation worth
            // supporting recolours monochrome icons to match its panel.
            pixels.extend_from_slice(&[0xff, 0xff, 0xff, (alpha * 255.0).round() as u8]);
        }
    }
    pixels
}

/// The same image as ARGB32, which is what StatusNotifierItem asks for.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn argb(connected: bool) -> Vec<u8> {
    rgba(connected)
        .chunks_exact(4)
        .flat_map(|p| [p[3], p[0], p[1], p[2]])
        .collect()
}

/// Antialiases an edge over one pixel: `signed_distance` is positive inside the shape.
fn coverage(signed_distance: f32) -> f32 {
    (signed_distance + 0.5).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alpha_at(pixels: &[u8], x: u32, y: u32) -> u8 {
        pixels[((y * SIZE + x) * 4 + 3) as usize]
    }

    #[test]
    fn the_icon_is_the_size_it_claims() {
        assert_eq!(rgba(true).len(), (SIZE * SIZE * 4) as usize);
        assert_eq!(argb(true).len(), (SIZE * SIZE * 4) as usize);
    }

    #[test]
    fn the_corners_are_transparent_so_the_glyph_reads_as_a_mark() {
        let pixels = rgba(true);
        assert_eq!(alpha_at(&pixels, 0, 0), 0);
        assert_eq!(alpha_at(&pixels, SIZE - 1, SIZE - 1), 0);
    }

    #[test]
    fn the_ring_is_drawn_in_both_states() {
        let half = SIZE / 2;
        for connected in [true, false] {
            let pixels = rgba(connected);
            assert!(
                alpha_at(&pixels, 2, half) > 200,
                "left edge of the ring, connected={connected}"
            );
        }
    }

    #[test]
    fn only_the_connected_icon_has_a_centre_dot() {
        let half = SIZE / 2;
        assert!(alpha_at(&rgba(true), half, half) > 200);
        assert_eq!(alpha_at(&rgba(false), half, half), 0);
    }

    #[test]
    fn argb_reorders_the_same_pixels() {
        let rgba = rgba(true);
        let argb = argb(true);
        let half = ((SIZE / 2 * SIZE + SIZE / 2) * 4) as usize;
        assert_eq!(argb[half], rgba[half + 3], "alpha moves to the front");
        assert_eq!(argb[half + 1], rgba[half]);
    }
}
