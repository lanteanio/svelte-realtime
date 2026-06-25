// @ts-check
// Admin / observability snapshot of the server's live dispatch state. A pure,
// PII-free read over the already-exported in-memory registries: counts and code
// structure (handler paths + kinds), never user identifiers, never presence
// rosters. The auth-gated `/__realtime` admin route (added separately) serves
// this behind a mandatory, fail-closed gate; the primitive is useful standalone -
// log it, feed a dashboard, or expose it behind your own authorization.

import {
	registry,
	_topicWsCounts,
	cronRegistry,
	derivedRegistry,
	effectRegistry,
	aggregateRegistry,
	_watchedTopics,
	_rateLimits,
	_presenceRef,
	_lazyQueue,
	state
} from './state.js';
import { _pushRegistry, _pushSessionRegistry } from './push.js';
import { _throttles, _debounces } from './publish-helpers.js';
import { _tenantConfigRegistry } from './tenant.js';
import { _isShuttingDown, inFlightCount } from './lifecycle.js';
import { _cronIntrospect } from './cron-engine.js';

/**
 * Walk the handler registry into a per-kind breakdown. Base kinds are mutually
 * exclusive; the modifier flags overlay (a stream can be deprecated AND rate-
 * limited). A lazy loader carries no markers until it resolves, so it is counted
 * as `lazy` and not otherwise classified.
 * @param {boolean} withPaths
 */
function _classifyHandlers(withPaths) {
	const byKind = { rpc: 0, stream: 0, channel: 0, upload: 0, binary: 0, lazy: 0 };
	const modifiers = { deprecated: 0, rateLimited: 0, idempotent: 0, volatile: 0 };
	const paths = withPaths ? [] : null;
	for (const [path, fn] of registry) {
		const f = /** @type {any} */ (fn);
		if (withPaths) paths.push(path);
		if (f.__lazy) { byKind.lazy++; continue; }
		if (f.__isUpload) byKind.upload++;
		else if (f.__isChannel) byKind.channel++;
		else if (f.__isStream) byKind.stream++;
		else if (f.__isBinary) byKind.binary++;
		else byKind.rpc++;
		if (f.__deprecated) modifiers.deprecated++;
		if (f.__isRateLimited) modifiers.rateLimited++;
		if (f.__isIdempotent) modifiers.idempotent++;
		if (f.__volatileRpc) modifiers.volatile++;
	}
	/** @type {any} */
	const out = { total: registry.size, byKind, modifiers };
	if (paths) out.paths = paths.sort();
	return out;
}

/**
 * Sum each topic's subscriber Set, optionally with the top 20 topics by
 * subscriber count. Topic names are opt-in (they can embed ids).
 * @param {boolean} withTop
 */
function _topicSnapshot(withTop) {
	let subscribers = 0;
	const rows = withTop ? [] : null;
	for (const [topic, set] of _topicWsCounts) {
		const n = set ? set.size : 0;
		subscribers += n;
		if (rows) rows.push({ topic, subscribers: n });
	}
	/** @type {any} */
	const out = { active: _topicWsCounts.size, subscribers };
	if (rows) out.top = rows.sort((a, b) => b.subscribers - a.subscribers).slice(0, 20);
	return out;
}

/**
 * A structured, PII-free snapshot of the server's live dispatch state. Counts
 * and code structure only - no user identifiers, no presence rosters. Pure read
 * (no mutation); each section is independently safe. By default the handler
 * paths and topic names are omitted (counts only); opt into them with
 * `{ handlers: true }` (registered paths - code structure) and `{ topics: true }`
 * (the top 20 topics by subscriber count - names can embed ids, so opt-in).
 *
 * @param {{ handlers?: boolean, topics?: boolean }} [options]
 * @returns {object} the introspection snapshot
 */
export function introspect(options = {}) {
	let handlers;
	try {
		handlers = _classifyHandlers(options.handlers === true);
	} catch {
		handlers = { total: registry.size, byKind: null, modifiers: null };
	}

	let cron;
	try {
		cron = { jobs: cronRegistry.size, ..._cronIntrospect() };
	} catch {
		cron = { jobs: cronRegistry.size };
	}

	return {
		shuttingDown: _isShuttingDown(),
		inFlight: inFlightCount(),
		handlers,
		topics: _topicSnapshot(options.topics === true),
		push: { users: _pushRegistry.size, sessions: _pushSessionRegistry.size },
		cron,
		reactive: {
			derived: derivedRegistry.size,
			effect: effectRegistry.size,
			aggregate: aggregateRegistry.size,
			watchedTopics: _watchedTopics.size
		},
		capacity: {
			rateLimitBuckets: _rateLimits.size,
			throttles: _throttles.size,
			debounces: _debounces.size,
			presenceRefs: _presenceRef.size,
			lazyQueue: _lazyQueue.length
		},
		tenants: _tenantConfigRegistry.size,
		metrics: state.metricsInstruments != null,
		admission: state.admissionConfig != null
	};
}
