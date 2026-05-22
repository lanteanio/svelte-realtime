import { message, close, unsubscribe, setBus } from 'svelte-realtime/server';

export { message, close, unsubscribe };

// Optional Redis pubsub bus. When REDIS_URL is set (the chaos harness
// passes this via env), `setBus(bus)` wires the process-wide cluster
// bus and every framework publish surface (RPC `ctx.publish`, cron
// tick, reactive watchers' publish wrap, `live.webhook`, the top-
// level `publish()` helper) relays through it automatically - no
// per-hook wiring. When REDIS_URL is unset, no bus is wired and
// publishes stay local (single-replica behaviour, identical to the
// pre-bus fixture).
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
	setBus(_bus);
}

export async function open(ws, ctx) {
	// `_bus.activate(platform)` registers this instance as a relay
	// receiver - it subscribes to the bus's inbound channel and re-
	// emits messages locally. Independent of the publish-wrap side
	// (handled by `setBus(_bus)` above at module top-level), so we
	// still need this in `open` for inbound delivery on this instance.
	if (_bus) await _bus.activate(ctx.platform);
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
