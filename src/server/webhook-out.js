// @ts-check
import { deliverWebhook, redactUrl } from 'svelte-adapter-uws/plugins/webhooks';
import { now } from '../shared/runtime.js';
import { state } from './state.js';
import { _IS_DEV } from './env.js';

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
function _webhookHooks(entry) {
	const budget = state.webhookBudget;
	const breaker = state.webhookBreaker;
	if (!budget && !breaker) return undefined;
	return { budget: budget || undefined, breaker: breaker || undefined, key: entry.id };
}

function _reportWebhookOutFailure(config, err, event, data, attempts) {
	if (config.onFailure) {
		try {
			const r = config.onFailure(err, event, data, attempts);
			if (r && typeof r.then === 'function') r.catch(() => {});
		} catch { /* swallow listener errors */ }
	} else if (state.serverErrorHandler) {
		try { state.serverErrorHandler('webhook', err); } catch {}
	} else if (_IS_DEV) {
		console.error('[svelte-realtime] Outbound webhook failed:', err);
	}
}

export async function _fireWebhookOut(entry, topic, event, data, platform) {
	void platform; // accepted for call-site parity; delivery reads entry.config
	const r = await deliverWebhook(entry.config, topic, event, data, _webhookHooks(entry));
	if (r.ok) return;
	_reportWebhookOutFailure(entry.config, r.err, event, data, r.attempts);
	const store = state.webhookDeadLetter;
	if (store) {
		try {
			const added = store.add({
				webhookId: entry.id,
				topic,
				event,
				data,
				attempts: r.attempts | 0,
				error: String((r.err && r.err.message) || r.err || 'unknown'),
				failedAt: now()
			});
			if (added && typeof added.then === 'function') added.catch(() => {});
		} catch { /* never let dead-letter capture break the (best-effort) webhook path */ }
	}
}

export async function _replayWebhookOut(entry, topic, event, data) {
	const r = await deliverWebhook(entry.config, topic, event, data, _webhookHooks(entry));
	if (r.ok) return { ok: true };
	return { ok: false, error: String((r.err && r.err.message) || r.err || 'unknown') };
}
