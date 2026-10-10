import { afterEach, describe, expect, it } from 'vitest';
import { live, unsubscribe, _prepareHmr } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { _topicWsCounts, state } from '../src/server/state.js';
import { _setTenantResolver, _resetTenantResolver } from '../src/server/tenant.js';

let env;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
afterEach(() => { _resetTenantResolver(); env?.cleanup(); env = null; _prepareHmr(); });

function setup(fn, options, wrap = (value) => value) {
	env = createTestEnv();
	const derived = wrap(live.derived(() => ['source'], fn, options));
	env.register('stats', { derived });
	return { publish: () => env.platform.publish('source', 'set', null) };
}
async function join(user, ...args) {
	const client = env.connect(user);
	const stream = client.subscribe('stats/derived', ...args);
	await stream.waitFor(() => true);
	return { client, stream };
}

describe('dynamic derived identity', () => {
	it('delivers each authenticated identity only its own derived output', async () => {
		const { publish } = setup((ctx) => ctx.user.role);
		const admin = await join({ id: 'admin', role: 'ADMIN_ONLY' });
		const member = await join({ id: 'member', role: 'MEMBER' });
		expect(admin.stream.topic).not.toBe(member.stream.topic);
		publish(); await flush();
		expect(admin.stream.events.map((e) => e.data)).toEqual(['ADMIN_ONLY']);
		expect(member.stream.events.map((e) => e.data)).toEqual(['MEMBER']);
		admin.client.disconnect(); await flush(); publish(); await flush();
		expect(member.stream.events.map((e) => e.data)).toEqual(['MEMBER', 'MEMBER']);
	});

	it('never merges anonymous connections or delimiter-colliding arguments', async () => {
		const { publish } = setup((ctx, arg) => [ctx.user.label, arg]);
		const one = await join({ label: 'one' }, 'a~b');
		const two = await join({ label: 'two' }, 'ab');
		const sameArgs = await join({ label: 'three' }, 'a~b');
		expect(new Set([one.stream.topic, two.stream.topic, sameArgs.stream.topic]).size).toBe(3);
		publish(); await flush();
		expect(sameArgs.stream.value).toEqual(['three', 'a~b']);
	});

	it('recomputes shared identity from an active session after its first session leaves', async () => {
		const { publish } = setup((ctx) => ctx.user.role);
		const older = await join({ id: 'same', role: 'ADMIN_ONLY' });
		const current = await join({ id: 'same', role: 'MEMBER' });
		expect(older.stream.topic).toBe(current.stream.topic);
		older.client.disconnect(); await flush(); publish(); await flush();
		expect(current.stream.events.map((e) => e.data)).toEqual(['MEMBER']);
	});

	it('discards an in-flight departed context before recomputing for the remaining scope', async () => {
		let delayed = false;
		const pending = [];
		const { publish } = setup((ctx) => delayed
			? new Promise(resolve => pending.push({ role: ctx.user.role, resolve })) : ctx.user.role,
			{ scopeKey: () => 'shared' });
		const older = await join({ id: 'admin', role: 'ADMIN_ONLY' });
		const current = await join({ id: 'member', role: 'MEMBER' });
		delayed = true; publish();
		expect(pending).toHaveLength(1);
		older.client.disconnect(); await flush();
		pending[0].resolve(pending[0].role); await flush();
		expect(current.stream.events).toEqual([]);
		expect(pending).toHaveLength(2);
		pending[1].resolve(pending[1].role); await flush();
		expect(current.stream.events.map((e) => e.data)).toEqual(['MEMBER']);
	});

	it('passes context and arguments into explicit scope keys and keeps arguments collision-safe', async () => {
		const { publish } = setup((ctx, value) => value, { scopeKey: (ctx) => ctx.user.group });
		const one = await join({ id: 'one', group: 'team' }, 'a~b');
		const shared = await join({ id: 'two', group: 'team' }, 'a~b');
		const different = await join({ id: 'one', group: 'team' }, 'ab');
		expect(one.stream.topic).toBe(shared.stream.topic);
		expect(one.stream.topic).not.toBe(different.stream.topic);
		publish(); await flush();
		expect(shared.stream.value).toBe('a~b');
		expect(different.stream.value).toBe('ab');
	});

	it('preserves scope and lifecycle registration through stream wrappers', async () => {
		const { publish } = setup((ctx) => ctx.user.id, { scopeKey: (ctx) => ctx.user.id }, (fn) => live.scoped(() => true, fn));
		const { stream } = await join({ id: 'one' });
		publish(); await flush();
		expect(stream.events.map((e) => e.data)).toEqual(['one']);
	});
	it('revokes a connection that changes identity before another session publishes', async () => {
		const { publish } = setup((ctx) => ctx.user.role);
		const user = { id: 'same', role: 'ADMIN_ONLY' };
		const revoked = await join(user);
		const remaining = await join({ id: 'same', role: 'ADMIN_ONLY' });
		user.id = 'different'; user.role = 'MEMBER';
		publish(); await flush();
		expect(revoked.stream.events).toEqual([]);
		expect(remaining.stream.events.map((e) => e.data)).toEqual(['ADMIN_ONLY']);
	});

	it('rechecks explicit scope authorization after an asynchronous computation', async () => {
		let resolve;
		let delayed = false;
		const { publish } = setup((ctx) => delayed ? new Promise(r => { resolve = r; }) : ctx.user.role,
			{ scopeKey: (ctx) => ctx.user.role });
		const user = { id: 'same', role: 'ADMIN_ONLY' };
		const revoked = await join(user);
		delayed = true; publish();
		user.role = 'MEMBER';
		resolve('ADMIN_ONLY'); await flush();
		expect(revoked.stream.events).toEqual([]);
	});

	it('reads replacement session data from the remaining active connection', async () => {
		let socket;
		const { publish } = setup((ctx) => { socket = ctx.ws; return ctx.user.role; });
		const { stream } = await join({ id: 'same', role: 'ADMIN_ONLY' });
		socket.getUserData = () => ({ id: 'same', role: 'MEMBER' });
		publish(); await flush();
		expect(stream.events.map((e) => e.data)).toEqual(['MEMBER']);
	});

	it('allows a revoked connection to resubscribe under its current scope', async () => {
		const { publish } = setup((ctx) => ctx.user.id);
		const user = { id: 'one' };
		// The adapter's programmatic revoke fires the public lifecycle hook too.
		env.platform.unsubscribe = (ws, topic) => {
			ws.unsubscribe(topic);
			unsubscribe(ws, topic, { platform: env.platform });
			return true;
		};
		const { client, stream } = await join(user);
		user.id = 'two'; publish(); await flush();
		const current = client.subscribe('stats/derived');
		await current.waitFor(() => true);
		publish(); await flush();
		expect(stream.events).toEqual([]);
		expect(current.events.map((e) => e.data)).toEqual(['two']);
	});

	it('rejects invalid scope keys and drains rejected asynchronous keys', async () => {
		for (const scopeKey of [() => ({}), () => NaN, async () => { throw new Error('invalid async scope'); }]) {
			const fn = live.derived(() => ['source'], () => 1, { scopeKey });
			expect(() => fn.__streamTopic({})).toThrow('synchronously');
		}
		await flush();
		expect(() => live.derived(['source'], () => 1, { scopeKey: () => 'scope' })).toThrow('dynamic sources');
	});

	it('rejects a scope change while the initial snapshot is loading', async () => {
		let finish;
		const user = { id: 'admin' };
		setup(() => new Promise(resolve => { finish = resolve; }));
		const stream = env.connect(user).subscribe('stats/derived');
		await flush();
		user.id = 'member'; finish('ADMIN_ONLY'); await flush();
		expect(stream.value).toBeUndefined();
		expect(stream.error?.code).toBe('FORBIDDEN');
	});

	it('rejects a scope change during asynchronous subscribe admission', async () => {
		let admit;
		let computed = false;
		setup(() => { computed = true; return 'ADMIN_ONLY'; });
		env.platform.subscribe = (ws, topic) => new Promise(resolve => { admit = () => { ws.subscribe(topic); resolve(null); }; });
		const user = { id: 'admin' };
		const stream = env.connect(user).subscribe('stats/derived');
		await flush();
		user.id = 'member'; admit(); await flush();
		expect(computed).toBe(false);
		expect(stream.value).toBeUndefined();
		expect(stream.error?.code).toBe('FORBIDDEN');
	});

	it('revokes subscribers when their custom scope callback begins throwing', async () => {
		let authorized = true;
		const { publish } = setup(() => 'ADMIN_ONLY', { scopeKey: () => {
			if (!authorized) throw new Error('Access withdrawn');
			return 'authorized';
		} });
		const { stream } = await join({ id: 'one' });
		authorized = false; publish(); await flush();
		authorized = true; publish(); await flush();
		expect(stream.events).toEqual([]);
	});

	it.each(['session', 'tenant'])('cleans ownership when %s lookup throws during revocation', async (failure) => {
		let invalid = false;
		let socket;
		_setTenantResolver(() => { if (invalid && failure === 'tenant') throw new Error('tenant unavailable'); return 'a'; });
		setup((ctx) => { socket = ctx.ws; return 'data'; });
		const { stream } = await join({ id: 'one' });
		const getUserData = socket.getUserData;
		socket.getUserData = () => { if (invalid && failure === 'session') throw new Error('session unavailable'); return getUserData(); };
		try {
			invalid = true;
			env.platform.publish('@t/a/source', 'set', null); await flush();
			expect(socket.isSubscribed(stream.topic)).toBe(false);
			expect(_topicWsCounts.has(stream.topic)).toBe(false);
		} finally { invalid = false; socket.getUserData = getUserData; }
	});

	it('does not double-release a pending snapshot after scope revocation', async () => {
		let finish;
		const { publish } = setup(() => new Promise(resolve => { finish = resolve; }));
		const previousMetrics = state.metricsInstruments;
		let subscriptions = 0;
		state.metricsInstruments = {
			streamGauge: { inc: () => subscriptions++, dec: () => subscriptions-- },
			rpcCount: { inc() {} }, rpcErrors: { inc() {} }, rpcDuration: { observe() {} }
		};
		try {
			const user = { id: 'admin' };
			const stream = env.connect(user).subscribe('stats/derived');
			await flush(); expect(subscriptions).toBe(1);
			user.id = 'member'; publish(); await flush();
			expect(subscriptions).toBe(0);
			finish('ADMIN_ONLY'); await flush();
			expect(stream.error?.code).toBe('FORBIDDEN');
			expect(subscriptions).toBe(0);
		} finally { state.metricsInstruments = previousMetrics; }
	});

	it.each(['resolve', 'reject'])('keeps a new subscription when an old revoked loader later %ss', async (outcome) => {
		let settle;
		let first = true;
		const { publish } = setup((ctx) => {
			if (first) { first = false; return new Promise((resolve, reject) => { settle = outcome === 'resolve' ? () => resolve('OLD') : () => reject(new Error('Old loader failed')); }); }
			return ctx.user.id;
		});
		const user = { id: 'one' };
		const client = env.connect(user);
		const old = client.subscribe('stats/derived'); await flush();
		user.id = 'two'; publish(); await flush();
		user.id = 'one';
		const current = client.subscribe('stats/derived'); await current.waitFor(() => true);
		settle(); await flush(); publish(); await flush();
		expect(old.value).toBeUndefined();
		expect(current.events.map((e) => e.data)).toEqual(['one']);
	});

});
