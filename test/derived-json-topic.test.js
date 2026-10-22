// Dynamic derived streams whose arguments are JSON strings (a widget
// configuration, say) driven end to end through the real adapter: the adapter
// refuses wire topics with quotes, backslashes, control bytes or more than 256
// characters, so the output topic must stay transport-valid for any argument
// while instances remain isolated per tenant and per argument.

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, isValidWireTopic } from 'svelte-adapter-uws/testing';
import { live, realtime, LiveError, __register, __registerDerived, _activateDerived, _prepareHmr, _resetLifecycle } from '../src/server.js';
import { _setTenantResolver, _resetTenantResolver } from '../src/server/tenant.js';
import { _derivedTopic } from '../src/server/derived-topic.js';

const ORG_A = '3f2b8c1e-7d4a-4e5b-9c6d-0a1b2c3d4e5f';
const ORG_B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what) {
	const end = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= end) throw new Error('Timed out waiting for ' + what);
		await sleep(5);
	}
}

let server;
let sockets;
let users;
let orders;

async function start() {
	server = await createTestServer({ handler: { ...realtime(), upgrade() { return users.shift(); } } });
	_activateDerived(server.platform);
}

async function connect(user) {
	users.push(user);
	const socket = new WebSocket(server.wsUrl);
	const frames = [];
	socket.addEventListener('message', ({ data }) => {
		if (typeof data !== 'string') return;
		const frame = JSON.parse(data);
		if (frame.type === 'batch' && Array.isArray(frame.events)) frames.push(...frame.events);
		else frames.push(frame);
	});
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', reject, { once: true });
	});
	sockets.push(socket);
	let next = 0;
	const reply = (id) => frames.find((f) => f.topic === '__rpc' && f.event === id && typeof f.data?.ok === 'boolean')?.data;
	return {
		frames,
		delivered: (topic) => frames.filter((f) => f.topic === topic && f.event === 'set').map((f) => f.data),
		async subscribe(path, ...args) {
			const id = 's' + (++next);
			socket.send(JSON.stringify({ rpc: path, id, args, stream: true, attach: true }));
			await until(() => reply(id), 'the subscribe reply');
			return reply(id);
		},
		async call(path, ...args) {
			const id = 'c' + (++next);
			socket.send(JSON.stringify({ rpc: path, id, args }));
			await until(() => reply(id), 'the call reply');
			return reply(id);
		}
	};
}

function registerDashboard(path = 'dashboard/widgets/metric') {
	// Registered the way the generated registry does: as an RPC and as a derived.
	const widget = live.derived(
		(orgId) => ['orders:' + orgId],
		async (ctx, orgId, config) => {
			if (ctx.user.org !== orgId) throw new LiveError('FORBIDDEN', 'Not your organization');
			const { metric } = JSON.parse(config);
			return { metric, value: orders.get(orgId) ?? 0 };
		}
	);
	__register(path, widget);
	__registerDerived(path, widget);
	__register('dashboard/orders/place', live((ctx) => {
		const org = ctx.user.org;
		orders.set(org, (orders.get(org) ?? 0) + 1);
		ctx.publish('orders:' + org, 'created', { count: orders.get(org) });
		return orders.get(org);
	}));
}

const config = JSON.stringify({ metric: 'orders', range: '7d', label: 'say "hi" \\ to ~all~', filter: { status: ['open', 'paid'] } });

beforeEach(() => {
	sockets = [];
	users = [];
	orders = new Map();
	_resetLifecycle();
	_setTenantResolver((user) => user.org);
});

afterEach(async () => {
	for (const socket of sockets) socket.close();
	await server?.close();
	server = null;
	_resetTenantResolver();
	_prepareHmr();
});

