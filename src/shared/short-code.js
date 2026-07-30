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
// secret is supplied as numeric `seed` key material (the server factory derives
// a 256-bit key from the operator secret string via HMAC-SHA256, or a per-process
// CSPRNG key by default); this module never generates randomness itself.
//
// Key width: every round key folds in EVERY key word, so no part of the seed is
// dropped. The effective key space is bounded by `rounds x 32` bits, NOT by the
// seed width - a 256-bit seed at the default 4 rounds gives at most 128 bits,
// and generic meet-in-the-middle on a 4-round Feistel puts the real cost near
// 2^64 with a couple of known pairs. Infeasible, but do not read "256-bit seed"
// as "256-bit security"; that is why `rounds` has a hard floor.
// A single 32-bit numeric seed is a 32-bit key - one known (id, code) pair
// recovers it by offline brute force in seconds; the server factory therefore
// never passes one (it always passes a wide key), and neither should you.
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
// Hard floor. Each round mixes one 32-bit round key, so a low round count caps
// the effective key space regardless of how wide the seed is.
const ROUNDS_MIN = 4;
// Sanity ceiling. Every round is a full pass over the key material, so a
// mistyped `rounds: 1e9` would otherwise allocate and loop effectively forever.
const ROUNDS_MAX = 64;
const LENGTH_DEFAULT = 6; // 62^6 ~ 56.8 billion codes; a comfortable room/share space.
const LENGTH_MAX = 8; // 62^8 ~ 2.18e14: the 48-bit Feistel + assembly stays inside 2^53.

/**
 * FNV-1a of a string to a 32-bit unsigned int.
 *
 * RETIRED as the key derivation: squashing an operator secret through this gave
 * a 32-bit key that one known (id, code) pair recovers by offline brute force in
 * seconds. Kept only so tests can pin that the current derivation differs from
 * it. Do NOT wire it back into `createShortCode({ seed })`.
 */
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
 * Normalize the seed to an array of 32-bit key words.
 *
 * @param {number | number[] | Uint8Array} seed
 *   - a single 32-bit integer (one word - 32 bits of key, legacy/testing only);
 *   - an array of 32-bit integers (used as the key words directly);
 *   - a `Uint8Array` (packed big-endian into words, zero-padded to a whole word).
 * @returns {number[]}
 */
function _keyWords(seed) {
	if (typeof seed === 'number') return [seed >>> 0];
	if (Array.isArray(seed)) {
		if (seed.length === 0 || seed.some((w) => typeof w !== 'number' || !Number.isInteger(w))) {
			throw new Error('[svelte-realtime] shortCodes: a seed array must be non-empty 32-bit integers');
		}
		return seed.map((w) => w >>> 0);
	}
	if (seed instanceof Uint8Array) {
		if (seed.length === 0) {
			throw new Error('[svelte-realtime] shortCodes: a seed byte array must be non-empty');
		}
		const words = [];
		for (let i = 0; i < seed.length; i += 4) {
			let w = 0;
			for (let j = 0; j < 4; j++) w = w * 256 + (seed[i + j] || 0); // exact: <= 2^32 - 1
			words.push(w >>> 0);
		}
		return words;
	}
	throw new Error('[svelte-realtime] shortCodes: seed must be a 32-bit integer, an array of 32-bit words, or a Uint8Array');
}

/**
 * A keyed balanced Feistel short-code codec over `[0, 62^length)`.
 *
 * @param {{ length?: number, seed: number | number[] | Uint8Array, rounds?: number }} config
 *   - `length`: code length in Base62 chars (fixed, zero-padded). Default 6, max 8.
 *   - `seed`: the secret key material (the server factory derives a wide key;
 *     a bare 32-bit number is 32 bits of key - brute-forceable from one known
 *     (id, code) pair, so only use it for tests).
 *   - `rounds`: Feistel rounds. Default 4.
 * @returns {{ encode: (n: number) => string, decode: (code: string) => number | null, length: number, space: number }}
 */
export function createShortCode(config) {
	const length = config.length === undefined ? LENGTH_DEFAULT : config.length;
	if (!Number.isInteger(length) || length < 1 || length > LENGTH_MAX) {
		throw new Error(`[svelte-realtime] shortCodes: length must be an integer in 1..${LENGTH_MAX}`);
	}
	const rounds = config.rounds === undefined ? ROUNDS_DEFAULT : config.rounds;
	// Floor of 4, not 1. Only `rounds x 32` bits of the key ever enter the
	// permutation, and a short Feistel is peeled round by round: at 1 round the
	// whole key IS the single round key, so one known (id, code) pair recovers it
	// in a 2^32 offline search - the exact break a wide key is here to prevent.
	// At 2-3 rounds the round keys still fall independently at ~2^32 each.
	if (!Number.isInteger(rounds) || rounds < ROUNDS_MIN || rounds > ROUNDS_MAX) {
		throw new Error(
			`[svelte-realtime] shortCodes: rounds must be an integer in ${ROUNDS_MIN}..${ROUNDS_MAX}. ` +
			'Each round mixes one 32-bit round key, so the effective key space is capped at ' +
			'rounds x 32 bits: below the minimum it is small enough to brute-force offline from ' +
			'a single known (id, code) pair. The upper bound just keeps a typo from allocating ' +
			'a round-key table that never finishes.'
		);
	}
	const keyWords = _keyWords(config.seed);
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

	// Per-round keys mixed from the full key material and the round index. Every
	// round key folds in EVERY key word, so the effective key space is the whole
	// seed width and no round key can be isolated word-by-word. A distinct
	// constant per round so the rounds do not collapse into a weaker permutation.
	const roundKeys = new Array(rounds);
	for (let i = 0; i < rounds; i++) {
		let k = Math.imul(i + 1, 0x9e3779b1) >>> 0;
		for (let w = 0; w < keyWords.length; w++) {
			k = (k ^ keyWords[w]) >>> 0;
			k = Math.imul(k ^ (k >>> 15), 0x85ebca6b) >>> 0;
			k = Math.imul(k ^ (k >>> 13), 0xc2b2ae35) >>> 0;
		}
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
