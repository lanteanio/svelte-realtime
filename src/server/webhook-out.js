// @ts-check
import { deliverWebhook, redactUrl } from 'svelte-adapter-uws/plugins/webhooks';
import { now, monotonicNow } from '../shared/runtime.js';
import { state } from './state.js';
import { diagnosticErrorMessage, emitOperationalEvent } from '../shared/diagnostic.js';
import { _createLane, _laneSubmit, WEBHOOK_MAX_CONCURRENT, WEBHOOK_MAX_QUEUED } from './work-lane.js';
import { LiveError } from './live-error.js';

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
	const r = await deliverWebhook(entry.config, topic, event, data, _webhookHooks(entry, traceContext));
	if (r.ok) return;
	_reportWebhookOutFailure(entry.config, r.err, event, data, r.attempts);
	_captureDeadLetter(entry, topic, event, data, r.attempts, r.err, startedAt, traceContext);
}

/** Keep an undelivered event in the dead-letter store, when one is configured. */
function _captureDeadLetter(entry, topic, event, data, attempts, err, startedAt, traceContext) {
	const store = state.webhookDeadLetter;
	if (!store) return;
	try {
		const added = store.add({
			webhookId: entry.id,
			topic,
			event,
			data,
			attempts: attempts | 0,
			error: String((err && err.message) || err || 'unknown'),
			failedAt: now(),
			startedAt,
			traceContext
		});
		if (added && typeof added.then === 'function') added.catch((e) => _reportDeadLetterFailure(entry, e));
	} catch (e) {
		_reportDeadLetterFailure(entry, e);
	}
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
		onReject: (l, topic, event, data, platform) => _webhookOverflow(entry, l, topic, event, data, platform),
		onDrained: _webhookOverflowEnded
	});
	lane.id = entry.id;
	return entry.lane = lane;
}

/**
 * Hand one source event to an outbound webhook. Delivery starts off the publish
 * path; an event past the webhook's limits is not sent and fails like any
 * undelivered event: `onFailure` (attempts 0) and the dead-letter store.
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
 * Fail one rejected event. Runs in the microtask that admits the event, so
 * the trace context read here is that of its publish.
 */
function _webhookOverflow(entry, lane, topic, event, data, platform) {
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
			attributes: { webhookId: entry.id, maxConcurrent: lane.maxConcurrent, maxQueued: lane.maxQueued, deadLettered: !!state.webhookDeadLetter }
		});
	}
	_captureDeadLetter(entry, topic, event, data, 0, err, monotonicNow(), platform?.traceContext ?? null);
}

/** @param {any} lane @param {number} rejected */
function _webhookOverflowEnded(lane, rejected) {
	emitOperationalEvent({
		source: 'svelte-realtime',
		component: 'server.webhook',
		event: 'webhook.delivery.overflow.ended',
		severity: 'info',
		dataClass: 'operational',
		message: 'An outbound webhook has queue room again after rejecting events.',
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
