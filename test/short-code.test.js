import { describe, it, expect, vi } from 'vitest';
import { shortCodes } from '../src/server.js';
import { createShortCode, fnv1a32 } from '../src/shared/short-code.js';

describe('shortCodes (unguessable, bijective room/share codes)', () => {
	it('round-trips: decode(encode(n)) === n across the space', () => {
		const codes = shortCodes({ secret: 'test-key', length: 5 });
		for (const n of [0, 1, 2, 3, 42, 1000, 999999, codes.space - 1]) {
			expect(codes.decode(codes.encode(n))).toBe(n);
		}
	});

	it('is bijective: no two sequence numbers collide on a code (dense scan)', () => {
		const codes = shortCodes({ secret: 'collide-key', length: 4 });
		const seen = new Map();
		for (let n = 0; n < 20000; n++) {
			const code = codes.encode(n);
			expect(seen.has(code)).toBe(false); // no collision
			seen.set(code, n);
			expect(codes.decode(code)).toBe(n); // and reversible
		}
	});

	it('emits fixed-length, zero-padded codes for every input including small ones', () => {
		const codes = shortCodes({ secret: 'pad-key', length: 6 });
		for (const n of [0, 1, 5, 61, 62, 1_000_000]) {
			expect(codes.encode(n)).toHaveLength(6);
		}
		expect(codes.length).toBe(6);
		expect(codes.space).toBe(62 ** 6);
	});

	it('is unguessable: sequential inputs do NOT produce sequential codes', () => {
		const codes = shortCodes({ secret: 'scatter-key', length: 6 });
		// Adjacent ids must not map to adjacent codes (that would leak sequence).
		const c0 = codes.encode(1000);
		const c1 = codes.encode(1001);
		expect(c1).not.toBe(c0);
		// And the code is not just Base62(n): id 1 does not encode to "000001".
		expect(codes.encode(1)).not.toBe('000001');
		// The first handful of ids scatter across the space rather than clustering.
		const first = Array.from({ length: 8 }, (_, i) => codes.encode(i));
		expect(new Set(first).size).toBe(8);
		// The leading char varies across a small sequential run (no shared prefix).
		const leads = new Set(first.map((c) => c[0]));
		expect(leads.size).toBeGreaterThan(1);
	});

	it('is keyed: a different secret yields a different mapping', () => {
		const a = shortCodes({ secret: 'key-a', length: 6 });
		const b = shortCodes({ secret: 'key-b', length: 6 });
		let differ = 0;
		for (let n = 0; n < 100; n++) if (a.encode(n) !== b.encode(n)) differ++;
		expect(differ).toBeGreaterThan(90); // almost all differ
		// A code minted under key-a decodes to a DIFFERENT id under key-b (total map).
		const codeA = a.encode(1234);
		expect(b.decode(codeA)).not.toBe(1234);
	});

	it('is deterministic: same secret + n yields the same code across instances', () => {
		const a = shortCodes({ secret: 'stable', length: 7 });
		const b = shortCodes({ secret: 'stable', length: 7 });
		for (const n of [0, 7, 12345, 987654321]) {
			expect(a.encode(n)).toBe(b.encode(n));
		}
	});

	it('decode returns null for a malformed code (wrong length or bad char)', () => {
		const codes = shortCodes({ secret: 'k', length: 6 });
		expect(codes.decode('abc')).toBeNull(); // too short
		expect(codes.decode('abcdefg')).toBeNull(); // too long
		expect(codes.decode('abcd-f')).toBeNull(); // '-' not in the alphabet
		expect(codes.decode(/** @type {any} */ (null))).toBeNull();
		expect(codes.decode(/** @type {any} */ (12345))).toBeNull();
	});

	it('encode rejects an out-of-range or non-integer sequence number', () => {
		const codes = shortCodes({ secret: 'k', length: 4 });
		expect(() => codes.encode(-1)).toThrow('must be an integer');
		expect(() => codes.encode(codes.space)).toThrow('must be an integer');
		expect(() => codes.encode(1.5)).toThrow('must be an integer');
	});

	it('cycle-walks correctly when the code space is not a power of two (length 6)', () => {
		// 62^6 is not a power of two, so the Feistel runs on the next even bit
		// width and cycle-walks. A dense round-trip proves the walk is symmetric.
		const codes = shortCodes({ secret: 'walk', length: 6 });
		for (let n = 0; n < 50000; n += 7) {
			expect(codes.decode(codes.encode(n))).toBe(n);
		}
	});

	it('supports configurable length (1..8) and rejects out-of-bounds', () => {
		expect(shortCodes({ secret: 'k', length: 1 }).space).toBe(62);
		expect(shortCodes({ secret: 'k', length: 8 }).space).toBe(62 ** 8);
		expect(() => shortCodes({ secret: 'k', length: 0 })).toThrow('length must be an integer');
		expect(() => shortCodes({ secret: 'k', length: 9 })).toThrow('length must be an integer');
		// Round-trip at the largest supported length.
		const big = shortCodes({ secret: 'k', length: 8 });
		for (const n of [0, 1, big.space - 1, 123456789012]) {
			expect(big.decode(big.encode(n))).toBe(n);
		}
	});

	it('rejects an empty or non-string secret', () => {
		expect(() => shortCodes({ secret: '' })).toThrow('non-empty string');
		expect(() => shortCodes({ secret: /** @type {any} */ (123) })).toThrow('non-empty string');
	});

	it('works without a secret (random per-process key) and warns once in dev', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const codes = shortCodes({ length: 6 });
		// Still fully functional and bijective, just not stable across processes.
		for (const n of [0, 1, 42, 999999]) expect(codes.decode(codes.encode(n))).toBe(n);
		// A second call does not re-warn (one-time).
		shortCodes({ length: 6 });
		expect(warn.mock.calls.filter((c) => String(c[0]).includes('without a secret')).length).toBe(1);
		warn.mockRestore();
	});

	it('fnv1a32 is a stable 32-bit derivation (same string -> same seed)', () => {
		expect(fnv1a32('hello')).toBe(fnv1a32('hello'));
		expect(fnv1a32('hello')).not.toBe(fnv1a32('world'));
		expect(fnv1a32('x') >>> 0).toBe(fnv1a32('x'));
	});

	it('the pure createShortCode primitive is deterministic for a fixed seed (DST-clean)', () => {
		const a = createShortCode({ seed: 0x1234abcd, length: 6 });
		const b = createShortCode({ seed: 0x1234abcd, length: 6 });
		for (const n of [0, 1, 500, 123456]) expect(a.encode(n)).toBe(b.encode(n));
	});

	// A wide key is worthless if the round count is low: each round mixes only
	// one 32-bit round key, and a short Feistel is peeled round by round.
	describe('rounds floor', () => {
		for (const rounds of [1, 2, 3]) {
			it(`rejects rounds: ${rounds} (effective key space is capped at rounds x 32 bits)`, () => {
				expect(() => createShortCode({ seed: 0x1234abcd, length: 6, rounds })).toThrow(/rounds must be an integer in 4\.\.64/);
				expect(() => shortCodes({ secret: 'operator-secret', rounds })).toThrow(/rounds must be an integer in 4\.\.64/);
			});
		}

		it('accepts the default and any higher round count up to the ceiling', () => {
			expect(() => shortCodes({ secret: 'operator-secret' })).not.toThrow();
			expect(() => shortCodes({ secret: 'operator-secret', rounds: 4 })).not.toThrow();
			expect(() => shortCodes({ secret: 'operator-secret', rounds: 8 })).not.toThrow();
			expect(() => shortCodes({ secret: 'operator-secret', rounds: 64 })).not.toThrow();
		});

		// A mistyped rounds must not allocate a round-key table that never finishes.
		it('rejects an absurd round count instead of hanging', () => {
			expect(() => shortCodes({ secret: 'operator-secret', rounds: 1e9 })).toThrow(/rounds must be an integer in 4\.\.64/);
		});

		it('still round-trips at the floor', () => {
			const c = shortCodes({ secret: 'operator-secret', rounds: 4 });
			for (const n of [0, 1, 42, 999999]) expect(c.decode(c.encode(n))).toBe(n);
		});
	});

	// The round keys fold in every key word, so no part of the seed is dropped.
	describe('wide key space', () => {
		it('shortCodes({ secret }) no longer equals the 32-bit fnv1a-squashed codec', () => {
			// Pre-fix the factory did createShortCode({ seed: fnv1a32(secret) }), so a
			// brute force over the 2^32 fnv1a seeds recovered the key from one known
			// (id, code) pair. The mapping must now differ from EVERY candidate a
			// 32-bit brute force can produce - spot-checked at the exact seed the
			// old derivation would have used.
			const secret = 'correct horse battery staple';
			const wide = shortCodes({ secret, length: 6 });
			const squashed = createShortCode({ length: 6, seed: fnv1a32(secret), rounds: 4 });
			let differ = 0;
			for (const n of [0, 1, 42, 1000, 424242]) {
				if (wide.encode(n) !== squashed.encode(n)) differ++;
			}
			expect(differ).toBeGreaterThan(0);
			// And decoding a wide-key code with the squashed codec yields the wrong
			// id, so a "recovered" 32-bit seed validates nothing.
			const code = wide.encode(424242);
			expect(squashed.decode(code)).not.toBe(424242);
		});

		it('accepts a wide key (word array or bytes) and round-trips bijectively', () => {
			const words = [0x01234567, 0x89abcdef, 0x0fedcba9, 0x76543210];
			const a = createShortCode({ seed: words, length: 6 });
			for (let n = 0; n < 20000; n += 7) {
				expect(a.decode(a.encode(n))).toBe(n);
			}
			// The byte form packs big-endian into the same words -> same mapping.
			const bytes = new Uint8Array([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x0f, 0xed, 0xcb, 0xa9, 0x76, 0x54, 0x32, 0x10]);
			const b = createShortCode({ seed: bytes, length: 6 });
			for (const n of [0, 1, 1000, 987654321]) expect(b.encode(n)).toBe(a.encode(n));
		});

		it('every key word matters: flipping any one word changes the mapping', () => {
			const base = [0x11111111, 0x22222222, 0x33333333, 0x44444444];
			const a = createShortCode({ seed: base, length: 6 });
			for (let w = 0; w < base.length; w++) {
				const variant = base.slice();
				variant[w] = (variant[w] ^ 1) >>> 0;
				const b = createShortCode({ seed: variant, length: 6 });
				let differ = 0;
				for (let n = 0; n < 50; n++) if (a.encode(n) !== b.encode(n)) differ++;
				expect(differ).toBeGreaterThan(40); // near-total avalanche per word
			}
		});

		it('rejects malformed seed material', () => {
			expect(() => createShortCode({ seed: /** @type {any} */ ([]), length: 6 })).toThrow(/seed/);
			expect(() => createShortCode({ seed: /** @type {any} */ ([1, 'x']), length: 6 })).toThrow(/seed/);
			expect(() => createShortCode({ seed: new Uint8Array(0), length: 6 })).toThrow(/seed/);
			expect(() => createShortCode({ seed: /** @type {any} */ ('secret'), length: 6 })).toThrow(/seed/);
		});

		it('two no-secret codecs draw independent CSPRNG keys (different mappings)', () => {
			const warn = console.warn;
			console.warn = () => {}; // hush the one-time dev warning
			try {
				const a = shortCodes({ length: 6 });
				const b = shortCodes({ length: 6 });
				let differ = 0;
				for (let n = 0; n < 20; n++) if (a.encode(n) !== b.encode(n)) differ++;
				expect(differ).toBeGreaterThan(0);
			} finally {
				console.warn = warn;
			}
		});
	});
});
