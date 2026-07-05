// @ts-check
//
// Per-caller visibility for room enumeration. When a room export declares
// `enumerable: (ctx, room) => boolean`, its lobby deltas must not broadcast:
// the enumeration channel is shared per tenant, so a shared fan-out would hand
// every subscriber every room's existence, live count, and meta. This module
// replaces the shared fan-out for exactly those channels with a per-subscriber
// walk - each delta is evaluated against each local subscriber with that
// subscriber's own ctx, and delivered individually only when the predicate
// allows it.
//
// The interception point is the framework publish wrap (reactive.js): every
// enumeration delta - locally originated or arriving from another instance
// over the cluster bus - passes through the wrapped local publish immediately
// before the local broadcast, so the walk always runs on the instance that
// holds the sockets, with the subscriber knowledge only that instance has.
// Channels register here from two sites: the enumeration stream's
// pre-subscribe filter (a channel with any local subscriber is gated before
// its first delta can arrive) and the delta publish hooks themselves (the
// origin instance is gated even with no local lobby viewer).
//
// Visibility is tracked per (connection, channel): the set of room topics this
// subscriber has been shown, seeded from its own filtered snapshot and
// maintained by the walk. That set is what makes visibility LIVE with no
// wire-shape change:
//   - allowed, not yet shown -> 'created' (a grant, even on an update delta)
//   - allowed, shown         -> forwarded as-is
//   - denied, shown          -> synthetic 'deleted' (a revoke)
//   - denied, never shown    -> nothing (the room never crosses the wire)
//   - real 'deleted'         -> forwarded only to subscribers who saw the room
// A denied room therefore leaks neither existence nor count nor meta, and a
// predicate whose answer changes over time converges every subscriber to
// exactly what it is currently allowed to see. The client-side crud merge
// already tolerates all of this: 'created' over an existing key overwrites,
// 'deleted'/'updated' on a missing key are no-ops.
//
// Ordering: deltas for one channel run strictly in publish order through a
// per-channel promise chain, so an async predicate can never let a later
// delta overtake an earlier one. With a sync predicate and an idle chain the
// delivery completes synchronously inside the publish call; otherwise it
// costs the same microtask deferral the batched publish fast path already
// has. Failure polarity is CLOSED everywhere: a throwing or rejecting
// predicate denies, and a platform without the per-subscriber primitives
// (forEachSubscriber / send) drops the delta rather than degrading to a
// broadcast that would leak. Per-subscriber frames ride `platform.send`,
// whose envelope is byte-identical to a seq-less publish - the shape volatile
// topics already deliver - and the enumeration stream recovers any skipped
// frame from its per-caller snapshot on resubscribe, exactly like today.

import { _getCtxHelpers } from './ctx.js';
import { _resolveTenant } from './tenant.js';
import { _IS_DEV } from './env.js';

/**
 * Gated enumeration channels: wire topic -> the export's visibility
 * predicate. Consulted by the publish wrap on every local publish behind a
 * single size check, so apps without a predicate pay nothing.
 * @type {Map<string, (ctx: any, room: any) => any>}
 */
export const _enumGates = new Map();

/**
 * Per-connection shown-room tracking: ws -> (wire topic -> Set of room data
 * topics). WeakMap-keyed by the socket so a departed connection's tracking is
 * collected with it.
 * @type {WeakMap<object, Map<string, Set<string>>>}
 */
const _visByWs = new WeakMap();

/**
 * In-flight per-channel delivery chains. An entry exists only while a
 * delivery is pending; the finally handler removes it once the chain drains.
 * @type {Map<string, Promise<void>>}
 */
const _chains = new Map();

/** Dev-warn dedup: platform without the per-subscriber primitives. */
let _walkUnavailableWarned = false;

/**
 * Register a gated enumeration channel. Last write wins, so an HMR
 * re-register swaps the predicate in place.
 * @param {string} wireTopic
 * @param {(ctx: any, room: any) => any} predicate
 */
export function _registerEnumGate(wireTopic, predicate) {
	_enumGates.set(wireTopic, predicate);
}

/**
 * Union the room topics a subscriber's filtered snapshot just showed it into
 * the connection's shown set. A union, never a replace: a delta delivered
 * while the snapshot was loading must not be forgotten (a forgotten grant
 * would suppress the revoke that has to follow it), while a stale extra key
 * only ever costs a 'deleted' the client no-ops.
 * @param {any} ws
 * @param {string} wireTopic
 * @param {Iterable<string>} roomTopics
 */
export function _seedEnumVisibility(ws, wireTopic, roomTopics) {
	const set = _visFor(ws, wireTopic);
	for (const t of roomTopics) set.add(t);
}

/**
 * The shown-room set for one (connection, channel), created on first touch.
 * @param {any} ws
 * @param {string} wireTopic
 */
function _visFor(ws, wireTopic) {
	let byTopic = _visByWs.get(ws);
	if (byTopic === undefined) {
		byTopic = new Map();
		_visByWs.set(ws, byTopic);
	}
	let set = byTopic.get(wireTopic);
	if (set === undefined) {
		set = new Set();
		byTopic.set(wireTopic, set);
	}
	return set;
}

/**
 * Intercept a local publish whose topic is a gated enumeration channel.
 * Returns true when the delta was taken over (the caller must NOT broadcast
 * it), false when the topic is not gated. Delivery is queued on the channel's
 * order-preserving chain and never throws into the publish path.
 * @param {any} platform
 * @param {string} topic
 * @param {string} event
 * @param {any} data
 */
