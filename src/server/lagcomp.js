// @ts-check
// Server-rewind lag compensation: the per-entity position-history ring and the
// bracket-interpolated rewind read. The smooth tick records the post-drain
// catalog here once per tick (keyed by the same wall stamp the acks use); a
// shot resolves by rewinding every candidate entity to the instant the shooter
// saw it (network latency + the client's interpolation delay), then testing the
// shot against those historical positions.
//
// The ring is PURE with respect to time and transport: record(catalog, t) and
// sample(key, at) take their timestamps from the caller (the smooth tick passes
// wallEpoch() via shared/runtime.js), so this module imports no clock and is
// determinism-clean by construction. It stores EXTRACTED {x,y} scalars (never a
// live state reference - the authority's catalog() shares the live object), plus
// a parallel snap-to-previous state reference so a hit test can read the
// time-correct stance (e.g. a crouched-then-stood target's hitbox) while the
// framework only ever LERPs the position. State stays app-opaque.
//
// Grounded in Valve Source player_lagcompensation.cpp (correct_time clamp,
// bracketing-frame lerp with an explicit never-extrapolate assert, the teleport
// guard) and idTech3 antilag (client-stamped time, "no lerping forward"); the
// ring shape mirrors the client smoother's SampleRing (parallel typed arrays).

const _DEFAULT_MAX_REWIND_MS = 1000; // Source sv_maxunlag (a ceiling, not a target)

/**
 * @param {number} cap
 * @returns {{ t: Float64Array, x: Float64Array, y: Float64Array, st: any[], brk: Uint8Array, head: number, len: number }}
 */
function _newRing(cap) {
	// `brk[i] = 1` marks a record that RESUMED after an absence (the entity was
	// dead / removed-but-key-kept / null-position for a span before it): a rewind
	// must never LERP across such a boundary (corpse -> respawn phantom).
	return { t: new Float64Array(cap), x: new Float64Array(cap), y: new Float64Array(cap), st: new Array(cap), brk: new Uint8Array(cap), head: -1, len: 0 };
}

/**
 * Create a lag-compensation ring for one smooth topic.
 *
 * @param {{
 *   position: (state: any) => ({ x: number, y: number } | null),
 *   tickMs: number,
 *   maxRewindMs?: number,
 *   teleportThreshold?: number
 * }} opts `position` extracts the hittable point from app state (the same fn the
 *   app declares for interest); `tickMs` sizes the ring; `maxRewindMs` caps how
 *   far back a shot may rewind (a hit older than this fails safe to current
 *   state); `teleportThreshold` (in position units) aborts the rewind for an
 *   entity whose bracketing pair straddles a jump larger than it (a respawn /
 *   warp must never resolve a shot against the post-warp position).
 */
