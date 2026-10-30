// @ts-check
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac } from 'node:crypto';
import { deliverWebhook, redactUrl } from 'svelte-adapter-uws/plugins/webhooks';
import { now, monotonicNow, setTimer, clearTimer } from '../shared/runtime.js';
import { state } from './state.js';
import { diagnosticErrorMessage, emitOperationalEvent } from '../shared/diagnostic.js';
import { _createLane, _laneSubmit, LANE_FAILED, WEBHOOK_MAX_CONCURRENT, WEBHOOK_MAX_QUEUED } from './work-lane.js';
import { LiveError } from './live-error.js';
import { _bgRetryExhausted, _bgDeadLetterChanged } from './background-metrics.js';

// The generic SSRF-gated, retrying delivery engine now lives in the adapter
// plugin (svelte-adapter-uws/plugins/webhooks); this module is the realtime glue
// around it: event fan-out failure reporting + dead-letter capture.

/** Re-exported for the registration-time SSRF validation message in webhooks.js. */
export { redactUrl as _redactUrl };

/**
 * Assemble the optional delivery-control hooks for one webhook entry: the
 * configured retry budget + endpoint-ejection breaker (wired via
 * `configureWebhooks` / `realtime({ webhooks })`), keyed by the webhook's
 * registration id so one endpoint's failures cannot trip or starve another.
 * Returns undefined when neither is configured, so an unconfigured delivery is
 * byte-identical to the bare call.
 */
function _webhookHooks(entry, traceContext) {
	const budget = state.webhookBudget;
	const breaker = state.webhookBreaker;
	if (!budget && !breaker && !traceContext) return undefined;
	return {
		budget: budget || undefined,
		breaker: breaker || undefined,
		key: entry.id,
		traceContext: traceContext || undefined
	};
}

function _reportWebhookOutFailure(config, err, event, data, attempts) {
	if (config.onFailure) {
		try {
			const r = config.onFailure(err, event, data, attempts);
			if (r && typeof r.then === 'function') r.catch(() => {});
		} catch { /* swallow listener errors */ }
	} else if (state.serverErrorHandler) {
		try { state.serverErrorHandler('webhook', err); } catch {}
	}
	emitOperationalEvent({
		source: 'svelte-realtime',
		component: 'server.webhook',
		event: 'webhook.delivery.failed',
		severity: 'error',
		dataClass: 'application',
		message: 'An outbound webhook exhausted its delivery policy.',
		attributes: { event, attempts: attempts | 0, error: diagnosticErrorMessage(err) }
	});
}

// Waits before each repeated dead-letter write. A keyed write is idempotent, so
// repeating one whose outcome is unknown cannot duplicate the record.
const _DEAD_LETTER_RETRY_MS = [100, 500];

// Dead-letter writes in flight at once in this process. A capture runs off the
// delivery's lane slot, so a store that stops answering cannot stall delivery;
// this bound keeps such a store from piling up pending writes instead. A
// capture past it is lost and reported like a failed write.
export const _MAX_DEAD_LETTER_CAPTURES = 1000;

/** @type {Set<Promise<void>>} */
const _captures = new Set();

/**
 * Resolves once every dead-letter write in flight now has settled.
 * @internal
 */
export async function _deadLetterCapturesSettled() {
	await Promise.allSettled([..._captures]);
}

// The idempotency key a delivery sends, recorded while the delivery runs so the
// dead-letter capture is keyed by exactly the value the receiver saw.
/** @type {AsyncLocalStorage<{ topic: string, payload: unknown, key: unknown }>} */
const _deliverySlot = new AsyncLocalStorage();

/**
 * One wrapped config per registered config, so the adapter's per-config caches
 * (DNS pins) keep working. The wrapper is a live view of the registered
 * config: every other field, the secret included, is read from it at the
 * moment the adapter needs it, exactly as an unkeyed delivery reads it, and
 * the key is derived from the same object, so signing and keying never see
 * different settings. Its own two fields record the transformed payload and
 * the idempotency key of the delivery running in `_deliverySlot`.
 * @type {WeakMap<object, any>}
 */
