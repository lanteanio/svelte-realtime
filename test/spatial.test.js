// The transient spatial index behind area-of-interest relevancy: distance-
// squared radius cull, the deliver-all clamp, always-visible passthrough, and
// the load-bearing invariant that the indexed cull returns exactly the same set
// as the flat cull (so the INDEX_CROSSOVER switch never changes WHO is relevant,
// only the cost).

import { describe, it, expect } from 'vitest';
import { createSpatialIndex, packCell, INDEX_CROSSOVER } from '../src/server/spatial.js';

/** Resolve a query result (entry indices) to a sorted key set for comparison. */
function keysOf(indices, keys) {
	return indices.map((i) => keys[i]).sort();
}

describe('spatial index (relevancy grid)', () => {
	it('packCell is collision-free across the +-32k cell range it claims', () => {
		expect(packCell(0, 0)).not.toBe(packCell(1, 0));
		expect(packCell(0, 0)).not.toBe(packCell(0, 1));
		expect(packCell(-1, -1)).not.toBe(packCell(0, 0));
		expect(packCell(100, 200)).toBe(packCell(100, 200));
	});

	it('cullDirect returns entities within the radius (distance-squared) plus always-visible', () => {
		const idx = createSpatialIndex({ cell: 256 });
		const positions = [
			{ x: 0, y: 0 }, // 0: at center
			{ x: 30, y: 40 }, // 1: dist 50 - inside r=100
			{ x: 100, y: 0 }, // 2: dist 100 - exactly on the boundary (inclusive)
			{ x: 101, y: 0 }, // 3: dist 101 - just outside
			null // 4: always-visible
		];
		const keys = ['a', 'b', 'c', 'd', 'ALWAYS'];
		const res = idx.cullDirect(0, 0, 100, positions, positions.length, [4]);
		expect(keysOf(res, keys)).toEqual(['ALWAYS', 'a', 'b', 'c']); // d excluded, ALWAYS always in
	});

	it('cullIndexed returns the SAME set as cullDirect across radii and centers (the crossover invariant)', () => {
		const idx = createSpatialIndex({ cell: 64 });
		const keys = [];
		const positions = [];
		// A deterministic spread of 200 entities over a 2000x2000 board (no RNG - determinism seam).
		for (let i = 0; i < 200; i++) {
			keys.push('e' + i);
			positions.push({ x: (i * 137) % 2000, y: (i * 311) % 2000 });
		}
		const n = positions.length;
		const alwaysVisible = [];
		idx.build(positions, n);
		for (const [cx, cy, r] of [
			[0, 0, 100],
			[1000, 1000, 300],
			[500, 1500, 64],
			[1999, 1999, 500],
			[250, 250, 1] // tiny radius
		]) {
			const direct = keysOf(idx.cullDirect(cx, cy, r, positions, n, alwaysVisible), keys);
			const indexed = keysOf(idx.cullIndexed(cx, cy, r, positions, n, alwaysVisible), keys);
			expect(indexed).toEqual(direct);
		}
	});

	it('the deliver-all clamp returns everything when the radius spans more cells than there are entities', () => {
		const idx = createSpatialIndex({ cell: 16 }); // tiny cells -> a big radius spans many
		const positions = [
			{ x: 0, y: 0 },
			{ x: 500, y: 500 },
			{ x: -500, y: -500 }
		];
		const keys = ['a', 'b', 'c'];
		idx.build(positions, positions.length);
		// radius 2000 over 16-unit cells spans ~250x250 = 62500 cells >> 3 entities -> deliver-all path,
		// and every entity is in fact within 2000 of the origin so the result is everything anyway.
		const res = idx.cullIndexed(0, 0, 2000, positions, positions.length, []);
		expect(keysOf(res, keys)).toEqual(['a', 'b', 'c']);
	});

	it('build/release recycles buckets without leaking or mixing ticks', () => {
		const idx = createSpatialIndex({ cell: 100 });
		const a = [{ x: 0, y: 0 }, { x: 50, y: 50 }];
		idx.build(a, a.length);
		expect(keysOf(idx.cullIndexed(0, 0, 100, a, a.length, []), ['a', 'b'])).toEqual(['a', 'b']);
		// A second tick with a different population must not see the first tick's entries.
		const b = [{ x: 1000, y: 1000 }];
		idx.build(b, b.length);
		expect(idx.cullIndexed(0, 0, 100, b, b.length, [])).toEqual([]); // far away, none in radius
	});

	it('INDEX_CROSSOVER is the documented 512 default', () => {
		expect(INDEX_CROSSOVER).toBe(512);
	});
});
