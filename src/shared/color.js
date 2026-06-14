// @ts-check

// Deterministic per-user color. Hue is an FNV-1a hash folded to 0..359.
// Saturation and lightness are each chosen from a small band set using HIGH
// bits of the same 32-bit hash, drawn from bit windows disjoint from the low
// bits that `% 360` consumes. The result is 360 hues * 3 sat bands * 4 light
// bands = 4320 distinct, perceptually separable swatches. The first entry of
// each band set is the prior single value (70% sat, 55% light), so the palette
// is a strict superset of the earlier single band. Every operation stays in
// unsigned 32-bit integer space (`Math.imul` + `>>> 0`), so the value is
// byte-identical on the server render and the first client paint. No
// randomness, no Date.

// Band sets. Index 0 of each is the legacy value, so the old single swatch
// remains reachable and the palette only grows. Bands are spaced far enough
// apart to read as distinct chips while every combination keeps a legible
// contrast for foreground text (S in [60, 85], L in [38, 65] - never
// near-white, never near-black).
const SAT_BANDS = [70, 60, 85];
const LIGHT_BANDS = [55, 45, 65, 38];

/**
 * Deterministic color for a stable per-user key. The same input always yields
 * the same `hsl(...)` on the server and on every client, so server-rendered
 * markup and the first client paint agree with no hydration mismatch.
 *
 * The hue is an FNV-1a hash of the key folded into 0..359; saturation and
 * lightness are each drawn from a legible band using high bits of the same
 * hash, widening the palette to 4320 distinct swatches without sacrificing
 * foreground contrast. Returns an `hsl(...)` string usable directly as a CSS
 * color or a custom property.
 *
 * @param {string} key - a stable per-user key
 * @returns {string} an `hsl(h, s%, l%)` color string
 */
export function colorForKey(key) {
	const h = hash32(key);
	const hue = h % 360;
	// Band selectors come from high bit windows. `% 360` effectively consumes
	// the low ~9 bits (360 < 512), so reading from bit 17 and bit 23 keeps the
	// bands statistically independent of the hue. The two windows (bits 17..
	// and 23..) and the hue's low region do not overlap, so no selector is a
	// slave of another.
	const light = LIGHT_BANDS[(h >>> 17) % LIGHT_BANDS.length];
	const sat = SAT_BANDS[(h >>> 23) % SAT_BANDS.length];
	return `hsl(${hue}, ${sat}%, ${light}%)`;
}

/**
 * The raw hue (0..359) for a key. Exposed separately so a caller can build a
 * different color expression (for example a translucent selection fill) from
 * the same deterministic hue.
 *
 * @param {string} key
 * @returns {number} integer hue in [0, 360)
 */
export function hueForKey(key) {
	return hash32(key) % 360;
}

/**
 * FNV-1a, 32-bit. Offset basis 2166136261, prime 16777619. All math is kept in
 * 32-bit unsigned space via `Math.imul` + `>>> 0` so the result is identical
 * across engines (server Node and every browser). A naive `h * 16777619`
 * overflows into float territory and diverges per engine, which would break the
 * server/client color agreement.
 *
 * @param {string} key
 * @returns {number} unsigned 32-bit hash
 */
function hash32(key) {
	const s = typeof key === 'string' ? key : String(key);
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}