const _keyedConfigs = new WeakMap();

/** @param {any} config */
function _keyedConfig(config) {
	let wrapped = _keyedConfigs.get(config);
	if (wrapped !== undefined) return wrapped;
	wrapped = Object.create(config, {
		transform: {
			enumerable: true,
			value: async (/** @type {string} */ event, /** @type {unknown} */ data) => {
				const payload = config.transform ? await config.transform(event, data) : { event, data };
				const slot = _deliverySlot.getStore();
				if (slot !== undefined) slot.payload = payload;
				return payload;
			}
		},
		idempotencyKey: {
			enumerable: true,
			value: (/** @type {string} */ event, /** @type {unknown} */ data) => {
				const slot = _deliverySlot.getStore();
				if (slot === undefined) return null;
				slot.key = _idempotencyKey(config, slot.topic, event, data, slot.payload);
				return slot.key;
			}
		}
	});
	_keyedConfigs.set(config, wrapped);
	return wrapped;
}
/**
 * The delivery's idempotency key: the configured callback's value, otherwise
 * the adapter's own derivation (SHA-256 of topic, event and body, HMAC with the
 * secret), so the header a receiver sees does not change when capture keys are on.
 * @param {any} config @param {string} topic @param {string} event @param {unknown} data @param {unknown} payload
 */
function _idempotencyKey(config, topic, event, data, payload) {
	if (config.idempotencyKey) return config.idempotencyKey(event, data);
	const material = topic + '\0' + event + '\0' + JSON.stringify(payload);
	return config.secret
		? createHmac('sha256', config.secret).update('idem\0' + material).digest('hex')
		: createHash('sha256').update(material).digest('hex');
}

/**
 * The capture key of a failed delivery: its idempotency key when it had a
 * valid one. A delivery that failed before the adapter asked for the key (an
 * open breaker, a url callback failure) derives it from the recorded payload.
 * A key that is a promise is awaited, bounded like the adapter bounds
 * callbacks; any other is had at once, so a capture into a synchronous store
 * lands before the delivery returns. Gives the key, null for a delivery
 * without one (capture unkeyed), or `unavailable` when the key could not be
 * had (a callback that threw or never settled).
 * @param {any} config the registered config the delivery read
 * @param {{ topic: string, payload: unknown, key: unknown }} slot
 * @param {string} event @param {unknown} data
 * @returns {string | null | typeof _KEY_UNAVAILABLE | Promise<string | null | typeof _KEY_UNAVAILABLE>}
 */
function _captureKey(config, slot, event, data) {
	let pending = slot.key;
	if (pending === undefined) {
		if (slot.payload === undefined) return null;
		try { pending = _idempotencyKey(config, slot.topic, event, data, slot.payload); }
		catch { return _KEY_UNAVAILABLE; }
	}
	if (pending !== null && typeof pending === 'object' && typeof (/** @type {any} */ (pending)).then === 'function') {
		return _awaitCaptureKey(config, /** @type {Promise<unknown>} */ (pending));
	}
	return _validCaptureKey(pending);
}

/**
 * @param {any} config @param {Promise<unknown>} pending
 * @returns {Promise<string | null | typeof _KEY_UNAVAILABLE>}
 */
async function _awaitCaptureKey(config, pending) {
	let timer;
	let key;
	try {
		key = await Promise.race([
			pending,
			new Promise((resolve) => { timer = setTimer(() => resolve(_KEY_UNAVAILABLE), config.callbackTimeoutMs ?? 10000); })
		]);
	} catch {
		return _KEY_UNAVAILABLE;
	} finally {
		clearTimer(timer);
	}
	return _validCaptureKey(key);
}

/** @param {unknown} key @returns {string | null | typeof _KEY_UNAVAILABLE} */
function _validCaptureKey(key) {
	if (key === _KEY_UNAVAILABLE) return key;
	if (key == null) return null;
	const s = String(key);
	return s.length > 0 && s.length <= 256 && !/[\r\n\0]/.test(s) ? s : null;
}

const _KEY_UNAVAILABLE = Symbol('key unavailable');

