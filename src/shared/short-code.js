// @ts-check

// Unguessable, sequential-free short codes from a monotonic counter, via a
// keyed balanced Feistel network. An app that mints rooms/shares from a
// sequential id (`1, 2, 3, ...`) can hand out `encode(id)` as the public
// join/share code and recover the id with `decode(code)`, without a lookup
// table and without ever exposing that the ids are sequential - "sequential
// codes let anyone scan the id space".
//
// Why a Feistel: a Feistel network is a bijection for ANY round function, so the
// mapping is collision-free and exactly reversible with no stored table, and -
// keyed by a secret - the output looks scrambled instead of sequential. The
// domain of a balanced Feistel is a power of two (`2^bits`); to produce a code
// over the exact `62^length` space we run the Feistel on the next even bit-width
// at or above `62^length` and CYCLE-WALK: if a permuted value lands outside
// `[0, 62^length)` we permute again until it lands inside. Because the Feistel
// is a bijection on `[0, 2^bits)`, cycle-walking is a bijection on the sub-range,
// so encode/decode stay collision-free and reversible over the full code space.
//
// Determinism: pure integer arithmetic (`Math.imul` + `>>> 0` within each half,
// exact double math for the `<= 52`-bit assembly), no clock, no RNG - so it is
// byte-identical on every replica and clean under the determinism harness. The
// secret is supplied as a numeric `seed` (the server factory derives it from the
// operator secret string, or a per-process random default); this module never
// generates randomness itself.
//
// Threat level: this is OBFUSCATION, not cryptography. Without the key a code is
// unguessable and non-sequential, which defeats id-space scanning; but the round
// function is a fast integer mix, not a cipher, so it is not a substitute for a
// real authorization check. A code that grants access must still be validated by
// a room guard - treat the code as a hard-to-guess handle, not as proof of
// authorization on its own.

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** @type {Map<string, number>} char -> value, built once from ALPHABET. */
const CHAR_VALUE = new Map();
for (let i = 0; i < ALPHABET.length; i++) CHAR_VALUE.set(ALPHABET[i], i);

const ROUNDS_DEFAULT = 4; // Luby-Rackoff: >= 3-4 rounds gives a pseudorandom permutation.
const LENGTH_DEFAULT = 6; // 62^6 ~ 56.8 billion codes; a comfortable room/share space.
const LENGTH_MAX = 8; // 62^8 ~ 2.18e14: the 48-bit Feistel + assembly stays inside 2^53.

/** FNV-1a of a string to a 32-bit unsigned int - the seed derivation. */
export function fnv1a32(str) {
	let h = 2166136261;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** 62^length, exact for length <= 8 (< 2^53). */
function spaceFor(length) {
	let m = 1;
	for (let i = 0; i < length; i++) m *= 62;
	return m;
}

/**
 * A keyed balanced Feistel short-code codec over `[0, 62^length)`.
 *
 * @param {{ length?: number, seed: number, rounds?: number }} config
 *   - `length`: code length in Base62 chars (fixed, zero-padded). Default 6, max 8.
 *   - `seed`: the 32-bit secret seed (the server factory derives it).
 *   - `rounds`: Feistel rounds. Default 4.
 * @returns {{ encode: (n: number) => string, decode: (code: string) => number | null, length: number, space: number }}
 */
export function createShortCode(config) {
	const length = config.length === undefined ? LENGTH_DEFAULT : config.length;
	if (!Number.isInteger(length) || length < 1 || length > LENGTH_MAX) {
		throw new Error(`[svelte-realtime] shortCodes: length must be an integer in 1..${LENGTH_MAX}`);
	}
	const rounds = config.rounds === undefined ? ROUNDS_DEFAULT : config.rounds;
	if (!Number.isInteger(rounds) || rounds < 1) {
		throw new Error('[svelte-realtime] shortCodes: rounds must be a positive integer');
	}
	const seed = config.seed >>> 0;
	const space = spaceFor(length);

	// Smallest EVEN bit-width whose power-of-two domain covers the code space, so
	// the balanced Feistel's two halves are equal and cycle-walking has a bounded
	// (< 2x) expected walk length.
	let bits = 0;
	while (Math.pow(2, bits) < space) bits++;
	if (bits % 2 === 1) bits++;
	const halfBits = bits / 2;
	const HALF = Math.pow(2, halfBits); // 2^halfBits; halfBits <= 24, so this fits a 32-bit int
	const halfMask = HALF - 1;

	// Per-round keys mixed from the seed and the round index. A distinct constant
	// per round so the rounds do not collapse into a weaker permutation.
	const roundKeys = new Array(rounds);
	for (let i = 0; i < rounds; i++) {
		let k = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
		k = Math.imul(k ^ (k >>> 15), 0x85ebca6b) >>> 0;
		k = Math.imul(k ^ (k >>> 13), 0xc2b2ae35) >>> 0;
		roundKeys[i] = (k ^ (k >>> 16)) >>> 0;
	}

	/** The keyed round function: a half-wide value -> a half-wide value. */
	function F(r, rk) {
		let h = (r ^ rk) >>> 0;
		h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
		h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
		h = (h ^ (h >>> 16)) >>> 0;
		return h & halfMask;
	}

	/** One forward Feistel permutation of a value in `[0, 2^bits)`. */
	function permute(n) {
		let L = Math.floor(n / HALF);
		let R = n - L * HALF;
		for (let i = 0; i < rounds; i++) {
			const nextL = R;
			const nextR = (L ^ F(R, roundKeys[i])) & halfMask;
			L = nextL;
			R = nextR;
		}
		return L * HALF + R;
	}

	/** The inverse permutation (round keys applied in reverse). */
	function unpermute(n) {
		let L = Math.floor(n / HALF);
		let R = n - L * HALF;
		for (let i = rounds - 1; i >= 0; i--) {
			const prevR = L;
			const prevL = (R ^ F(L, roundKeys[i])) & halfMask;
			L = prevL;
			R = prevR;
		}
		return L * HALF + R;
	}

	/** Fixed-length, zero-padded Base62 of a value in `[0, space)`. */
	function toBase62(v) {
		let s = '';
		for (let i = 0; i < length; i++) {
			s = ALPHABET[v % 62] + s;
			v = Math.floor(v / 62);
		}
		return s;
	}

	return {
		length,
		space,
		/**
		 * Encode a sequence number in `[0, space)` to its unguessable code.
		 * Cycle-walks the Feistel until the permuted value is in range.
		 * @param {number} n
		 * @returns {string}
		 */
		encode(n) {
			if (!Number.isInteger(n) || n < 0 || n >= space) {
				throw new Error(`[svelte-realtime] shortCodes.encode: n must be an integer in 0..${space - 1} (${length}-char space)`);
			}
			let v = permute(n);
			while (v >= space) v = permute(v); // cycle-walk into the code space
			return toBase62(v);
		},
		/**
		 * Decode a code back to its sequence number, or `null` for a malformed
		 * code (wrong length, or a char outside the alphabet). A well-formed code
		 * that this key never minted still decodes to some in-range number - the
		 * mapping is total over the space - so validate the decoded id against
		 * your own store, exactly as you would a primary key from any client input.
		 * @param {string} code
		 * @returns {number | null}
		 */
		decode(code) {
			if (typeof code !== 'string' || code.length !== length) return null;
			let v = 0;
			for (let i = 0; i < code.length; i++) {
				const d = CHAR_VALUE.get(code[i]);
				if (d === undefined) return null;
				v = v * 62 + d;
			}
			let n = unpermute(v);
			while (n >= space) n = unpermute(n); // reverse the cycle-walk
			return n;
		}
	};
}
