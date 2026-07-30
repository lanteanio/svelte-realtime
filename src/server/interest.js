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
 * The adapter smoother's `targetDelay()`: twice the measured send interval, clamped
 * to [32, 250] ms. Kept byte-identical with that formula so the server's reach
 * estimate tracks the client's actual render delay. Exported for the cells-mode
 * shoot path, which has no per-subscriber send walk to measure - its fan-out
 * delivers every changed frame every tick, so this dense-path estimate applied
 * to the tick interval IS the cadence the client sees.
 * @param {number} intervalMs the (EWMA) interval between frames the client receives
 */
export function targetDelayMs(intervalMs) {
	const d = 2 * intervalMs;
	return d < 32 ? 32 : d > 250 ? 250 : d;
}

/**
 * Slew an applied estimate toward `target` the way the adapter smoother slews its
 * `appliedDelay`: rise to a wider delay AT ONCE (a newly-sparse cadence must never
 * clamp an honest shot short), but fall no faster than the client lowers its render
 * delay - about 3% of the elapsed wall time. The asymmetry is the point: it stops a
 * re-densifying target's reach from retracting AHEAD of the client and dropping
 * honest shots during the multi-second window the client takes to slew down.
 * @param {number} applied @param {number} target @param {number} elapsedMs
 */