export function createLagComp(opts) {
	const position = opts.position;
	const tickMs = opts.tickMs > 0 ? opts.tickMs : 50;
	const maxRewindMs = opts.maxRewindMs !== undefined ? opts.maxRewindMs : _DEFAULT_MAX_REWIND_MS;
	// One tick of slack past the policy window so the bracketing pair for a
	// rewind right at the window edge still has a valid lower bound.
	const cap = Math.max(8, Math.ceil((maxRewindMs + tickMs * 2) / tickMs) + 1);
	const teleportSq =
		typeof opts.teleportThreshold === 'number' && opts.teleportThreshold > 0
			? opts.teleportThreshold * opts.teleportThreshold
			: Infinity;
	// A record gap larger than this (the entity was absent for ~2+ ticks: death,
	// removal, or a null-position interval) is a discontinuity - the rewind must not
	// LERP across it. Two ticks of slack absorbs timer jitter (a live entity records
	// every tick) while catching any real death/respawn gap. Always on, distance-
	// independent, so it covers the respawn case the teleport-distance guard (default
	// off) does not.
	const gapMs = tickMs * 2;

	/** @type {Map<string, ReturnType<typeof _newRing>>} per entity key */
	const rings = new Map();

	return {
		/**
		 * Record the post-drain authoritative catalog into the per-entity rings.
		 * Called once per tick from the smooth tick with the tick's wall stamp.
		 * An entity with a null (always-visible) position is skipped: a positionless
		 * entity cannot be hit by a position-based shot, so it needs no history.
		 *
		 * @param {Array<{ key: string, state: any }>} catalog
		 * @param {number} t the tick wall stamp (wallEpoch ms)
		 */
		record(catalog, t) {
			for (let i = 0; i < catalog.length; i++) {
				const entry = catalog[i];
				let p;
				try {
					p = position(entry.state);
				} catch {
					p = null;
				}
				if (!p) continue;
				let r = rings.get(entry.key);
				if (r === undefined) {
					r = _newRing(cap);
					rings.set(entry.key, r);
				}
				// Mark a resume after an absence: this record follows the last one by
				// more than a gap, so the entity was gone in between (it skips the loop
				// above when its position is null, and re-add starts a fresh ring).
				const resumed = r.len > 0 && t - r.t[r.head] > gapMs ? 1 : 0;
				r.head = (r.head + 1) % cap;
				r.t[r.head] = t;
				r.x[r.head] = p.x;
				r.y[r.head] = p.y;
				r.st[r.head] = entry.state;
				r.brk[r.head] = resumed;
				if (r.len < cap) r.len++;
			}
		},

		/**
		 * The bracket-interpolated position + snap-to-previous state of one entity
		 * at the rewind instant `at`. Returns null when the entity has no history,
		 * or when the bracketing pair straddles a teleport (the shot must miss it).
		 *
		 * - at >= newest: clamp to the newest record (no extrapolation; current
		 *   state is what the shooter saw, fallback false).
		 * - at older than the window (or before the oldest held record): fail safe
		 *   to the newest record with fallback=true - never the oldest marker, or a
		 *   stale rewind would resolve against an ancient position.
		 * - otherwise: linear interpolation between the two bracketing records.
		 *
		 * @param {string} key
		 * @param {number} at
		 * @returns {{ x: number, y: number, state: any, fallback: boolean } | null}
		 */
		sample(key, at) {
			const r = rings.get(key);
			if (r === undefined || r.len === 0) return null;
			const newest = r.head;
			const tNew = r.t[newest];
			if (at >= tNew) return { x: r.x[newest], y: r.y[newest], state: r.st[newest], fallback: false };
			const oldest = (r.head - r.len + 1 + cap) % cap;
			if (tNew - at > maxRewindMs || at < r.t[oldest]) {
				return { x: r.x[newest], y: r.y[newest], state: r.st[newest], fallback: true };
			}
			// Scan newest -> oldest for the first record at or before `at` (the lower
			// bracket); its next-newer neighbour is the upper bracket.
			let lo = newest;
			for (let k = 0; k < r.len; k++) {
				const idx = (newest - k + cap) % cap;
				if (r.t[idx] <= at) {
					lo = idx;
					break;
				}
			}
			const hi = (lo + 1) % cap;
			// The upper bracket resumed after an absence: the entity was dead / removed
			// for the span between lo and hi, so it never occupied any point on the line
			// from lo to hi - a shot rewinding into that gap must miss, not hit a phantom
			// interpolated between a corpse and a respawn point.
			if (r.brk[hi]) return null;
			const ddx = r.x[hi] - r.x[lo];
			const ddy = r.y[hi] - r.y[lo];
			if (teleportSq !== Infinity && ddx * ddx + ddy * ddy > teleportSq) return null;
			const span = r.t[hi] - r.t[lo];
			const f = span > 0 ? (at - r.t[lo]) / span : 0;
			return { x: r.x[lo] + f * ddx, y: r.y[lo] + f * ddy, state: r.st[lo], fallback: false };
		},

		/**
		 * The rewound, candidate-gated world: every entity in `candidateKeys` that
		 * has a servable history, sampled to `at`. The caller (the shoot handler)
		 * passes the shooter's interest candidate set (minus self), so an entity
		 * the shooter never had replicated is never in the map (credo-5 default-deny:
		 * you cannot hit what was never sent to you). Entities omitted: no history,
		 * or a teleport-straddle (sample returned null).
		 *
		 * @param {Iterable<string>} candidateKeys
		 * @param {number} at
		 * @returns {Map<string, { x: number, y: number, state: any, fallback: boolean }>}
		 */
		rewind(candidateKeys, at) {
			const out = new Map();
			for (const key of candidateKeys) {
				const s = this.sample(key, at);
				if (s !== null) out.set(key, s);
			}
			return out;
		},

		/** Drop one entity's ring (its owner left). @param {string} key */
		remove(key) {
			rings.delete(key);
		},

		/** Drop every ring (topic teardown). */
		reset() {
			rings.clear();
		},

		/** Number of entities with a ring (tests / metrics). */
		get size() {
			return rings.size;
		}
	};
}

