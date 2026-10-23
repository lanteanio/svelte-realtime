// A stream path answers only a subscribe frame. A plain RPC frame (no
// `stream: true`) naming a stream would otherwise run the stream's loader
// directly, skipping its access/filter predicate, its args schema and its
// gate, and hand the snapshot to a caller that may not subscribe.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { live, LiveError, guard } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { handleRpc } from '../src/server/dispatch.js';

const textEncoder = new TextEncoder();
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function rawConn(env, userData) {
	const sent = [];
	const topics = new Set();
	const ws = {
		getUserData: () => userData,
		subscribe: (t) => { topics.add(t); return true; },
		unsubscribe: (t) => { topics.delete(t); return true; },
		isSubscribed: (t) => topics.has(t),
		getTopics: () => [...topics],
		_onSend: (topic, event, data) => { sent.push({ topic, event, data }); }
	};
	env.platform.connections++;
	return { ws, sent, topics };
}

function send(conn, env, frame) {
	handleRpc(conn.ws, textEncoder.encode(JSON.stringify(frame)).buffer, env.platform);
}

function reply(conn, id) {
	const hit = conn.sent.find((f) => f.topic === '__rpc' && f.event === id);
	return hit ? hit.data : undefined;
}

describe('plain RPC frames to stream paths', () => {
	let env, loads;
	const alice = { id: 'alice', role: 'admin' };
	const mallory = { id: 'mallory', role: 'guest' };

	beforeEach(() => {
		env = createTestEnv();
		loads = 0;
		// live.stream tags its loader function, so each stream gets its own.
		const loader = () => async () => { loads++; return [{ id: 1, secret: 'payroll' }]; };
		env.register('vault', {
			byAccess: live.stream('vault:access', loader(), { access: (ctx) => ctx.user.role === 'admin' }),
			byFilter: live.stream('vault:filter', loader(), { filter: (ctx) => ctx.user.role === 'admin' }),
			byArgs: live.stream((ctx, n) => 'vault:args:' + n, loader(), {
				args: { '~standard': { version: 1, vendor: 'test', validate: (v) => (Array.isArray(v) && typeof v[0] === 'number' ? { value: v } : { issues: [{ message: 'n must be a number' }] }) } }
			}),
			gated: live.gate((ctx) => ctx.user.role === 'admin', live.stream('vault:gated', loader())),
			scoped: live.scoped((ctx) => ctx.user.role === 'admin', live.stream('vault:scoped', loader(), { access: (ctx) => ctx.user.role === 'admin' })),
			paged: live.stream('vault:paged', async () => { loads++; return { data: [{ id: 1 }], hasMore: true, cursor: 1 }; }, { access: (ctx) => ctx.user.role === 'admin' }),
			chan: live.channel('vault:chan'),
			derivedView: live.derived(['vault:src'], async () => { loads++; return { total: 42 }; }),
			agg: live.aggregate('vault:orders', { count: { init: () => 0, reduce: (n) => n + 1 } }, { topic: 'vault:count' }),
			flag: live.flag('vault:flag', true),
			room: live.room({
				topic: (ctx, id) => 'vault:room:' + id,
				init: async () => { loads++; return [{ id: 1, secret: 'room' }]; },
				guard: (ctx) => { if (ctx.user.role !== 'admin') throw new LiveError('FORBIDDEN', 'no'); },
				presence: (ctx) => ({ id: ctx.user.id })
			}),
			ping: live(async () => 'pong')
		});
	});

	afterEach(() => { env.cleanup(); });

	const guardedPaths = ['vault/byAccess', 'vault/byFilter', 'vault/scoped', 'vault/paged', 'vault/gated'];

	for (const path of guardedPaths) {
		it(`${path}: a plain call is refused and the loader never runs`, async () => {
			const c = env.connect(mallory);
			await expect(c.call(path)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
			expect(loads).toBe(0);
		});
	}

	it('a plain call skips no args schema: refused before validation or loading', async () => {
		const c = env.connect(alice);
		await expect(c.call('vault/byArgs', 'not-a-number')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		expect(loads).toBe(0);
	});

	for (const path of ['vault/chan', 'vault/derivedView', 'vault/agg', 'vault/flag', 'vault/room/__data', 'vault/room/__presence']) {
		it(`${path}: a plain call is refused`, async () => {
			const c = env.connect(mallory);
			await expect(c.call(path, 'r1')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
			expect(loads).toBe(0);
		});
	}

	it('a stream entry inside a batch frame is refused per entry, other entries still answer', async () => {
		const conn = rawConn(env, mallory);
		send(conn, env, { batch: [
			{ rpc: 'vault/byAccess', id: 'a' },
			{ rpc: 'vault/ping', id: 'b' }
		] });
		await settle();
		const batch = reply(conn, '__batch');
		expect(batch).toBeDefined();
		const [a, b] = batch.batch;
		expect(a).toMatchObject({ id: 'a', ok: false, code: 'INVALID_REQUEST' });
		expect(a.data).toBeUndefined();
		expect(b).toMatchObject({ id: 'b', ok: true, data: 'pong' });
		expect(loads).toBe(0);
	});

	it('a fire-and-forget frame to a stream path never runs the loader', async () => {
		const conn = rawConn(env, mallory);
		send(conn, env, { rpc: 'vault/byAccess', args: [] });
		await settle();
		expect(loads).toBe(0);
	});

	it('the module guard still runs first: a denied guard answers with its own code', async () => {
		env.register('locked', {
			_guard: guard((ctx) => { if (ctx.user.role !== 'admin') throw new LiveError('UNAUTHENTICATED', 'sign in'); }),
			feed: live.stream('locked:feed', async () => { loads++; return []; })
		});
		const c = env.connect(mallory);
		await expect(c.call('locked/feed')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
		expect(loads).toBe(0);
	});

	it('subscribing still works for an allowed user and is still denied for others', async () => {
		const ok = env.connect(alice).subscribe('vault/byAccess');
		await settle();
		expect(ok.error).toBeNull();
		expect(ok.value).toEqual([{ id: 1, secret: 'payroll' }]);

		const denied = env.connect(mallory).subscribe('vault/byAccess');
		await settle();
		expect(denied.error).toMatchObject({ code: 'FORBIDDEN' });
		expect(loads).toBe(1);
	});

	it('a plain RPC still answers, also with stream: true on the frame', async () => {
		const c = env.connect(mallory);
		await expect(c.call('vault/ping')).resolves.toBe('pong');
		const conn = rawConn(env, mallory);
		send(conn, env, { rpc: 'vault/ping', id: 's', args: [], stream: true });
		await settle();
		expect(reply(conn, 's')).toMatchObject({ ok: true, data: 'pong' });
	});

	it('a loader shared by a plain RPC and streams keeps each entry its own kind and options', async () => {
		let calls = 0;
		const fetchItems = async () => { calls++; return [{ id: 1 }]; };
		env.register('shared', {
			list: live(fetchItems),
			adminFeed: live.stream('shared:admin', fetchItems, { access: (ctx) => ctx.user.role === 'admin' }),
			openFeed: live.stream('shared:open', fetchItems)
		});
		const c = env.connect(mallory);
		await expect(c.call('shared/list')).resolves.toEqual([{ id: 1 }]);
		const open = c.subscribe('shared/openFeed');
		const admin = c.subscribe('shared/adminFeed');
		await settle();
		expect(open.error).toBeNull();
		expect(admin.error).toMatchObject({ code: 'FORBIDDEN' });
		expect(calls).toBe(2);
		expect(fetchItems.__isStream).toBeUndefined();
	});
});
