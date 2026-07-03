// @ts-check
import { checkUrl } from 'svelte-adapter-uws/safe-url';
import { _redactUrl, _replayWebhookOut } from './webhook-out.js';
import { state, _webhookOutById } from './state.js';
import { createDeadLetterStore } from './dead-letter.js';

/**
 * Create a webhook-to-stream bridge.
 *
 * Webhooks are server-only utilities; the Vite plugin marks them as known
 * exports (so they are not flagged as "not wrapped in live()") but does NOT
 * generate a SvelteKit `+server.js` endpoint. Wire one yourself by importing
 * the exported handler and calling its `.handle({ body, headers, platform })`
 * inside a POST handler. See README "Webhooks" for the canonical example.
 *
 * @param {string} topic - Topic to publish events to
 * @param {{ verify: (req: { body: string, headers: Record<string, string> }) => any, transform: (event: any) => { event: string, data: any } | null }} config
 * @returns {any}
 */
export const _webhookRegister = function webhook(topic, config) {
	const handler = {
		__isWebhook: true,
		__webhookTopic: topic,
		__verify: config.verify,
		__transform: config.transform,

		/**
		 * Handle an incoming webhook request.
		 * Call this from a SvelteKit +server.js POST handler.
		 *
		 * @param {{ body: string, headers: Record<string, string>, platform: any }} req
		 * @returns {{ status: number, body?: string }}
		 */
		async handle(req) {
			let event;
			try {
				event = await config.verify({ body: req.body, headers: req.headers });
			} catch {
				return { status: 400, body: 'Verification failed' };
			}

			const mapped = await config.transform(event);
			if (!mapped) return { status: 200, body: 'Ignored' };

			if (req.platform) {
				req.platform.publish(topic, mapped.event, mapped.data);
			}
			return { status: 200, body: 'OK' };
		}
	};

	return handler;
};

/**
 * Webhook namespace. `live.webhooks.inbound(topic, config)` is `live.webhook`
 * (bridge an external HTTP webhook into a topic). `live.webhooks.outbound(
 * sources, config)` fires an outbound HTTP webhook when any source topic
 * publishes: leader-gated (wire `configureCron({ leader })` for cluster dedup;
 * without a leader every worker fires, same as cron), retried with backoff,
 * optionally HMAC-signed, with an `idempotency-key` header so receivers can
 * dedup to effectively-once. The target URL is SSRF-checked (strict by default)
 * at definition time for a static url and again at fire time for a dynamic url.
 * Both directions are server-only; the flat `live.webhook` stays as a permanent
 * back-compat alias.
 */
export const _webhooksOutboundRegister = function outbound(sources, config) {
	if (!Array.isArray(sources) || sources.length === 0) {
		throw new Error('[svelte-realtime] live.webhooks.outbound: sources must be a non-empty array of topic names');
	}
	if (!config || (typeof config.url !== 'string' && typeof config.url !== 'function')) {
		throw new Error('[svelte-realtime] live.webhooks.outbound: config.url must be a string or a (event, data) => string function');
	}
	if (config.validateUrl !== undefined && typeof config.validateUrl !== 'function') {
		throw new Error('[svelte-realtime] live.webhooks.outbound: validateUrl must be a function');
	}
	if (config.resolve !== undefined && typeof config.resolve !== 'function') {
		throw new Error('[svelte-realtime] live.webhooks.outbound: resolve must be a function');
	}
	if (config.urlMode !== undefined && config.urlMode !== 'strict' && config.urlMode !== 'allowlist' && config.urlMode !== 'off') {
		throw new Error("[svelte-realtime] live.webhooks.outbound: urlMode must be 'strict', 'allowlist', or 'off'");
	}
	if (config.secret !== undefined && (typeof config.secret !== 'string' || config.secret.length === 0)) {
		throw new Error('[svelte-realtime] live.webhooks.outbound: secret must be a non-empty string');
	}
	if (config.previousSecret !== undefined) {
		if (typeof config.previousSecret !== 'string' || config.previousSecret.length === 0) {
			throw new Error('[svelte-realtime] live.webhooks.outbound: previousSecret must be a non-empty string');
		}
		if (config.secret === undefined) {
			throw new Error('[svelte-realtime] live.webhooks.outbound: previousSecret requires secret (the current key) to be set');
		}
	}
	// Fail fast on a static url: the always-on scheme gate plus, in
	// strict/allowlist mode, the literal range floor are checked at definition
	// time so a misconfigured endpoint is caught at boot, not on the first
	// event. A custom validateUrl can only narrow the allowed set, so it is
	// not run here (it is awaited at fire time alongside the DNS-resolved
	// re-check); a static url that fails the floor is blocked regardless.
	if (typeof config.url === 'string') {
		const base = checkUrl(config.url, { mode: config.urlMode || 'strict', allow: config.allow });
		if (!base.safe) {
			throw new Error(
				`[svelte-realtime] live.webhooks.outbound: url "${_redactUrl(config.url)}" is blocked (${base.reason}) - it points inside the trust boundary or uses a non-http(s) scheme. ` +
				"Use urlMode: 'allowlist' with allow: [...] for a public host, or urlMode: 'off' with a validateUrl that allows exactly your endpoint to reach a private one."
			);
		}
	}
	return {
		__isWebhookOut: true,
		__webhookOutSources: sources,
		__webhookOutConfig: config
	};
};

