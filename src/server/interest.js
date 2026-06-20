// @ts-check
//
// Area-of-interest relevancy for `live.smooth`: the per-tick preprocessing pass
// that decides, for each subscriber, which entities are relevant enough to
// deliver this tick. It turns the transient spatial grid (./spatial.js) into the
// relation the publish loop consumes - `Map<identity, Set<entityKey>>` - so an
// uncapped lobby does not broadcast every entity to every client.
//
// Per subscriber: resolve the area-of-interest center (a reported override, else
// the subscriber's own entity position), cull the catalog to the entities within
// `radius` (distance-SQUARED), then assign each in-range entity a level-of-detail
// band by distance and decide whether it is "due" on this tick. Near entities
// send every tick; fringe entities send at a throttled, id-staggered cadence so
// they fade rather than pop. An entity newly in range, or one that just crossed a
// band edge, is always due that tick (no perceptible omission on entry; a prompt
// transition on a ring crossing).
//
// The result is subscriber-keyed: the same relation lag compensation will later
// read as the shooter's candidate set (you cannot hit what you were never sent),
// and the publish loop inverts it transiently per update. Everything here is
// reached only when a topic opts into `interest`; a topic without it never
// constructs an interest state, so the broadcast-all hot path is untouched.
//
// Safety polarity is OVER-deliver: a subscriber with no resolvable center (no
// own entity and no reported override) is delivered the whole board, the same
// contract the cursor culler holds for an unreported viewport. Relevancy is a
// delivery preference, never an authorization boundary - the topic guard stays
// the separate auth layer.
//
// Determinism: no clock and no RNG. The throttle cadence is a function of an
// integer tick counter the caller owns; the per-entity stagger is a stable hash
// of the entity key. Only integer / Math arithmetic, so the determinism harness
// stays clean. Zero steady-state allocation in the catalog scan (the position
// objects, key buffer, and per-subscriber tracking are reused across ticks); the
// per-subscriber relevancy Set is the one deliberate per-tick allocation (a
// stable snapshot the publish loop and a future lag-comp reader can both hold).

import { createSpatialIndex, INDEX_CROSSOVER } from './spatial.js';

/**
 * Hysteresis margin as a fraction of the band-boundary radius it guards. An
 * entity already in a band only moves to a neighbouring band once it crosses
 * that boundary by this fraction of the boundary's own radius, so an entity
 * hovering on a ring does not flip bands (and its send-rate does not oscillate)
 * tick to tick. Tied to the boundary radius - not the band width - so a wide
 * outer band does not blow the margin out to a useless size.
 */
const HYSTERESIS_FRACTION = 0.1;