/** @param {{ id: string }} entry */
function _reportKeyUnavailable(entry) {
	emitOperationalEvent({
		source: 'svelte-realtime',
		component: 'server.webhook',
		event: 'webhook.dead-letter.key-unavailable',
		severity: 'warn',
		dataClass: 'operational',
		message: 'A failed webhook delivery had no idempotency key in time; it was captured once without a key.',
		attributes: { webhookId: entry.id }
	});
}

function _reportDeadLetterFailure(entry, err) {
	// The delivery already failed, so this record was the only replay copy: count
	// it so an empty dead-letter store is never read as nothing to recover.
	state.metricsInstruments?.deadLetterFailures?.inc();
	emitOperationalEvent({
		source: 'svelte-realtime',
		component: 'server.webhook',
		event: 'webhook.dead-letter.persist-failed',
		severity: 'error',
		dataClass: 'application',
		message: 'A failed webhook could not be persisted to the dead-letter store.',
		attributes: { webhookId: entry.id, error: diagnosticErrorMessage(err) }
	});
}

async function _fireWebhookOutInner(entry, topic, event, data, traceContext) {
	// Capture when delivery began (MONOTONIC, so the tombstone match is immune to a
	// wall-clock step) so the dead-letter store's forget tombstone can tell an
	// in-flight-during-forget capture (drop) from a post-forget one. A long retry
	// budget can outlive a live.forget that ran mid-delivery.
	const startedAt = monotonicNow();
	const hooks = _webhookHooks(entry, traceContext);
	// With a store that honors capture keys, run the delivery with wrappers that
	// record its idempotency key; otherwise the bare config, unchanged.
	const keyStore = state.webhookDeadLetter;
	const slot = keyStore && keyStore.keyedAdd === true ? { topic, payload: undefined, key: undefined } : null;
	const r = slot === null
		? await deliverWebhook(entry.config, topic, event, data, hooks)
		: await _deliverySlot.run(slot, () => deliverWebhook(_keyedConfig(entry.config), topic, event, data, hooks));
	if (r.ok) return;
	// Every attempt the retry policy allows was made and the last one failed. A
	// delivery the gate, the breaker, the retry budget or a non-retryable status
	// stopped earlier is not counted.
	if (r.attempts >= _retryAttempts(entry.config)) _bgRetryExhausted('webhook');
	_reportWebhookOutFailure(entry.config, r.err, event, data, r.attempts);
	// The capture does not hold the delivery's lane slot: a slow dead-letter
	// store must not stop this webhook's deliveries. Writes in flight are
	// bounded per process instead.
	if (state.webhookDeadLetter) {
		if (_captures.size >= _MAX_DEAD_LETTER_CAPTURES) {
			_reportDeadLetterFailure(entry, new Error('too many dead-letter writes in flight (' + _MAX_DEAD_LETTER_CAPTURES + ')'));
		} else {
			let pending;
			try {
				pending = _captureDeadLetter(entry, slot, topic, event, data, r.attempts, r.err, startedAt, traceContext);
			} catch (e) {
				// Anything that throws before the write leaves the record unwritten.
				_reportDeadLetterFailure(entry, e);
			}
			if (pending !== undefined) {
				const capture = pending
					.catch((e) => _reportDeadLetterFailure(entry, e))
					.finally(() => { _captures.delete(capture); });
				_captures.add(capture);
			}
		}
	}
	return LANE_FAILED;
}

/**
 * The attempt limit the delivery engine applies for this config: `retry.attempts`
 * when it is a positive integer, else the engine's default of 3.
 * @param {any} config
 */
function _retryAttempts(config) {
	const n = config.retry?.attempts;
	return Number.isInteger(n) && n > 0 ? n : 3;
}

/**
 * Keep an undelivered event in the dead-letter store, when one is configured.
 * `slot` holds what the delivery recorded for its capture key, or null when
 * the store does not honor keys. Runs synchronously as far as it can: a
 * synchronous store with a key had at once returns undefined with the record
 * written; otherwise the returned promise settles when the write is done or
 * reported as failed.
 * @returns {Promise<void> | undefined}
 */