export function _enumGateIntercept(platform, topic, event, data) {
	const predicate = _enumGates.get(topic);
	if (predicate === undefined) return false;
	_enqueue(topic, () => _deliver(platform, predicate, topic, event, data));
	return true;
}

/**
 * Split gated items out of a batched publish, queueing each on its channel's
 * chain in batch order. Returns the remaining items for the caller to
 * broadcast - the input array itself when nothing matched, so the untouched
 * common case stays allocation-free.
 * @param {any} platform
 * @param {Array<{ topic: string, event: string, data: any, options?: any }>} batch
 */
export function _enumGateInterceptBatch(platform, batch) {
	let rest = null;
	for (let i = 0; i < batch.length; i++) {
		const item = batch[i];
		if (item && typeof item.topic === 'string' && _enumGates.has(item.topic)) {
			if (rest === null) rest = batch.slice(0, i);
			_enumGateIntercept(platform, item.topic, item.event, item.data);
		} else if (rest !== null) {
			rest.push(item);
		}
	}
	return rest === null ? batch : rest;
}

/**
 * Chain a delivery onto the channel's FIFO. With no pending chain the job
 * starts synchronously (a sync predicate delivers inside the publish call);
 * otherwise it runs when the predecessor settles, success or failure alike.
 * @param {string} topic
 * @param {() => Promise<void>} job
 */
function _enqueue(topic, job) {
	const prev = _chains.get(topic);
	const next = prev === undefined ? job() : prev.then(job, job);
	_chains.set(topic, next);
	next.finally(() => {
		if (_chains.get(topic) === next) _chains.delete(topic);
	});
}

/**
 * Deliver one delta to each local subscriber of the channel that is allowed
 * to see the room, maintaining the shown sets. Never throws (a broken
 * delivery must not break the publish path; the next delta re-walks).
 * @param {any} platform
 * @param {(ctx: any, room: any) => any} predicate
 * @param {string} topic
 * @param {string} event
 * @param {any} data
 */
async function _deliver(platform, predicate, topic, event, data) {
	try {
		if (typeof platform.forEachSubscriber !== 'function' || typeof platform.send !== 'function') {
			// Fail closed: without a per-subscriber walk there is no safe
			// delivery - a shared broadcast would hand every subscriber the
			// delta the predicate exists to withhold. Snapshots (always
			// per-caller) keep working, and a resubscribe recovers the state.
			if (_IS_DEV && !_walkUnavailableWarned) {
				_walkUnavailableWarned = true;
				console.warn('[svelte-realtime] live.room enumerable(ctx, room): this platform exposes no forEachSubscriber/send, so per-caller lobby deltas are dropped (snapshots still filter). Upgrade svelte-adapter-uws.\n  See: https://svti.me/rooms');
			}
			return;
		}
		const roomTopic = data && data.topic;
		if (typeof roomTopic !== 'string') return; // not a room delta shape: nothing safe to deliver
		/** @type {Array<{ ws: any, user: any }>} */
		const targets = [];
		platform.forEachSubscriber(topic, (ws, userData) => {
			targets.push({ ws, user: userData });
		});
		if (targets.length === 0) return;
		// One frozen copy per delta: the predicate sees the room card but can
		// mutate neither the wire payload nor what later subscribers see.
		const room = event === 'deleted' ? null : Object.freeze({
			topic: roomTopic,
			args: Array.isArray(data.args) ? Object.freeze(data.args.slice()) : data.args,
			count: data.count,
			meta: data.meta
		});
		const helpers = _getCtxHelpers(platform);
		for (const t of targets) {
			const vis = _visFor(t.ws, topic);
			if (event === 'deleted') {
				// No predicate on close: you see a room end iff you saw the room.
				if (vis.delete(roomTopic)) platform.send(t.ws, topic, 'deleted', data);
				continue;
			}
			let allowed = false;
			try {
				// The same ctx shape the unsubscribe/close drains build for this
				// connection: the adapter's userData IS the connection's user.
				const ctx = { user: t.user, ws: t.ws, platform, publish: helpers.publish, cursor: null, tenantId: _resolveTenant(t.user), _publishWire: helpers.publish };
				const r = predicate(ctx, room);
				allowed = (r && typeof r.then === 'function') ? !!(await r) : !!r;
			} catch {
				allowed = false; // fail closed
			}
			if (allowed) {
				if (vis.has(roomTopic)) {
					platform.send(t.ws, topic, event, data);
				} else {
					// A grant: the subscriber's first sight of this room must be a
					// 'created' whatever the delta was, or the client merge would
					// no-op an 'updated' for a key it does not hold.
					vis.add(roomTopic);
					platform.send(t.ws, topic, 'created', data);
				}
			} else if (vis.delete(roomTopic)) {
				// A revoke: the room leaves this subscriber's lobby now, carrying
				// nothing but the key it already knew.
				platform.send(t.ws, topic, 'deleted', { topic: roomTopic });
			}
		}
	} catch {
		// Delivery must never break the publish path.
	}
}

/**
 * Test seam: drop every registered gate. Module state persists across test
 * files in one process; suites that register gates clear them here.
 */
export function _clearEnumGatesForTests() {
	_enumGates.clear();
}
