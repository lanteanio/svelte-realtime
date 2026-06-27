import { createSharedRandom } from 'svelte-adapter-uws/plugins/smooth/random';
import { _IS_DEV } from './env.js';

/**
 * Privacy layer for `live.aggregate({ privacy })`: k-anonymity suppression plus
 * differential-privacy noise on the published aggregate.
 *
 * Two protections, composable via `strategy`:
 *
 * - k-anonymity (`suppress` / `hybrid`): an aggregate is not published until at
 *   least `k` DISTINCT contributors have fed the window. Below the threshold the
 *   last published value is HELD (the topic stays at its previous state) - never
 *   a null or an explicit marker, because "the cohort just dropped below k" is
 *   itself the side-channel k-anonymity exists to close.
 *
 * - differential privacy (`perturb` / `hybrid`): zero-mean Laplace or Gaussian
 *   noise is added to each numeric aggregate field. The noise is drawn from a
 *   generator SEEDED by `hash(tenantId, topic, windowStart)` - deterministic, so
 *   every cluster replica (which each compute the full aggregate over the source
 *   firehose) emits IDENTICAL noise; a per-node random offset would let a client
 *   that reconnects to another node difference the two values and recover the
 *   truth, and would itself be a node fingerprint. The seed refreshes per
 *   tumbling boundary and per sliding slide so each window draws fresh noise;
 *   lifetime and single-state aggregates have no boundary, so their offset stays
 *   constant (see KNOWN LIMITATION).
 *
 * KNOWN LIMITATION (documented; the sequential-composition accountant is a
 * deferred follow-up): within one window the noise offset is constant, so an
 * observer watching a live-updating aggregate sees exact deltas between updates.
 * Proper continual-observation DP (tree-based) costs more noise and is out of
 * scope for the first cut. Per-aggregate epsilon is independent; correlated
 * aggregates over one source are additively de-anonymizing - surface epsilon in
 * the audit and budget across aggregates at the application layer.
 *
 * The generator is the adapter's deterministic mulberry32 (`createSharedRandom`,
 * pure 32-bit integer arithmetic, no global RNG and no clock) so the noise is
 * reproducible under deterministic simulation.
 */

const DEFAULTS = { k: 5, epsilon: 1.0, delta: 1e-5, sensitivity: 1, noise: 'laplace', strategy: 'hybrid' };

/**
 * Validate and normalize a `privacy` config at aggregate-declaration time so a
 * bad shape throws once, not on every publish. Returns the normalized config
 * (defaults filled), or null when privacy is not configured.
 *
 * @param {any} privacy
 * @param {string} label - aggregate topic, for error messages
 * @returns {null | { k: number, epsilon: number, delta: number, sensitivity: number, noise: 'laplace' | 'gaussian', strategy: 'suppress' | 'perturb' | 'hybrid', contributor: ((data: any) => any) | null, fields: string[] | null }}
 */
