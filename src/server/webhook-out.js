// @ts-check
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac } from 'node:crypto';
import { deliverWebhook, redactUrl } from 'svelte-adapter-uws/plugins/webhooks';
import { now, monotonicNow, setTimer, clearTimer } from '../shared/runtime.js';
import { state } from './state.js';
import { diagnosticErrorMessage, emitOperationalEvent } from '../shared/diagnostic.js';

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

// The idempotency key a delivery sends, recorded while the delivery runs so the
// dead-letter capture is keyed by exactly the value the receiver saw.
/** @type {AsyncLocalStorage<{ topic: string, payload: unknown, key: unknown }>} */
const _deliverySlot = new AsyncLocalStorage();

/**
 * One wrapped config per registered config, so the adapter's per-config caches
 * (DNS pins) keep working. The wrappers record the transformed payload and the
 * idempotency key of the delivery running in `_deliverySlot`.
 * @type {WeakMap<object, any>}
 */
const _keyedConfigs = new WeakMap();

/** @param {any} config */
function _keyedConfig(config) {
	let keyed = _keyedConfigs.get(config);
	if (keyed !== undefined) return keyed;
	const transform = config.transform;
	keyed = {
		...config,
		transform: async (/** @type {string} */ event, /** @type {unknown} */ data) => {
			const payload = transform ? await transform(event, data) : { event, data };
			const slot = _deliverySlot.getStore();
			if (slot !== undefined) slot.payload = payload;
			return payload;
		},
		idempotencyKey: (/** @type {string} */ event, /** @type {unknown} */ data) => {
			const slot = _deliverySlot.getStore();
			if (slot === undefined) return _idempotencyKey(config, '', event, data, { event, data });
			slot.key = _idempotencyKey(config, slot.topic, event, data, slot.payload);
			return slot.key;
		}
	};
	_keyedConfigs.set(config, keyed);
	return keyed;
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
 * open breaker, a url callback failure) derives it from the recorded payload,
 * bounded like the adapter bounds callbacks. Null means capture unkeyed.
 * @param {any} config @param {{ topic: string, payload: unknown, key: unknown }} slot
 * @param {string} event @param {unknown} data
 * @returns {Promise<string | null>}
 */
async function _captureKey(config, slot, event, data) {
	let key = slot.key;
	if (key === undefined) {
		if (slot.payload === undefined) return null;
		let timer;
		try {
			key = await Promise.race([
				Promise.resolve().then(() => _idempotencyKey(config, slot.topic, event, data, slot.payload)),
				new Promise((resolve) => { timer = setTimer(() => resolve(null), config.callbackTimeoutMs ?? 10000); })
			]);
		} catch {
			return null;
		} finally {
			clearTimer(timer);
		}
	} else {
		try { key = await key; } catch { return null; }
	}
	if (key == null) return null;
	const s = String(key);
	return s.length > 0 && s.length <= 256 && !/[\r\n\0]/.test(s) ? s : null;
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
	_reportWebhookOutFailure(entry.config, r.err, event, data, r.attempts);
	const store = state.webhookDeadLetter;
	if (!store) return;
	/** @type {Record<string, unknown>} */
	const rec = {
		webhookId: entry.id,
		topic,
		event,
		data,
		attempts: r.attempts | 0,
		error: String((r.err && r.err.message) || r.err || 'unknown'),
		failedAt: now(),
		startedAt,
		traceContext
	};
	// The key is the delivery's idempotency key, so the queue holds one record
	// per delivery a receiver would accept once, and a write whose reply was lost
	// can be sent again without creating a second record. Only a store that
	// declares `keyedAdd` gets a key; any other store, and a delivery without a
	// usable key, get one unkeyed write, which is all that can safely be repeated.
	const key = slot !== null && store.keyedAdd === true ? await _captureKey(entry.config, slot, event, data) : null;
	if (key !== null) rec.key = key;
	for (let attempt = 0; ; attempt++) {
		try {
			await store.add(rec);
			return;
		} catch (err) {
			if (key === null || attempt >= _DEAD_LETTER_RETRY_MS.length) {
				_reportDeadLetterFailure(entry, err);
				return;
			}
			await new Promise((resolve) => setTimer(resolve, _DEAD_LETTER_RETRY_MS[attempt]));
		}
	}
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