/** FNV-1a hash of a key, for the per-entity send-cadence stagger (determinism-clean). */
function hashKey(key) {
	let h = 2166136261;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/**
 * Normalize an interest config's level-of-detail bands into the squared edges
 * and send-rates the per-tick cull reads. Without an explicit `lod`, one band
 * spans the whole radius at rate 1 (every entity in range, every tick - a
 * distance-only cull). The outer band's edge is clamped to the cull radius so
 * the bands always partition exactly [0, radius].
 *
 * Returns, per band index: `edge2` (squared outer edge, the raw-band test),
 * `rate` (send every N ticks), `outBound2` (squared move-out threshold = edge +
 * margin) and `inBound2` (squared move-in threshold = inner edge - margin) for
 * the hysteresis comparison.
 * @param {{ radius: number, lod?: Array<{ within: number, rate: number }> }} interest
 */
function normalizeBands(interest) {
	const radius = interest.radius;
	const src = Array.isArray(interest.lod) && interest.lod.length
		? interest.lod.slice().sort((a, b) => a.within - b.within)
		: [{ within: radius, rate: 1 }];
	const count = src.length;
	const edge = new Array(count);
	const edge2 = new Array(count);
	const rate = new Array(count);
	const outBound2 = new Array(count);
	const inBound2 = new Array(count);
	for (let i = 0; i < count; i++) {
		const within = i === count - 1 ? radius : Math.min(src[i].within, radius);
		edge[i] = within;
		edge2[i] = within * within;
		rate[i] = src[i].rate >= 1 ? Math.floor(src[i].rate) : 1;
		// Move OUT of band i: cross its own outer edge by that edge's margin.
		const out = within * (1 + HYSTERESIS_FRACTION);
		outBound2[i] = out * out;
		// Move IN out of band i: drop below its inner edge (band i-1's outer edge)
		// by that edge's margin. Band 0 has no inner edge, so no inward threshold.
		const innerEdge = i > 0 ? edge[i - 1] : 0;
		const inThresh = innerEdge * (1 - HYSTERESIS_FRACTION);
		inBound2[i] = inThresh > 0 ? inThresh * inThresh : 0;
	}
	return { edge2, rate, outBound2, inBound2, count };
}

/**
 * Resolve the level-of-detail band for a distance-squared, applying hysteresis
 * against the band the entity occupied last tick. The raw band is the innermost
 * whose squared outer edge still contains the distance; an entity already in a
 * band stays there until it crosses that band's edge by the margin (outward) or
 * its inner edge by the margin (inward).
 * @param {{ edge2: number[], outBound2: number[], inBound2: number[], count: number }} bands
 * @param {number} d2 @param {number} prev previous band, or -1 on first sight
 */
function bandFor(bands, d2, prev) {
	let raw = 0;
	while (raw < bands.count - 1 && d2 > bands.edge2[raw]) raw++;
	if (prev < 0 || prev >= bands.count) return raw;
	if (raw === prev) return prev;
	if (raw > prev) {
		// Wants a farther band: only move once past this band's outer edge + margin.
		return d2 > bands.outBound2[prev] ? raw : prev;
	}
	// Wants a nearer band: only move once past this band's inner edge - margin.
	return d2 < bands.inBound2[prev] ? raw : prev;
}

/**
 * Create the per-topic interest state for a smooth topic that opted into
 * `interest`. Owns the spatial index, the reported-center overrides, and the
 * per-(subscriber, entity) last-band tracking that drives the LOD cadence and
 * hysteresis. The publish loop calls `compute` once per tick.
 *
 * @param {{
 *   radius: number,
 *   position?: (state: any) => ({ x: number, y: number } | null),
 *   lod?: Array<{ within: number, rate: number }>,
 *   cell?: number
 * }} interest the (already-validated) interest config off `live.smooth`.
 */
export function createInterestState(interest) {
	const positionFn = typeof interest.position === 'function' ? interest.position : null;
	const radius = interest.radius;
	const bands = normalizeBands(interest);
	const index = createSpatialIndex(interest.cell !== undefined ? { cell: interest.cell } : undefined);

	// Persistent across ticks.
	/** @type {Map<string, { x: number, y: number }>} reported center override by identity */
	const centers = new Map();
	/** @type {Map<string, Map<string, { band: number, sent: any }>>} per subscriber: entity key -> last LOD band + last-sent state */
	const lod = new Map();
	/** @type {Map<string, Set<string>>} the last computed relevancy (the lag-comp candidate set) */
	let last = new Map();

	// Per-tick scratch (reused; no steady-state allocation in the catalog scan).
	/** @type {Array<{ x: number, y: number } | null>} resolved position per catalog index */
	const positions = [];
	/** @type {Array<{ x: number, y: number }>} pooled position objects, reused each tick */
	const posPool = [];
	/** @type {string[]} entity key per catalog index */
	const keys = [];
	/** @type {number[]} stable key hash per catalog index (computed once, reused per subscriber) */
	const hashes = [];
	/** @type {number[]} catalog indices with a null (always-visible) position */
	const alwaysVisible = [];
	/** @type {Map<string, number>} entity key -> catalog index, for own-center lookup */
	const indexByKey = new Map();
	/** @type {Set<string>} scratch: entities a subscriber saw this tick (for the LOD prune) */
	const seen = new Set();
	/** @type {Set<string>} scratch: current subscriber identities (for the departed-subscriber prune) */
	const subSet = new Set();

	/**
	 * Record a subscriber's reported area-of-interest center (the optional
	 * `smooth-center` client frame). Overrides the own-entity default until
	 * cleared. A non-finite report is ignored (the center stays whatever it was).
	 * @param {string} identity @param {number} x @param {number} y
	 */
	function reportCenter(identity, x, y) {
		if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
			let c = centers.get(identity);
			if (c === undefined) { centers.set(identity, { x, y }); }
			else { c.x = x; c.y = y; }
		}
	}

	/** Drop a subscriber's reported center, reverting it to the own-entity default. */
	function clearCenter(identity) {
		centers.delete(identity);
	}

	/** Forget all state for a departed subscriber (called from the close path). */
	function releaseSubscriber(identity) {
		centers.delete(identity);
		lod.delete(identity);
	}

	/**
	 * Resolve an entity's {x,y} via the app's position fn into the pooled slot for
	 * catalog index `i`, or null when there is no position fn, the fn returns
	 * null/undefined, the result is not a finite pair, OR the fn throws. A null
	 * position is always-visible: treating a thrown or malformed position as
	 * always-visible over-delivers (the safe polarity) rather than letting one bad
	 * entity's position() escape and abort the whole tick.
	 * @param {any} state @param {number} i
	 */
	function resolvePosition(state, i) {
		if (positionFn === null) return null;
		let p;
		try { p = positionFn(state); } catch { return null; }
		if (p === null || p === undefined) return null;
		const x = p.x, y = p.y;
		if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
		let pooled = posPool[i];
		if (pooled === undefined) { pooled = { x: 0, y: 0 }; posPool[i] = pooled; }
		pooled.x = x; pooled.y = y;
		return pooled;
	}

	/**
	 * The per-tick relevancy pass. For every subscriber, produce the set of entity
	 * keys whose CURRENT state it should be delivered this tick: an entity inside
	 * the subscriber's area of interest whose state changed since it was last
	 * delivered to that subscriber (so a stationary entity already in hand is never
	 * re-sent), throttled by the LOD cadence for the fringe bands, and ALWAYS on the
	 * first tick the entity is in range - so an entity a subscriber moves toward is
	 * caught up to its current state at once, even when that entity produced no
	 * update of its own this tick.
	 *
	 * The change test is `state !== lastDelivered`: the authority hands back a new
	 * state object only when an entity actually moved, and keeps the same reference
	 * otherwise, so reference identity is the "did it move since I last saw it" test.
	 * Because the decision is against the last DELIVERED state (not the last tick),
	 * a fringe entity's motion accumulated across throttled ticks is flushed on its
	 * next due tick whether or not it happened to move on that exact tick.
	 *
	 * @param {Array<{ key: string, state: any }>} catalog the authority catalog
	 * @param {Iterable<string>} subscribers the local subscriber identities
	 * @param {number} tick a monotonic integer tick counter (drives the LOD cadence)
	 * @returns {Map<string, Set<string>>} identity -> entity keys to deliver this tick
	 */
	function compute(catalog, subscribers, tick) {
		const n = catalog.length;

		// 1. Resolve every entity's position once; collect the always-visible ones.
		alwaysVisible.length = 0;
		indexByKey.clear();
		for (let i = 0; i < n; i++) {
			const entry = catalog[i];
			keys[i] = entry.key;
			hashes[i] = hashKey(entry.key);
			indexByKey.set(entry.key, i);
			positions[i] = resolvePosition(entry.state, i);
			if (positions[i] === null) alwaysVisible.push(i);
		}

		// 2. Build the index only past the crossover; below it a flat scan is cheaper.
		const useIndex = n > INDEX_CROSSOVER;
		if (useIndex) index.build(positions, n);

		const relevancy = new Map();
		subSet.clear();
		for (const identity of subscribers) {
			subSet.add(identity);

			// 3. Resolve the area-of-interest center: a reported override wins; else
			// the subscriber's own entity position (its entity key IS its identity). A
			// null center is whole-board: every entity is a candidate, uncapped, so an
			// uncentered subscriber (no own entity, no override) sees everything - the
			// unreported-viewport safety contract - still delta-gated so a static board
			// is not re-sent every tick.
			let center = centers.get(identity);
			if (center === undefined) {
				const ownIdx = indexByKey.get(identity);
				center = ownIdx !== undefined ? positions[ownIdx] : null;
			}
			const wholeBoard = center === null || center === undefined;

			let lodForS = lod.get(identity);
			if (lodForS === undefined) { lodForS = new Map(); lod.set(identity, lodForS); }
			const relevant = new Set();
			seen.clear();

			// 4. The candidate set is the in-radius cull when centered, or every entity
			// when whole-board. Each candidate is delivered only when its state changed
			// since this subscriber last received it (or it is newly in range), and -
			// for a fringe band - only on its throttled, id-staggered slot.
			const cand = wholeBoard
				? null
				: (useIndex
					? index.cullIndexed(center.x, center.y, radius, positions, n, alwaysVisible)
					: index.cullDirect(center.x, center.y, radius, positions, n, alwaysVisible));
			const count = wholeBoard ? n : /** @type {number[]} */ (cand).length;
			for (let c = 0; c < count; c++) {
				const idx = wholeBoard ? c : /** @type {number[]} */ (cand)[c];
				const key = keys[idx];
				const pos = positions[idx];
				const state = catalog[idx].state;
				const prev = lodForS.get(key);
				const prevSent = prev === undefined ? undefined : prev.sent;
				const changed = state !== prevSent; // undefined (first sight) => changed
				seen.add(key);
				if (pos === null || wholeBoard) {
					// Always-visible, or any entity for an uncentered subscriber: band 0,
					// delivered on every change (no distance throttle).
					if (changed) relevant.add(key);
					lodForS.set(key, { band: 0, sent: changed ? state : prevSent });
					continue;
				}
				const dx = pos.x - center.x;
				const dy = pos.y - center.y;
				const d2 = dx * dx + dy * dy;
				const prevBand = prev === undefined ? -1 : prev.band;
				const band = bandFor(bands, d2, prevBand);
				const rate = bands.rate[band];
				// The cadence allows a send: on first sight, on a band crossing (deliver
				// the transition promptly), every tick for the innermost band, else on
				// the entity's id-staggered slot within the band's period. An entity is
				// delivered only when the cadence allows AND its state actually changed,
				// so a stationary in-range entity is never re-sent.
				const cadence = prevBand < 0 || band !== prevBand || rate <= 1 || tick % rate === hashes[idx] % rate;
				const due = changed && cadence;
				if (due) relevant.add(key);
				lodForS.set(key, { band, sent: due ? state : prevSent });
			}
			// Forget entities that left this subscriber's range, so a re-entry is a
			// fresh first-sight (delivered at once) and the map stays bounded by the
			// live in-range set rather than every entity ever seen.
			if (lodForS.size > seen.size) {
				for (const key of lodForS.keys()) if (!seen.has(key)) lodForS.delete(key);
			}
			relevancy.set(identity, relevant);
		}

		// 5. Forget state for subscribers that are gone - a backstop to the explicit
		// releaseSubscriber on close, so a missed release can never leak.
		for (const id of centers.keys()) if (!subSet.has(id)) centers.delete(id);
		for (const id of lod.keys()) if (!subSet.has(id)) lod.delete(id);

		if (useIndex) index.release();
		last = relevancy;
		return relevancy;
	}

	return {
		reportCenter,
		clearCenter,
		releaseSubscriber,
		compute,
		/**
		 * The most recent per-subscriber relevancy: identity -> the entity keys
		 * DELIVERED this tick. Each Set is owned per subscriber (not shared), so a
		 * reader may hold it. This is the delivery delta, NOT the candidate set -
		 * a stationary in-range entity is absent here on the ticks it does not move.
		 * For the lag-compensation candidate set ("what the shooter currently has
		 * replicated", the full in-range membership) use `getCandidates`.
		 */
		get relevancy() {
			return last;
		},
		/**
		 * The shooter's hit-candidate set for lag compensation: the entity keys this
		 * subscriber currently has replicated - the full in-range membership (pruned
		 * to the live in-range set each tick), NOT just this tick's delivered deltas.
		 * The transmit-bit analog: you cannot rewind/hit an entity that was never
		 * sent to you. Returns the live keyset (consume it synchronously within the
		 * tick - the next compute() mutates it) or undefined when the subscriber is
		 * unknown (never reported a center and owns no in-range entity yet).
		 * @param {string} identity
		 * @returns {IterableIterator<string> | undefined}
		 */
		getCandidates(identity) {
			const m = lod.get(identity);
			return m ? m.keys() : undefined;
		},
		/** Drop every center, band record, and the spatial scratch (topic teardown). */
		reset() {
			centers.clear();
			lod.clear();
			last = new Map();
			index.reset();
		}
	};
}