function _captureDeadLetter(entry, slot, topic, event, data, attempts, err, startedAt, traceContext) {
	const store = state.webhookDeadLetter;
	if (!store) return undefined;
	/** @type {Record<string, unknown>} */
	const rec = {
		webhookId: entry.id,
		topic,
		event,
		data,
		attempts: attempts | 0,
		error: String((err && err.message) || err || 'unknown'),
		failedAt: now(),
		startedAt,
		traceContext
	};
	// The key is the delivery's idempotency key, so the queue holds one record
	// per delivery a receiver would accept once, and a write whose reply was lost
	// can be sent again without creating a second record. Only a store that
	// declares `keyedAdd` gets a key; any other store, and a delivery without a
	// usable key, get one unkeyed write, which is all that can safely be repeated.
	const key = slot !== null && store.keyedAdd === true ? _captureKey(entry.config, slot, event, data) : null;
	if (key !== null && typeof key === 'object' && typeof key.then === 'function') {
		return key.then((k) => _addDeadLetter(entry, store, rec, k));
	}
	return _addDeadLetter(entry, store, rec, /** @type {string | null | typeof _KEY_UNAVAILABLE} */ (key));
}

/**
 * Write one capture. A synchronous store answers at once and the result is
 * undefined; an asynchronous one is awaited, and a keyed write it rejects is
 * repeated after the waits in `_DEAD_LETTER_RETRY_MS`. A synchronous throw (a
 * malformed record, a throwing extractor) fails the same way every time, so it
 * is reported at once and never repeated.
 * @param {any} entry @param {any} store @param {Record<string, unknown>} rec
 * @param {string | null | typeof _KEY_UNAVAILABLE} key
 * @returns {Promise<void> | undefined}
 */
function _addDeadLetter(entry, store, rec, key) {
	if (key === _KEY_UNAVAILABLE) {
		_reportKeyUnavailable(entry);
		key = null;
	}
	if (key !== null) rec.key = key;
	let added;
	try {
		added = store.add(rec);
	} catch (e) {
		_reportDeadLetterFailure(entry, e);
		return undefined;
	}
	if (!added || typeof added.then !== 'function') {
		_deadLetterChanged();
		return undefined;
	}
	return _awaitDeadLetter(entry, store, rec, key !== null, added);
}

/**
 * @param {any} entry @param {any} store @param {Record<string, unknown>} rec
 * @param {boolean} keyed @param {Promise<unknown>} added
 */
async function _awaitDeadLetter(entry, store, rec, keyed, added) {
	for (let attempt = 0; ; attempt++) {
		try {
			await added;
			return;
		} catch (e) {
			if (!keyed || attempt >= _DEAD_LETTER_RETRY_MS.length) {
				_reportDeadLetterFailure(entry, e);
				return;
			}
		}
		await new Promise((resolve) => setTimer(resolve, _DEAD_LETTER_RETRY_MS[attempt]));
		try {
			added = store.add(rec);
		} catch (e) {
			_reportDeadLetterFailure(entry, e);
			return;
		}
		if (!added || typeof added.then !== 'function') {
			_deadLetterChanged();
			return;
		}
	}
}

/**
 * Tell the background metrics a synchronous store took a record. The record
 * is written by then, so a failing metrics registry must not turn the write
 * into a reported loss.
 */
function _deadLetterChanged() {
	try { _bgDeadLetterChanged(); } catch { /* The write stands; metrics are best-effort. */ }
}

/**
 * The webhook's delivery lane (its bulkhead), created on first use from the
 * registration's `maxConcurrent` / `maxQueued`. One lane per registration, so
 * a stalled endpoint holds only its own slots.
 * @param {any} entry
 */
