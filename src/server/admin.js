// @ts-check
// The admin / observability HTTP handler: a framework-agnostic Web `Request` ->
// `Response` router for the admin plane. It owns the SECURITY gate (mandatory,
// fail-closed) and serves the `introspect()` snapshot plus the dead-letter-queue
// commands (`GET /dlq`, `GET /dlq/<topic>`, `POST /dlq/<topic>/replay`). Routing
// is mount-prefix agnostic (final path segment for single-segment commands, path
// tail for the multi-segment DLQ commands), so it serves the same commands
// whether mounted at the adapter's default `/__realtime`, a custom
// `websocket.adminPath`, or a `+server.js` route at any path.
//
// Configured via `realtime({ admin: { requires } })`. Without it there is no
// admin handler at all (fail-closed by absence); with it, every request runs the
// app's `requires(request)` auth check before any data is gathered, and anything
// other than a strict `true` (including a throwing check) is denied. Returns Web
// `Response` so it drops straight into a SvelteKit `+server.js` route, and the
// adapter can plumb uWS <-> Request/Response onto the reserved path.

import { introspect } from './introspect.js';
import { getDeadLetter, replayDeadLetter } from './webhooks.js';

// `no-store` so an admin snapshot can never linger in a shared/intermediary cache
// (defense-in-depth - the endpoint is already auth-gated and typically same-origin).
const _JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

/** @param {any} body @param {number} status */
function _json(body, status) {
	return new Response(JSON.stringify(body), { status, headers: _JSON_HEADERS });
}

/** Decode a single URL path segment (the topic in a DLQ path), tolerating a malformed encoding. */
function _decodeSegment(seg) {
	try { return decodeURIComponent(seg); } catch { return seg; }
}

/**
 * Build the admin request handler from `realtime({ admin })`. Throws if
 * `requires` is not a function - the route is fail-closed, so an auth check is
 * mandatory and a missing one is a configuration error, not a silent open door.
 * @param {{ requires: (request: Request) => boolean | Promise<boolean> }} adminConfig
 * @returns {(request: Request) => Promise<Response>}
 */
export function _createAdminHandler(adminConfig) {
	const requires = adminConfig && adminConfig.requires;
	if (typeof requires !== 'function') {
		throw new Error('[svelte-realtime] realtime({ admin }): admin.requires must be a function (request) => boolean | Promise<boolean>. The admin route is fail-closed, so an auth check is mandatory.');
	}
	return async function admin(request) {
		// Fail-closed auth gate: only a strict `true` admits. A non-true return
		// (false / undefined / a truthy non-true value) denies, and a throwing gate
		// denies too - an error in the auth check must never leak the snapshot.
		let allowed = false;
		try {
			allowed = (await requires(request)) === true;
		} catch {
			allowed = false;
		}
		if (!allowed) return _json({ error: 'forbidden' }, 403);

		let url;
		try {
			url = new URL(request.url);
		} catch {
			return _json({ error: 'bad request' }, 400);
		}
		// Route by the FINAL path segment, so the handler is mount-prefix agnostic:
		// it serves the same commands no matter what prefix it is mounted under -
		// the adapter's default `/__realtime`, a custom `websocket.adminPath`, or a
		// SvelteKit `+server.js` route at any path. Trailing slashes a proxy may
		// append are trimmed first. The auth gate already ran above, and the
		// handler is only reached on a path it was explicitly mounted on, so
		// matching the command segment within that namespace is safe. (Future
		// multi-segment commands, e.g. DLQ replay, match their own path tail.)
		const pathname = url.pathname.replace(/\/+$/, '');
		const method = request.method || 'GET';

		// Dead-letter queue (undeliverable outbound webhooks). Multi-segment
		// commands matched by path tail so they stay mount-prefix agnostic.
		let m;
		if ((m = pathname.match(/\/dlq\/([^/]+)\/replay$/))) {
			if (method !== 'POST') return _json({ error: 'method not allowed' }, 405);
			const topic = _decodeSegment(m[1]);
			let body = {};
			try {
				const text = await request.text();
				if (text) body = JSON.parse(text);
			} catch {
				return _json({ error: 'bad request' }, 400);
			}
			if (body == null || typeof body !== 'object') body = {};
			const out = await replayDeadLetter({
				topic,
				ids: Array.isArray(/** @type {any} */ (body).ids) ? /** @type {any} */ (body).ids : undefined,
				dryRun: /** @type {any} */ (body).dryRun === true
			});
			return _json(out, 200);
		}
		if ((m = pathname.match(/\/dlq\/([^/]+)$/))) {
			if (method !== 'GET') return _json({ error: 'method not allowed' }, 405);
			const topic = _decodeSegment(m[1]);
			const store = getDeadLetter();
			if (!store) return _json({ enabled: false, topic, count: 0, records: [] }, 200);
			const lim = parseInt(url.searchParams.get('limit') || '', 10);
			const limit = Number.isInteger(lim) && lim > 0 ? lim : 100;
			return _json({ enabled: true, topic, count: store.count({ topic }), records: store.list({ topic, limit }) }, 200);
		}
		if (pathname.endsWith('/dlq')) {
			if (method !== 'GET') return _json({ error: 'method not allowed' }, 405);
			const store = getDeadLetter();
			if (!store) return _json({ enabled: false, total: 0, byTopic: {}, oldest: null, newest: null }, 200);
			return _json({ enabled: true, ...store.summary() }, 200);
		}

		const sub = pathname.slice(pathname.lastIndexOf('/') + 1);

		if (sub === 'introspect') {
			const opts = {
				handlers: url.searchParams.get('handlers') === 'true',
				topics: url.searchParams.get('topics') === 'true'
			};
			return _json(introspect(opts), 200);
		}
		return _json({ error: 'not found' }, 404);
	};
}