function slewApplied(applied, target, elapsedMs) {
	if (target >= applied) return target;
	const floor = applied - elapsedMs * 0.03;
	return target > floor ? target : floor;
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
	// centerPolicy 'own-entity': the center precedence flips at every consumption
	// site - a positioned own entity beats a reported override, so an override
	// accepted while the connection was a spectator turns inert the moment it
	// owns an entity. The report-time gate lives in the smooth handler (it can
	// run the app callback); this flag is the always-on structural half.
	const ownFirst = interest.centerPolicy === 'own-entity';

	// Minimum center movement that owes a relevancy pass. A fraction of the
	// interest radius: below this the culled set cannot meaningfully change, so
	// recomputing it is pure cost. Scaling off the radius keeps it correct for
	// any world unit (pixels, metres, tiles) instead of guessing an absolute.
	const centerEpsilon = typeof radius === 'number' && radius > 0 ? radius / 64 : 0;
	const CENTER_EPSILON_SQ = centerEpsilon * centerEpsilon;

	// Persistent across ticks.
	/** @type {Map<string, { x: number, y: number }>} reported center override by identity */
	const centers = new Map();
	/**
	 * Per identity: the center the last relevancy pass was owed at, plus whether
	 * a revert-to-own-entity has already been accounted for. Separate from
	 * `centers` because it must survive `clearCenter` - see `reportCenter`.
	 * @type {Map<string, { x: number, y: number, cleared: boolean }>}
	 */
	const passCenters = new Map();
	/**
	 * Per identity: entity keys that left this subscriber's area of interest on
	 * the most recent `compute`. Populated per pass and read by the delivery
	 * layer, which sends each one a targeted `remove`.
	 * @type {Map<string, string[]>}
	 */
	const exits = new Map();
	/** @type {Map<string, Map<string, { band: number, sent: any }>>} per subscriber: entity key -> last LOD band + last-sent state */
	const lod = new Map();
	/**
	 * Per subscriber: the EWMA of the interval (ms) between REMOTE frames the server
	 * sends it (`ewma`), the last send stamp (`lastT`), and the slewed applied delay
	 * (`applied`) that tracks the adapter smoother's `appliedDelay`. Mirrors that
	 * estimator (same alpha, same out-of-range guard, same target + slew), so the
	 * server estimates each shooter's client-side interpolation delay - the buffering
	 * leg of the lag-comp reach - from a quantity it measures itself, the way it already
	 * measures the uplink leg. Populated only for a lag-compensated topic (the shoot
	 * handler is the sole reader).
	 * @type {Map<string, { lastT: number, ewma: number, applied: number }>}
	 */
	const sendCadence = new Map();
	/** @type {Map<string, Set<string>>} the last computed relevancy (the lag-comp candidate set) */
	let last = new Map();
	// The last tick's snapshot, retained so the lag-comp candidate broadphase
	// (candidatesAt) can query it between ticks: `lastN` positioned entries live in
	// `positions`/`keys`, and `lastUseIndex` says whether the spatial index holds
	// this snapshot's bins (built) or the flat path applies.
	let lastN = 0;
	let lastUseIndex = false;

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
	/** @type {number[]} empty always-visible list for candidatesAt (ring-less entities are never hit candidates) */
	const noAlwaysVisible = [];
	// Per-subscriber budget scratch (pooled; touched only when a delivery budget
	// is active for the subscriber, so the uncapped path allocates nothing). The
	// due banded entries collect here so an over-budget tick can trim the
	// farthest ones; parallel arrays keep the scan allocation-free.
	/** @type {string[]} */
	const dueKeys = [];
	/** @type {number[]} */
	const dueBand = [];
	/** @type {number[]} */
	const dueD2 = [];
	/** @type {number[]} previous band per due entry (-1 = first sight) */
	const duePrevBand = [];
	/** @type {any[]} previous last-sent state per due entry */
	const duePrevSent = [];
	/** @type {number[]} sortable index scratch for the over-budget trim */
	const dueOrder = [];
	/** Nearest-first order for the trim: band, then distance, then key (deterministic). */
	const dueCompare = (a, b) =>
		dueBand[a] - dueBand[b] || dueD2[a] - dueD2[b] || (dueKeys[a] < dueKeys[b] ? -1 : 1);

	/**
	 * Record a subscriber's reported area-of-interest center (the optional
	 * `smooth-center` client frame). Overrides the own-entity default until
	 * cleared. A non-finite report is ignored (the center stays whatever it was).
	 * Returns whether the effective center CHANGED, so the caller can skip
	 * forcing a relevancy pass for an identical re-report.
	 * @param {string} identity @param {number} x @param {number} y
	 * @returns {boolean}
	 */
	function reportCenter(identity, x, y) {
		if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
			// The stored override always tracks the latest report, so whenever the
			// next pass runs it culls from the true position.
			const c = centers.get(identity);
			if (c === undefined) centers.set(identity, { x, y });
			else { c.x = x; c.y = y; }
			// Only a move beyond the threshold OWES a pass. Exact equality alone is
			// not a defence: a subscriber alternating between two centers a
			// millimetre apart would force the full O(subscribers x entities)
			// relevancy pass every tick at ~800 bytes/s.
			//
			// The reference point lives in its OWN map, deliberately outliving
			// `clearCenter`. Keeping it inside the override entry made
			// report -> clear -> report a free bypass: each report hit the
			// "no entry yet" branch and owed a pass without the threshold ever
			// being consulted, so an attacker forced a pass per tick without
			// moving at all.
			const p = passCenters.get(identity);
			if (p === undefined) { passCenters.set(identity, { x, y, cleared: false }); return true; }
			const dx = x - p.x;
			const dy = y - p.y;
			// Measured from the center the last pass was owed at, not the previous
			// report, so a slow drift accumulates into a pass instead of being
			// thresholded away one step at a time.
			//
			// A sub-threshold report leaves `cleared` ALONE. Resetting it here would
			// re-arm the clear side of a report/clear oscillation, so the pair still
			// bought one pass per cycle for zero movement.
			if (dx * dx + dy * dy < CENTER_EPSILON_SQ) return false;
			p.x = x; p.y = y;
			p.cleared = false;
			return true;
		}
		return false;
	}

	/**
	 * Drop a subscriber's reported center, reverting it to the own-entity
	 * default. Returns whether an override was held AND the revert has not
	 * already been accounted for (false -> no relevancy pass is owed).
	 * @param {string} identity
	 * @returns {boolean}
	 */
	function clearCenter(identity) {
		if (!centers.delete(identity)) return false;
		// A repeated clear/report cycle must not owe a pass every time. The first
		// clear after a report is a genuine revert to the own-entity center and
		// owes one; a second clear with no intervening move does not.
		const p = passCenters.get(identity);
		if (p === undefined) return true;
		if (p.cleared) return false;
		p.cleared = true;
		return true;
	}

	/** Forget all state for a departed subscriber (called from the close path). */
	function releaseSubscriber(identity) {
		centers.delete(identity);
		passCenters.delete(identity);
		lod.delete(identity);
		sendCadence.delete(identity);
		// The last computed relevancy set is rebuilt every tick from live
		// subscribers, but a released identity's entry must not linger between
		// ticks (it holds the entity keys the subscriber was last shown).
		last.delete(identity);
	}

	/**
	 * Right-to-erasure purge: drop every identity-keyed trace this state holds
	 * for one subscriber - the reported center override (a literal user
	 * location), the LOD band memory, the send-cadence estimator, and the last
	 * relevancy set. Returns 1 when anything was held, for the forget cascade's
	 * per-surface count.
	 * @param {string} identity
	 * @returns {number}
	 */
	function purgeIdentity(identity) {
		const had = centers.has(identity) || lod.has(identity) || sendCadence.has(identity) || last.has(identity);
		releaseSubscriber(identity);
		return had ? 1 : 0;
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
	 * Resolve an entity's {x,y} for the join snapshot WITHOUT touching the pooled
	 * per-tick scratch: `resolvePosition` writes into `posPool`, whose objects the
	 * retained `positions` snapshot references between ticks (the candidatesAt
	 * broadphase reads it), so a join must never route through the pool. Same
	 * polarity otherwise - null on no position fn, a null/malformed result, or a
	 * throw (all treated as always-visible by the caller).
	 * @param {any} state
	 */
	function snapshotPosition(state) {
		if (positionFn === null) return null;
		let p;
		try { p = positionFn(state); } catch { return null; }
		if (p === null || p === undefined) return null;
		if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
		return p;
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
	 * When a delivery budget is active for a subscriber (`budgetOf` returns a
	 * finite count), at most that many BANDED entities are delivered to it this
	 * tick: the due set is trimmed farthest-first (band, then distance - the
	 * fringe demotes before the action around the player), and a trimmed entry's
	 * LOD record is reverted to its pre-tick value, so the entity stays due and
	 * delivers as soon as the budget frees - throttled, never lost. Always-visible
	 * entities and whole-board (uncentered) subscribers bypass the budget: the
	 * first are an explicit app statement, the second is the over-deliver safety
	 * polarity, and neither has a distance to trim by. The candidate membership
	 * (`getCandidates`) is untouched by a trim - an entity delivered earlier is
	 * still on the shooter's screen and stays hittable; one never delivered never
	 * entered the membership at all.
	 *
	 * @param {Array<{ key: string, state: any }>} catalog the authority catalog
	 * @param {Iterable<string>} subscribers the local subscriber identities
	 * @param {number} tick a monotonic integer tick counter (drives the LOD cadence)
	 * @param {(identity: string) => number | undefined} [budgetOf] the effective
	 *   per-subscriber delivery budget for this tick (already scaled by whatever
	 *   pressure signal the caller reads); a non-finite / undefined return means
	 *   uncapped. Kept as an injected read so this pass stays clock- and I/O-free.
	 * @returns {Map<string, Set<string>>} identity -> entity keys to deliver this tick
	 */
	function compute(catalog, subscribers, tick, budgetOf) {
		const budgeted = typeof budgetOf === 'function';
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
		else index.release(); // drop any stale bins from a prior indexed tick; the flat path reads positions directly

		const relevancy = new Map();
		// Per-subscriber range-exits for THIS pass, drained by the delivery layer.
		// Rebuilt every pass, so it can never outgrow the live subscriber set.
		exits.clear();
		subSet.clear();
		for (const identity of subscribers) {
			subSet.add(identity);

			// 3. Resolve the area-of-interest center: a reported override wins; else
			// the subscriber's own entity position (its entity key IS its identity). A
			// null center is whole-board: every entity is a candidate, uncapped, so an
			// uncentered subscriber (no own entity, no override) sees everything - the
			// unreported-viewport safety contract - still delta-gated so a static board
			// is not re-sent every tick. Under centerPolicy 'own-entity' the precedence
			// flips: a positioned own entity beats the override (the radar gate).
			let center;
			if (ownFirst) {
				const ownIdx = indexByKey.get(identity);
				center = ownIdx !== undefined ? positions[ownIdx] : null;
				if (center === null) center = centers.get(identity) ?? null;
			} else {
				center = centers.get(identity);
				if (center === undefined) {
					const ownIdx = indexByKey.get(identity);
					center = ownIdx !== undefined ? positions[ownIdx] : null;
				}
			}
			const wholeBoard = center === null || center === undefined;

			let lodForS = lod.get(identity);
			if (lodForS === undefined) { lodForS = new Map(); lod.set(identity, lodForS); }
			const relevant = new Set();
			seen.clear();
			// Resolve this subscriber's effective delivery budget once per tick.
			let cap = Infinity;
			if (budgeted) {
				const b = budgetOf(identity);
				if (typeof b === 'number' && Number.isFinite(b) && b >= 1) cap = Math.floor(b);
			}
			const capped = cap !== Infinity;
			let dueCount = 0;

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
				if (due) {
					relevant.add(key);
					if (capped) {
						// Record what the trim below needs: the sort keys (band, d2)
						// and the pre-tick LOD record to revert a trimmed entry to.
						dueKeys[dueCount] = key;
						dueBand[dueCount] = band;
						dueD2[dueCount] = d2;
						duePrevBand[dueCount] = prevBand;
						duePrevSent[dueCount] = prevSent;
						dueCount++;
					}
				}
				lodForS.set(key, { band, sent: due ? state : prevSent });
			}
			// Over budget: keep the `cap` nearest due entries (band, then distance,
			// then key - fully deterministic) and revert the rest to their pre-tick
			// LOD record, so a trimmed entity stays due and delivers when the budget
			// frees. A reverted first-sight entry is REMOVED (it was never delivered,
			// so it must not enter the candidate membership); a reverted known entry
			// keeps its old band, so a dropped band-crossing re-detects and delivers
			// promptly once there is room.
			if (capped && dueCount > cap) {
				dueOrder.length = dueCount;
				for (let i = 0; i < dueCount; i++) dueOrder[i] = i;
				dueOrder.sort(dueCompare);
				for (let i = cap; i < dueCount; i++) {
					const j = dueOrder[i];
					const key = dueKeys[j];
					relevant.delete(key);
					if (duePrevBand[j] < 0) lodForS.delete(key);
					else lodForS.set(key, { band: duePrevBand[j], sent: duePrevSent[j] });
				}
			}
			// Release the pooled state references so a departed entity's last state
			// is not retained by the scratch until the next capped tick.
			for (let i = 0; i < dueCount; i++) duePrevSent[i] = undefined;
			// Forget entities that left this subscriber's range, so a re-entry is a
			// fresh first-sight (delivered at once) and the map stays bounded by the
			// live in-range set rather than every entity ever seen.
			//
			// Record the exits too. Forgetting server-side is not enough: the client
			// drops a remote entity only on an explicit `remove` frame or its TTL
			// sweep, and interest-exit sent neither - so a subscriber panning across
			// a board kept accumulating entities it can no longer see, shedding them
			// only once the sweep caught up. The caller turns these into per-subscriber
			// `remove` frames so the release is immediate and deterministic.
			if (lodForS.size > seen.size) {
				let exited;
				for (const key of lodForS.keys()) {
					if (seen.has(key)) continue;
					lodForS.delete(key);
					// An entity that left the CATALOG (deleted, disconnected) already
					// gets a broadcast remove; only range-exits need a targeted one.
					if (indexByKey.has(key)) (exited ??= []).push(key);
				}
				if (exited !== undefined) exits.set(identity, exited);
			}
			relevancy.set(identity, relevant);
		}

		// 5. Forget state for subscribers that are gone - a backstop to the explicit
		// releaseSubscriber on close, so a missed release can never leak.
		for (const id of centers.keys()) if (!subSet.has(id)) centers.delete(id);
		// Same sweep for the threshold memory, which outlives an override.
		for (const id of passCenters.keys()) if (!subSet.has(id)) passCenters.delete(id);
		for (const id of lod.keys()) if (!subSet.has(id)) lod.delete(id);
		for (const id of sendCadence.keys()) if (!subSet.has(id)) sendCadence.delete(id);

		// Keep the index + positions queryable between ticks for the lag-comp candidate
		// broadphase (candidatesAt) - a shot resolves against this last-tick snapshot. The
		// next compute's build() (or the else-branch release above) frees the retained
		// bins, so nothing leaks.
		last = relevancy;
		lastN = n;
		lastUseIndex = useIndex;
		return relevancy;
	}

	return {
		reportCenter,
		clearCenter,
		releaseSubscriber,
		purgeIdentity,
		compute,
		/**
		 * Entity keys that left `identity`'s area of interest on the most recent
		 * `compute`, or undefined when none did. The delivery layer turns these
		 * into targeted `remove` frames so a subscriber releases an out-of-range
		 * entity immediately instead of waiting for the client's TTL sweep.
		 * @param {string} identity
		 * @returns {string[] | undefined}
		 */
		exitsFor(identity) { return exits.get(identity); },
		/**
		 * The join-snapshot roster for a syncing subscriber, scoped to its area of
		 * interest: the entities within the exact cull radius of its center (a
		 * reported override, else its own entity's position in `catalog`), every
		 * always-visible entity, and ALWAYS the subscriber's own entity - it is the
		 * client's reconciliation basis, so a far reported center (a free-cam
		 * spectator whose entity waits elsewhere) must never exclude it. A
		 * subscriber with no resolvable center gets the whole catalog, the same
		 * over-deliver polarity `compute` holds. LOD cadence does not apply (a join
		 * over-delivers all in-range state once). Reads only `catalog` and the
		 * reported centers - never the per-tick scratch - so it is safe on a cold
		 * join before the first compute and never perturbs the retained
		 * `candidatesAt` snapshot.
		 * @param {string} identity
		 * @param {Array<{ key: string, state: any }>} catalog
		 * @returns {Array<{ key: string, state: any }>}
		 */
		snapshotFor(identity, catalog) {
			// Same center precedence as compute: override first, own entity as the
			// fallback - flipped under centerPolicy 'own-entity'.
			const override = centers.get(identity);
			let center = ownFirst ? undefined : override;
			if (center === undefined) {
				for (let i = 0; i < catalog.length; i++) {
					if (catalog[i].key !== identity) continue;
					const p = snapshotPosition(catalog[i].state);
					if (p !== null) center = p;
					break;
				}
			}
			if (center === undefined && ownFirst) center = override;
			if (center === undefined) return catalog;
			const r2 = radius * radius;
			const out = [];
			for (let i = 0; i < catalog.length; i++) {
				const entry = catalog[i];
				if (entry.key === identity) {
					out.push(entry);
					continue;
				}
				const p = snapshotPosition(entry.state);
				if (p === null) {
					out.push(entry); // always-visible: everyone sees it
					continue;
				}
				const dx = p.x - center.x;
				const dy = p.y - center.y;
				if (dx * dx + dy * dy <= r2) out.push(entry);
			}
			return out;
		},
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
		/** The area-of-interest cull radius - the candidate-gate radius the shoot handler tests against. */
		get radius() {
			return radius;
		},
		/**
		 * The lag-compensation candidate broadphase: the entity keys whose LAST-TICK
		 * position lies within `queryRadius` of (cx, cy). The shoot handler queries a
		 * radius generously larger than the interest radius around the shooter's REWOUND
		 * position, recovering targets that have since left the receipt-time membership
		 * (the departed shell), then trims the result to the exact in-radius set at the
		 * rewind instant from the lag-comp ring. Reads the retained last-tick snapshot, so
		 * consume it synchronously within a tick window (the next compute overwrites it).
		 * Always-visible (ring-less) entities are excluded - a position-based shot cannot
		 * hit them. Returns a fresh array (empty before the first compute).
		 *
		 * @param {number} cx @param {number} cy @param {number} queryRadius
		 * @returns {string[]}
		 */
		candidatesAt(cx, cy, queryRadius) {
			const result = [];
			if (lastN === 0) return result;
			const idxs = lastUseIndex
				? index.cullIndexed(cx, cy, queryRadius, positions, lastN, noAlwaysVisible)
				: index.cullDirect(cx, cy, queryRadius, positions, lastN, noAlwaysVisible);
			for (let i = 0; i < idxs.length; i++) result.push(keys[idxs[i]]);
			return result;
		},
		/**
		 * Record that the server delivered a frame to `identity` at server stamp `t`,
		 * updating its send-interval EWMA. Call once per tick per delivered subscriber
		 * (a repeated `t` is a no-op via the d>0 guard). The EWMA seeds at `seedMs` (the
		 * tick interval - the densest possible cadence, since the server cannot send
		 * faster than it ticks), so a dense subscriber's estimate stays at the tick rate
		 * and only a sparsely-served subscriber's widens. Mirrors the adapter smoother's
		 * `ewmaIntervalMs` update (alpha 0.08, only an in-(0,2000)ms gap counts).
		 * @param {string} identity @param {number} t server stamp of the delivered frame
		 * @param {number} seedMs the tick interval (ms), the cold-start cadence
		 */
		noteSend(identity, t, seedMs) {
			let r = sendCadence.get(identity);
			if (r === undefined) {
				r = { lastT: -1, ewma: seedMs, applied: -1 };
				sendCadence.set(identity, r);
			}
			if (r.lastT < 0) {
				// First sight: snap the applied delay to the seed target (the adapter
				// smoother sets appliedDelay to the target on its first frame too).
				r.applied = targetDelayMs(r.ewma);
			} else {
				const elapsed = t - r.lastT;
				if (elapsed > 0) {
					// Slew toward the target the cadence implied OVER this interval (the EWMA
					// before this sample feeds it), then fold in the new interval - the same
					// order the smoother uses (render-slew toward the prevailing target, then
					// the arriving frame updates the interval estimate).
					r.applied = slewApplied(r.applied, targetDelayMs(r.ewma), elapsed);
					if (elapsed < 2000) r.ewma += 0.08 * (elapsed - r.ewma);
				}
			}
			if (t > r.lastT) r.lastT = t;
		},
		/**
		 * The estimated client-side interpolation delay (ms) for `identity`: the slewed
		 * applied delay tracking the adapter smoother's `appliedDelay` (rise at once,
		 * fall no faster than the client). The shoot handler adds this to the measured
		 * uplink to bound the rewind reach, so a sparsely-served shooter (which
		 * legitimately renders further in the past) is not clamped short, and a
		 * re-densifying one is not clamped short during the client's slew-down. `now`
		 * (the shot stamp) continues the slew since the last send; omit it to read the
		 * value as of the last send. An unknown subscriber falls back to `seedMs` (the
		 * tick rate), the dense-path estimate.
		 * @param {string} identity @param {number} seedMs the tick interval (ms)
		 * @param {number} [now] the shot wall stamp, to continue the slew to the present
		 * @returns {number}
		 */
		interpDelayMs(identity, seedMs, now) {
			const r = sendCadence.get(identity);
			if (r === undefined || r.applied < 0) return targetDelayMs(seedMs);
			const elapsed = now - r.lastT;
			if (elapsed > 0) return slewApplied(r.applied, targetDelayMs(r.ewma), elapsed);
			return r.applied;
		},
		/** Drop every center, band record, cadence, and the spatial scratch (topic teardown). */
		reset() {
			centers.clear();
			lod.clear();
			sendCadence.clear();
			last = new Map();
			lastN = 0;
			lastUseIndex = false;
			index.reset();
		}
	};
}