function _webhookLane(entry) {
	const config = entry.config;
	const lane = _createLane('webhook', {
		maxConcurrent: config.maxConcurrent ?? WEBHOOK_MAX_CONCURRENT,
		maxQueued: config.maxQueued ?? WEBHOOK_MAX_QUEUED
	}, (topic, event, data, platform) => _fireWebhookOut(entry, topic, event, data, platform), {
		onReject: (l, topic, event, data) => _webhookOverflow(entry, l, topic, event, data),
		onOverflowEnded: _webhookOverflowEnded
	});
	lane.id = entry.id;
	return entry.lane = lane;
}

/**
 * Hand one source event to an outbound webhook. Delivery starts off the publish
 * path; an event past the webhook's limits is not sent and goes to `onFailure`
 * (attempts 0).
 * @param {any} entry
 * @param {string} topic
 * @param {string} event
 * @param {any} data
 * @param {any} platform
 */
export function _submitWebhookOut(entry, topic, event, data, platform) {
	_laneSubmit(entry.lane || _webhookLane(entry), topic, event, data, platform);
}

/**
 * Fail one rejected event. It stays out of the dead-letter store: an overflow
 * burst rejects events by the thousand, and the store's capacity belongs to
 * the deliveries that failed, which such a burst would otherwise evict.
 */
function _webhookOverflow(entry, lane, topic, event, data) {
	const first = lane.rejected === 1;
	const err = new LiveError('OVERLOADED',
		"outbound webhook '" + entry.id + "' is at its limit (maxConcurrent " + lane.maxConcurrent + ', maxQueued ' + lane.maxQueued +
		'); the event was not delivered.');
	const config = entry.config;
	// onFailure is the per-event report. The global handler and the operational
	// event hear the first rejection of an overflow episode only.
	if (config.onFailure) {
		try {
			const r = config.onFailure(err, event, data, 0);
			if (r && typeof r.then === 'function') r.catch(() => {});
		} catch { /* swallow listener errors */ }
	} else if (first && state.serverErrorHandler) {
		try { state.serverErrorHandler('webhook', err); } catch {}
	}
	if (first) {
		emitOperationalEvent({
			source: 'svelte-realtime',
			component: 'server.webhook',
			event: 'webhook.delivery.overflow',
			severity: 'warn',
			dataClass: 'operational',
			message: 'An outbound webhook is at its concurrency and queue limits; new events are not delivered.',
			attributes: { webhookId: entry.id, maxConcurrent: lane.maxConcurrent, maxQueued: lane.maxQueued }
		});
	}
}

/** @param {any} lane @param {number} rejected */
function _webhookOverflowEnded(lane, rejected) {
	emitOperationalEvent({
		source: 'svelte-realtime',
		component: 'server.webhook',
		event: 'webhook.delivery.overflow.ended',
		severity: 'info',
		dataClass: 'operational',
		message: 'An outbound webhook queue is back to half its limit after rejecting events.',
		attributes: { webhookId: lane.id, rejected }
	});
}

export async function _fireWebhookOut(entry, topic, event, data, platform) {
	const trace = platform?.trace;
	if (!trace?.enabled) {
		return _fireWebhookOutInner(entry, topic, event, data, platform?.traceContext ?? null);
	}
	return trace.run('realtime.webhook.outbound', {
		kind: 'producer',
		parent: platform.traceContext,
		attributes: { 'messaging.system': 'webhook', 'messaging.operation': 'publish' }
	}, () => _fireWebhookOutInner(entry, topic, event, data, trace.current()));
}

async function _replayWebhookOutInner(entry, topic, event, data, traceContext) {
	const r = await deliverWebhook(entry.config, topic, event, data, _webhookHooks(entry, traceContext));
	if (r.ok) return { ok: true };
	return { ok: false, error: String((r.err && r.err.message) || r.err || 'unknown') };
}

export async function _replayWebhookOut(entry, topic, event, data, traceContext = null, platform = null) {
	const trace = platform?.trace;
	if (!trace?.enabled) return _replayWebhookOutInner(entry, topic, event, data, traceContext);
	return trace.run('realtime.webhook.replay', {
		kind: 'producer',
		parent: traceContext,
		attributes: { 'messaging.system': 'webhook', 'messaging.operation': 'publish' }
	}, () => _replayWebhookOutInner(entry, topic, event, data, trace.current()));
}