describe('dynamic derived streams with JSON arguments over the real adapter', () => {
	it('admits the subscription and delivers the value recomputed after a mutation', async () => {
		registerDashboard();
		await start();
		const alice = await connect({ id: 'alice', org: ORG_A });
		const res = await alice.subscribe('dashboard/widgets/metric', ORG_A, config);
		expect(res).toMatchObject({ ok: true, data: { metric: 'orders', value: 0 } });
		expect(isValidWireTopic(res.topic)).toBe(true);
		expect(res.topic.length).toBeLessThanOrEqual(256);

		expect(await alice.call('dashboard/orders/place')).toMatchObject({ ok: true, data: 1 });
		await until(() => alice.delivered(res.topic).length > 0, 'the recomputed value');
		expect(alice.delivered(res.topic)).toEqual([{ metric: 'orders', value: 1 }]);
	});

	it('keeps tenants apart and refuses another organization\'s arguments', async () => {
		registerDashboard();
		await start();
		const alice = await connect({ id: 'alice', org: ORG_A });
		const bob = await connect({ id: 'bob', org: ORG_B });
		const mallory = await connect({ id: 'mallory', org: ORG_B });
		const a = await alice.subscribe('dashboard/widgets/metric', ORG_A, config);
		const b = await bob.subscribe('dashboard/widgets/metric', ORG_B, config);
		const denied = await mallory.subscribe('dashboard/widgets/metric', ORG_A, config);
		expect(a.ok && b.ok).toBe(true);
		expect(a.topic).not.toBe(b.topic);
		expect(denied).toMatchObject({ ok: false, code: 'FORBIDDEN' });

		await alice.call('dashboard/orders/place');
		await until(() => alice.delivered(a.topic).length > 0, 'the tenant A value');
		await sleep(30);
		expect(bob.delivered(b.topic)).toEqual([]);
		expect(mallory.frames.some((f) => f.event === 'set')).toBe(false);

		await bob.call('dashboard/orders/place');
		await bob.call('dashboard/orders/place');
		await until(() => bob.delivered(b.topic).length > 0, 'the tenant B value');
		expect(bob.delivered(b.topic).at(-1)).toEqual({ metric: 'orders', value: 2 });
		expect(alice.delivered(a.topic)).toEqual([{ metric: 'orders', value: 1 }]);
	});

	it('bounds the topic for large arguments and long module paths, and keeps distinct arguments apart', async () => {
		const longPath = 'dashboard/' + 'w'.repeat(150) + '/metric';
		registerDashboard(longPath);
		await start();
		const alice = await connect({ id: 'alice', org: ORG_A });
		const large = JSON.stringify({ metric: 'orders', notes: 'x'.repeat(6000) });
		const results = [];
		for (const arg of [large, config, JSON.stringify({ metric: 'orders', label: 'a~b' }), JSON.stringify({ metric: 'orders', label: 'ab~' })]) {
			const res = await alice.subscribe(longPath, ORG_A, arg);
			expect(res.ok).toBe(true);
			expect(isValidWireTopic(res.topic)).toBe(true);
			expect(res.topic.length).toBeLessThanOrEqual(256);
			results.push(res.topic);
		}
		expect(new Set(results).size).toBe(results.length);
	});
});

describe('derived output topic shape', () => {
	it('keeps long module paths that share a prefix apart', () => {
		const prefix = 'routes/' + 'a'.repeat(140);
		const one = _derivedTopic(prefix + '/one', ['user', 'u1'], ['x']);
		const two = _derivedTopic(prefix + '/two', ['user', 'u1'], ['x']);
		expect(one).not.toBe(two);
		expect(one.length).toBe(two.length);
		expect(isValidWireTopic('@t/' + 'b'.repeat(64) + '/' + one)).toBe(true);
	});

	it('leaves the topic of a short module path unchanged', () => {
		// Replicas on the previous release derive the same topic for the same instance.
		const digest = createHash('sha256').update(JSON.stringify([['user', 'u1'], ['org']])).digest('hex');
		expect(_derivedTopic('dashboard/stats', ['user', 'u1'], ['org'])).toBe('dashboard/stats~' + digest);
	});
});