export function _normalizeAggregatePrivacy(privacy, label) {
	if (privacy == null) return null;
	if (typeof privacy !== 'object') {
		throw new Error(`[svelte-realtime] live.aggregate '${label}': privacy must be an object { k, epsilon, strategy, noise, contributor, ... }`);
	}
	const cfg = { ...DEFAULTS, contributor: null, fields: null };
	if (privacy.strategy !== undefined) {
		if (privacy.strategy !== 'suppress' && privacy.strategy !== 'perturb' && privacy.strategy !== 'hybrid') {
			throw new Error(`[svelte-realtime] live.aggregate '${label}': privacy.strategy must be 'suppress', 'perturb', or 'hybrid'`);
		}
		cfg.strategy = privacy.strategy;
	}
	if (privacy.noise !== undefined) {
		if (privacy.noise !== 'laplace' && privacy.noise !== 'gaussian') {
			throw new Error(`[svelte-realtime] live.aggregate '${label}': privacy.noise must be 'laplace' or 'gaussian'`);
		}
		cfg.noise = privacy.noise;
	}
	for (const num of ['k', 'epsilon', 'delta', 'sensitivity']) {
		if (privacy[num] !== undefined) {
			const v = privacy[num];
			if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
				throw new Error(`[svelte-realtime] live.aggregate '${label}': privacy.${num} must be a positive finite number`);
			}
			cfg[num] = v;
		}
	}
	// delta is a probability for the Gaussian mechanism; sigma = sqrt(2 ln(1.25/delta))
	// goes imaginary (NaN) once delta >= 1.25, so reject delta >= 1 (it should be tiny).
	if (cfg.delta >= 1) {
		throw new Error(`[svelte-realtime] live.aggregate '${label}': privacy.delta must be < 1 (a probability for the Gaussian mechanism, typically very small e.g. 1e-5)`);
	}
	if (privacy.contributor !== undefined) {
		if (typeof privacy.contributor !== 'function') {
			throw new Error(`[svelte-realtime] live.aggregate '${label}': privacy.contributor must be a function (data) => id`);
		}
		cfg.contributor = privacy.contributor;
	}
	if (privacy.fields !== undefined) {
		if (!Array.isArray(privacy.fields) || privacy.fields.some((f) => typeof f !== 'string')) {
			throw new Error(`[svelte-realtime] live.aggregate '${label}': privacy.fields must be an array of field names`);
		}
		// Stable draw order: a fixed field order keeps each field's noise draw
		// reproducible across publishes (field i always takes draw i).
		cfg.fields = [...privacy.fields].sort();
	}
	// k-anonymity needs to count distinct contributors; without an extractor it
	// cannot, so a suppress/hybrid strategy requires one.
	if ((cfg.strategy === 'suppress' || cfg.strategy === 'hybrid') && !cfg.contributor) {
		throw new Error(`[svelte-realtime] live.aggregate '${label}': privacy.strategy '${cfg.strategy}' requires privacy.contributor (data) => id to count the k-anonymity cohort. Use strategy 'perturb' for noise-only.`);
	}
	return cfg;
}

/**
 * 32-bit FNV-1a hash of a string -> an unsigned int seed for the generator.
 * @param {string} str
 */