/**
 * Ray-vs-circle hit test for the declarative `hitbox: { shape: 'circle' }`. The
 * ray starts at (ox,oy) along the UNIT direction (dx,dy) up to maxDist. Returns
 * the nearest hit distance along the ray and the impact point, or null on a miss.
 * An origin inside the circle hits at distance 0.
 *
 * @param {number} ox @param {number} oy @param {number} dx @param {number} dy
 * @param {number} maxDist @param {number} cx @param {number} cy @param {number} radius
 * @returns {{ dist: number, point: { x: number, y: number } } | null}
 */
export function rayCircleHit(ox, oy, dx, dy, maxDist, cx, cy, radius) {
	const ocx = cx - ox;
	const ocy = cy - oy;
	const tca = ocx * dx + ocy * dy; // projection of centre onto the ray
	const d2 = ocx * ocx + ocy * ocy - tca * tca; // perpendicular distance squared
	const r2 = radius * radius;
	if (d2 > r2) return null;
	const thc = Math.sqrt(r2 - d2);
	let t = tca - thc; // first intersection along the ray
	if (t < 0) {
		// Origin is inside the circle (or the entry point is behind it); the exit
		// point tca+thc tells us whether the circle is ahead at all.
		if (tca + thc < 0) return null; // whole circle is behind the origin
		t = 0;
	}
	if (t > maxDist) return null;
	return { dist: t, point: { x: ox + dx * t, y: oy + dy * t } };
}

/**
 * Ray-vs-axis-aligned-box hit test for `hitbox: { shape: 'aabb', w, h }` (the
 * box is centred on the entity, full width w / height h). Slab method. Returns
 * the nearest entry distance along the ray and the impact point, or null.
 *
 * @param {number} ox @param {number} oy @param {number} dx @param {number} dy
 * @param {number} maxDist @param {number} cx @param {number} cy @param {number} w @param {number} h
 * @returns {{ dist: number, point: { x: number, y: number } } | null}
 */
export function rayAabbHit(ox, oy, dx, dy, maxDist, cx, cy, w, h) {
	const minX = cx - w / 2;
	const maxX = cx + w / 2;
	const minY = cy - h / 2;
	const maxY = cy + h / 2;
	let tmin = 0;
	let tmax = maxDist;
	// X slab
	if (dx !== 0) {
		const inv = 1 / dx;
		let t1 = (minX - ox) * inv;
		let t2 = (maxX - ox) * inv;
		if (t1 > t2) {
			const tmp = t1;
			t1 = t2;
			t2 = tmp;
		}
		tmin = t1 > tmin ? t1 : tmin;
		tmax = t2 < tmax ? t2 : tmax;
		if (tmin > tmax) return null;
	} else if (ox < minX || ox > maxX) {
		return null;
	}
	// Y slab
	if (dy !== 0) {
		const inv = 1 / dy;
		let t1 = (minY - oy) * inv;
		let t2 = (maxY - oy) * inv;
		if (t1 > t2) {
			const tmp = t1;
			t1 = t2;
			t2 = tmp;
		}
		tmin = t1 > tmin ? t1 : tmin;
		tmax = t2 < tmax ? t2 : tmax;
		if (tmin > tmax) return null;
	} else if (oy < minY || oy > maxY) {
		return null;
	}
	return { dist: tmin, point: { x: ox + dx * tmin, y: oy + dy * tmin } };
}
