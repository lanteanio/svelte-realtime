// @ts-check
//
// A transient per-tick spatial grid for area-of-interest relevancy: bin the
// positioned entities of a smooth topic into grid cells once, then query per
// subscriber by center + radius (distance-SQUARED, no sqrt), walking only the
// cells the radius spans. Below INDEX_CROSSOVER, or when a radius spans more
// cells than there are entities (the deliver-all clamp), a flat scan is cheaper
// than building/probing the index.
//
// Grounded in the proven cursor viewport culler (the shipped
// `svelte-adapter-uws-extensions/redis/cursor/spatial.js` /
// `svelte-adapter-uws/plugins/cursor/server.js`): identical packCell binning,
// bucket pool, and deliver-all clamp. The one generalization is the cull
// predicate - distance-squared against a radius (the open-arena area of
// interest) rather than the cursor's rect-bounds. The cross-repo unification of
// all three grids onto one shared primitive is a deferred follow-up; this stays
// realtime-local so K4 ships without touching the working cursor hot path.
//
// Zero per-call allocation once warm: the cell index, its bucket pool, and the
// query-output buffer are reused across ticks.

/**
 * Entity count past which a query builds the spatial index instead of a flat
 * distance test over every entity. Below it the flat scan is cheaper than the
 * per-cell Map probes; above it the index earns a multiple-x win at the
 * thousands-of-entities mega-lobby tail.
 */
export const INDEX_CROSSOVER = 512;

/**
 * Pack a grid cell coordinate pair into one numeric key. Covers +-32k cells per
 * axis (at the default 256-unit cell, +-8.3M position units). A key collision
 * can only over-deliver - every pulled entry is re-tested against the exact
 * radius - never blank a region.
 * @param {number} cx
 * @param {number} cy
 */
export function packCell(cx, cy) {
	return ((cx & 0xffff) << 16) | (cy & 0xffff);
}

/**
 * Create a per-topic spatial index. Owns the per-tick scratch (the packed-cell
 * index, its bucket pool, and the query-output buffer).
 * @param {{ cell?: number }} [opts] - grid cell size in position units (default 256).
 */
export function createSpatialIndex({ cell = 256 } = {}) {
	/** @type {Map<number, number[]>} packed cell key -> entry-index bucket */
	const cells = new Map();
	/** @type {number[][]} recycled bucket arrays */
	const pool = [];
	/** @type {number[]} reused query result (entry indices) */
	const out = [];

	/**
	 * Bin this tick's positioned entities into cells. A null position is
	 * always-visible (delivered to every subscriber) and is never binned - the
	 * caller passes those indices to every query via `alwaysVisible`.
	 * @param {Array<{ x: number, y: number } | null>} positions - resolved position per entry index
	 * @param {number} n - positions.length
	 */
	function build(positions, n) {
		release();
		for (let i = 0; i < n; i++) {
			const p = positions[i];
			if (p === null) continue;
			const ck = packCell(Math.floor(p.x / cell), Math.floor(p.y / cell));
			let bucket = cells.get(ck);
			if (!bucket) {
				bucket = pool.pop() || [];
				bucket.length = 0;
				cells.set(ck, bucket);
			}
			bucket.push(i);
		}
	}

	/** Return this tick's buckets to the pool and empty the index. */
	function release() {
		for (const bucket of cells.values()) pool.push(bucket);
		cells.clear();
	}

	/**
	 * Flat distance-squared cull over every entity. Used below INDEX_CROSSOVER,
	 * where the set is small enough that building an index does not pay. Writes
	 * the in-radius entry indices (plus every always-visible index) into the
	 * shared `out` buffer.
	 * @param {number} cx @param {number} cy @param {number} radius
	 * @param {Array<{ x: number, y: number } | null>} positions
	 * @param {number} n
	 * @param {number[]} alwaysVisible - entry indices with no resolvable position
	 * @returns {number[]}
	 */
	function cullDirect(cx, cy, radius, positions, n, alwaysVisible) {
		const r2 = radius * radius;
		out.length = 0;
		for (let a = 0; a < alwaysVisible.length; a++) out.push(alwaysVisible[a]);
		for (let i = 0; i < n; i++) {
			const p = positions[i];
			if (p === null) continue;
			const dx = p.x - cx;
			const dy = p.y - cy;
			if (dx * dx + dy * dy <= r2) out.push(i);
		}
		return out;
	}

	/**
	 * Spatial-index cull: walk only the cells the radius's bounding box spans and
	 * distance-squared-test their entities. Per-subscriber cost is O(spanned
	 * cells + entities in them), not O(all entities). A radius spanning more cells
	 * than there are entities sees ~the whole board, so it falls back to the flat
	 * scan (the deliver-all clamp), bounding worst-case cost at O(entities).
	 * @param {number} cx @param {number} cy @param {number} radius
	 * @param {Array<{ x: number, y: number } | null>} positions
	 * @param {number} n
	 * @param {number[]} alwaysVisible
	 * @returns {number[]}
	 */
	function cullIndexed(cx, cy, radius, positions, n, alwaysVisible) {
		const cx0 = Math.floor((cx - radius) / cell);
		const cy0 = Math.floor((cy - radius) / cell);
		const cx1 = Math.floor((cx + radius) / cell);
		const cy1 = Math.floor((cy + radius) / cell);
		if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > n) {
			return cullDirect(cx, cy, radius, positions, n, alwaysVisible);
		}
		const r2 = radius * radius;
		out.length = 0;
		for (let a = 0; a < alwaysVisible.length; a++) out.push(alwaysVisible[a]);
		for (let yy = cy0; yy <= cy1; yy++) {
			for (let xx = cx0; xx <= cx1; xx++) {
				const bucket = cells.get(packCell(xx, yy));
				if (!bucket) continue;
				for (let bi = 0; bi < bucket.length; bi++) {
					const i = bucket[bi];
					const p = positions[i];
					const dx = p.x - cx;
					const dy = p.y - cy;
					if (dx * dx + dy * dy <= r2) out.push(i);
				}
			}
		}
		return out;
	}

	/** Reset all scratch (topic teardown). */
	function reset() {
		out.length = 0;
		pool.length = 0;
		cells.clear();
	}

	return { build, release, cullDirect, cullIndexed, reset };
}