/**
 * Configure the outbound-webhook plane. `deadLetter` enables the dead-letter
 * store that retains UNDELIVERABLE outbound-webhook events (retry-exhausted,
 * SSRF-blocked, etc.) for admin inspection + replay, instead of reporting then
 * dropping them. Off by default - a DLQ retains attacker-influenced event data,
 * so it is opt-in.
 *
 * Pass `true` for the default in-memory store, a store instance (e.g. a
 * Redis/Postgres store for a cluster) for shared durability, or `false`/`null`
 * to disable. Also wired from `realtime({ webhooks: { deadLetter } })`.
 *
 * @param {{ deadLetter?: boolean | object | null }} [config]
 */
export function configureWebhooks(config = {}) {
	if (config.deadLetter !== undefined) {
		if (config.deadLetter === true) {
			if (!state.webhookDeadLetter) state.webhookDeadLetter = createDeadLetterStore();
		} else if (config.deadLetter && typeof config.deadLetter === 'object') {
			state.webhookDeadLetter = config.deadLetter;
		} else {
			state.webhookDeadLetter = null;
		}
	}
}

/**
 * The configured dead-letter store, or `null` when capture is off. Read it to
 * inspect or replay undeliverable outbound-webhook events from app code; the
 * admin route uses the same store.
 * @returns {any}
 */
export function getDeadLetter() {
	return state.webhookDeadLetter;
}

/**
 * Replay dead-lettered outbound-webhook events. Re-attempts delivery for each
 * matching record via its original webhook (looked up by id); on a successful
 * re-fire the record is removed. With `dryRun`, reports what WOULD replay (and
 * whether each webhook is still registered) without sending or removing.
 *
 * @param {{ topic?: string, ids?: string[], dryRun?: boolean }} [opts]
 * @returns {Promise<{ dryRun: boolean, total: number, replayed: number, removed: number, results: Array<{ id: string, ok: boolean, status: string, error?: string }> }>}
 */
export async function replayDeadLetter(opts = {}) {
	const store = state.webhookDeadLetter;
	const dryRun = opts.dryRun === true;
	if (!store) return { dryRun, total: 0, replayed: 0, removed: 0, results: [] };

	// `list` / `remove` may be sync (in-memory) or async (a Redis/Postgres
	// cluster store); awaiting tolerates both (await on a non-Promise is a no-op).
	let records = await store.list({ topic: opts.topic, limit: 1000000 });
	if (Array.isArray(opts.ids) && opts.ids.length) {
		const want = new Set(opts.ids.map(String));
		records = records.filter((r) => want.has(r.id));
	}

	const results = [];
	let replayed = 0;
	let removed = 0;
	for (const rec of records) {
		const entry = _webhookOutById.get(rec.webhookId);
		if (!entry) {
			// The webhook was unregistered (e.g. removed from code) since the
			// event was dead-lettered; it cannot be replayed.
			results.push({ id: rec.id, ok: false, status: 'webhook-unregistered' });
			continue;
		}
		if (dryRun) {
			results.push({ id: rec.id, ok: true, status: 'would-replay' });
			continue;
		}
		let outcome;
		try {
			outcome = await _replayWebhookOut(entry, rec.topic, rec.event, rec.data);
		} catch (err) {
			outcome = { ok: false, error: String((err && err.message) || err) };
		}
		if (outcome.ok) {
			replayed++;
			if (await store.remove(rec.id)) removed++;
			results.push({ id: rec.id, ok: true, status: 'replayed' });
		} else {
			results.push({ id: rec.id, ok: false, status: 'failed', error: outcome.error });
		}
	}
	return { dryRun, total: records.length, replayed, removed, results };
}