function _hashSeed(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** Zero-mean Laplace draw with scale b. inverse-CDF over one uniform draw. */
function _laplace(gen, b) {
	const u = gen.float() - 0.5;
	// Clamp the inverse-CDF argument away from 0: a draw of exactly 0 (the only
	// value where 1 - 2|u| = 0, probability ~2^-32) would give log(0) = -Infinity.
	// The clamp caps the tail at a large-but-finite value instead.
	const arg = Math.max(1 - 2 * Math.abs(u), 1e-12);
	return -b * Math.sign(u) * Math.log(arg);
}

/** Zero-mean Gaussian draw with std sigma. Box-Muller over two uniform draws. */
function _gaussian(gen, sigma) {
	// Guard u1 away from 0 so log is finite.
	const u1 = 1 - gen.float();
	const u2 = gen.float();
	return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Apply the privacy layer to a freshly computed aggregate state.
 *
 * @param {Record<string, any>} computed - the reduced aggregate (compute() applied)
 * @param {number} cohortSize - distinct contributors observed for this window
 * @param {string} seedStr - `${tenantId} ${topic} ${windowStart}` (stable per replica + per window; tenantId is '' under the global-aggregate model)
 * @param {{ k: number, epsilon: number, delta: number, sensitivity: number, noise: 'laplace' | 'gaussian', strategy: string, fields: string[] | null }} cfg
 * @returns {{ suppress: true } | { suppress: false, value: Record<string, any> }}
 */
export function _applyAggregatePrivacy(computed, cohortSize, seedStr, cfg) {
	if (cfg.strategy !== 'perturb' && cohortSize < cfg.k) {
		// Below k: hold the last value. Never emit null / a marker - that leaks
		// the sub-threshold transition k-anonymity is meant to hide.
		return { suppress: true };
	}
	if (cfg.strategy === 'suppress') {
		return { suppress: false, value: computed };
	}
	if (!computed || typeof computed !== 'object') {
		return { suppress: false, value: computed };
	}
	const gen = createSharedRandom(_hashSeed(seedStr));
	const scale = cfg.noise === 'gaussian'
		? Math.sqrt(2 * Math.log(1.25 / cfg.delta)) * cfg.sensitivity / cfg.epsilon
		: cfg.sensitivity / cfg.epsilon;
	const sample = cfg.noise === 'gaussian' ? _gaussian : _laplace;
	const out = Array.isArray(computed) ? computed.slice() : { ...computed };
	const fields = cfg.fields || Object.keys(out).sort();
	for (const f of fields) {
		if (typeof out[f] === 'number' && Number.isFinite(out[f])) {
			out[f] = out[f] + sample(gen, scale);
		}
	}
	return { suppress: false, value: out };
}

/**
 * Gate one aggregate publish through the privacy layer. `holder` is the
 * single-state aggregate entry or a per-window state; it carries `privacy`
 * (normalized config), the cohort (a `cohort` Set, or `bucketCohorts` for a
 * sliding window), `_windowStart` (the seed boundary), and `_lastWire` (updated
 * to the last value that passed the gate so the initial-load loader and a
 * held-suppression both return a gated value, never the live below-k state).
 *
 * @param {any} holder
 * @param {Record<string, any>} computed
 * @param {string} topic
 * @returns {{ publish: false } | { publish: true, value: Record<string, any> }}
 */
export function _gateAggregate(holder, computed, topic) {
	const cfg = holder.privacy;
	if (!cfg) return { publish: true, value: computed };
	let cohortSize;
	if (cfg.strategy === 'perturb') {
		cohortSize = Number.POSITIVE_INFINITY; // noise-only never suppresses
	} else if (holder.bucketCohorts) {
		// Sliding window: distinct contributors across the active buckets.
		const u = new Set();
		for (const bc of holder.bucketCohorts) { if (bc) for (const c of bc) u.add(c); }
		cohortSize = u.size;
	} else {
		cohortSize = holder.cohort ? holder.cohort.size : 0;
	}
	// NUL-joined so distinct (tenantId, topic, windowStart) triples cannot collide
	// into the same seed (topics/ids never contain NUL). tenantId is '' under the
	// global-aggregate model (aggregates are one entry per topic, already
	// tenant-distinct upstream); the slot is reserved for future per-tenant identity.
	const seedStr = (holder._tenantId || '') + ' ' + topic + ' ' + (holder._windowStart || 0);
	const r = _applyAggregatePrivacy(computed, cohortSize, seedStr, cfg);
	if (r.suppress) return { publish: false };
	holder._lastWire = r.value;
	return { publish: true, value: r.value };
}

/** Dev-warn dedup: one-shot when a contributor returns no id. */
let _contributorWarned = false;

/**
 * Add a contributor id to a k-anonymity cohort Set, bounded and fail-soft:
 *
 * - A null/undefined id (a buggy `contributor`) cannot count toward k; warn once
 *   in dev (such events would otherwise collapse to one cohort entry, leaving the
 *   aggregate permanently suppressed) and skip it.
 * - Stop growing the Set once it holds `k` distinct contributors: the gate only
 *   asks `size >= k`, so retaining more wastes unbounded memory on a
 *   high-cardinality contributor (a lifetime / single-state cohort never resets).
 *   This bounds every cohort Set at O(k).
 *
 * @param {Set<any>} set
 * @param {any} id
 * @param {number} k
 */
export function _cohortAdd(set, id, k) {
	if (id == null) {
		if (_IS_DEV && !_contributorWarned) {
			_contributorWarned = true;
			console.warn(
				'[svelte-realtime] live.aggregate privacy.contributor returned null/undefined; ' +
				'k-anonymity cannot count this contributor, so the aggregate may stay suppressed. ' +
				'Return a stable id (e.g. a user id) from contributor(data).'
			);
		}
		return;
	}
	if (set.size < k) set.add(id);
}
