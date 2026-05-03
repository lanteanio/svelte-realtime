import { message as _realtimeMessage, close, unsubscribe } from 'svelte-realtime/server';

export { close, unsubscribe };

// Optional Redis pubsub bus. When REDIS_URL is set (the chaos harness
// passes this via env), every per-connection ctx.publish is routed
// through the bus so it lands locally AND on every other instance
// connected to the same Redis. When REDIS_URL is unset, behavior is
// identical to the previous fixture (no bus, single-instance).
//
// Top-level await keeps the lazy-import conditional: production
// fixtures that never set REDIS_URL never load `ioredis` or the
// extensions package.
let _bus = null;
if (process.env.REDIS_URL) {
	const { createRedisClient } = await import('svelte-adapter-uws-extensions/redis');
	const { createPubSubBus } = await import('svelte-adapter-uws-extensions/redis/pubsub');
	const _redis = createRedisClient({ url: process.env.REDIS_URL });
	_bus = createPubSubBus(_redis);
}

const _wrappedPlatformByPlatform = new WeakMap();
function _wrapPlatform(platform) {
	if (!_bus) return platform;
	let w = _wrappedPlatformByPlatform.get(platform);
	if (!w) {
		w = _bus.wrap(platform);
		_wrappedPlatformByPlatform.set(platform, w);
	}
	return w;
}

export async function open(ws, ctx) {
	if (_bus) await _bus.activate(ctx.platform);
}

export function message(ws, ctx) {
	const platform = _wrapPlatform(ctx.platform);
	return _realtimeMessage(ws, { ...ctx, platform });
}

// Read user identity from cookies. Multi-page-auth e2e tests set
// `user` and `role` cookies via `context.addCookies(...)` BEFORE
// page.goto, so the WS upgrade includes them. Defaults keep the
// queue-replay / lock / smoke / reconnect / multi-page tests working
// unchanged (they don't set cookies).
export function upgrade({ cookies }) {
	const id = (cookies && cookies.user) || 'e2e-user';
	const role = (cookies && cookies.role) || 'user';
	return { id, role };
}
