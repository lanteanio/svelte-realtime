// The subscribe hooks realtime() returns scope every subscribed topic to the
// connection's tenant before the application's own gate sees it: a
// tenant-scoped topic of another tenant, or any tenant-scoped topic of an
// untenanted connection, is refused first; the connection's own prefix is
// stripped, so a gate written against logical topic names keeps matching.
// A tenant-scoped server subscribe that the hooks never saw fails closed.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { live, realtime, __register, handleRpc } from '../src/server.js';
import { _resetTenantResolver } from '../src/server/tenant.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';

const SIDE_EFFECT_ONLY = Symbol.for('adapter-uws.hook.side-effect-only');
const flush = () => new Promise((r) => setTimeout(r, 10));
const ctx = { platform: { marker: true } };
let n = 0;

afterEach(() => { _resetTenantResolver(); });

/** The anchored gate an application writes against logical topic names. */
function auditGate() {
	return vi.fn((ws, topic) => {
		const match = /^audit:(acme|globex)$/.exec(topic);
		return match ? match[1] === ws.getUserData().org : true;
	});
}

describe('subscribe hooks from realtime()', () => {
	it('refuses another tenant\'s topic before the application gate runs', async () => {
		const gate = auditGate();
		const batchGate = vi.fn(() => ({}));
		const hooks = realtime({ tenant: (user) => user.org ?? null, subscribe: gate });
		const batched = realtime({ tenant: (user) => user.org ?? null, subscribeBatch: batchGate });
		const acme = mockWs({ id: 'a', org: 'acme' });
		expect(await hooks.subscribe(acme, '@t/globex/audit:globex', ctx)).toBe('FORBIDDEN');
		expect({ ...await batched.subscribeBatch(acme, ['@t/globex/audit:globex', '@t/globex/notes'], ctx) })
			.toEqual({ '@t/globex/audit:globex': 'FORBIDDEN', '@t/globex/notes': 'FORBIDDEN' });
		expect(gate).not.toHaveBeenCalled();
		expect(batchGate).not.toHaveBeenCalled();
	});

	it('refuses any tenant-scoped topic of an untenanted connection', async () => {
		const gate = auditGate();
		const hooks = realtime({ tenant: (user) => user.org ?? null, subscribe: gate });
		const anonymous = mockWs({ id: 'n' });
		expect(await hooks.subscribe(anonymous, '@t/acme/audit:acme', ctx)).toBe('FORBIDDEN');
		// 'null' is a valid tenant id; an untenanted connection must not reach it.
		expect(await hooks.subscribe(anonymous, '@t/null/notes', ctx)).toBe('FORBIDDEN');
		expect(gate).not.toHaveBeenCalled();
		const untenanted = realtime({ subscribe: gate });
		expect(await untenanted.subscribe(mockWs({ id: 'u' }), '@t/acme/notes', ctx)).toBe('FORBIDDEN');
		expect(await untenanted.subscribe(mockWs({ id: 'u' }), '@t/null/notes', ctx)).toBe('FORBIDDEN');
		expect(gate).not.toHaveBeenCalled();
	});

	it('hands the gate the logical topic, so an anchored pattern matches again', async () => {
		const gate = auditGate();
		const hooks = realtime({ tenant: (user) => user.org ?? null, subscribe: gate });
		const acme = mockWs({ id: 'a', org: 'acme' });
		expect(await hooks.subscribe(acme, '@t/acme/audit:globex', ctx)).toBe(false);
		expect(await hooks.subscribe(acme, '@t/acme/audit:acme', ctx)).toBe(true);
		expect(gate.mock.calls.map((call) => call[1])).toEqual(['audit:globex', 'audit:acme']);
		for (const call of gate.mock.calls) {
			expect(call[0]).toBe(acme);
		}
		expect(gate.mock.calls[0][2]).toEqual({ platform: ctx.platform, tenantId: 'acme', wireTopic: '@t/acme/audit:globex' });
		expect(gate.mock.calls[1][2]).toEqual({ platform: ctx.platform, tenantId: 'acme', wireTopic: '@t/acme/audit:acme' });
	});

	it('passes a bare topic of a tenanted connection through with its tenant on ctx', async () => {
		const gate = vi.fn(() => true);
		const hooks = realtime({ tenant: (user) => user.org ?? null, subscribe: gate });
		const acme = mockWs({ id: 'a', org: 'acme' });
		expect(await hooks.subscribe(acme, 'notices', ctx)).toBe(true);
		expect(gate).toHaveBeenCalledWith(acme, 'notices', { platform: ctx.platform, tenantId: 'acme', wireTopic: 'notices' });
	});

	it('returns no batch hook without a batch gate, so an application subscribe beside the hooks still decides', () => {
		const hooks = realtime({ tenant: (user) => user.org ?? null, subscribe: auditGate() });
		expect(hooks.subscribeBatch).toBe(undefined);
		expect(realtime({}).subscribeBatch).toBe(undefined);
	});

	it('maps a batch both ways and hands the gate the wire topics aligned with its topics', async () => {
		const gate = auditGate();
		const batchGate = vi.fn((ws, topics, gateCtx) => Object.fromEntries(topics.map((t) => [t, gate(ws, t, gateCtx)])));
		const hooks = realtime({ tenant: (user) => user.org ?? null, subscribeBatch: batchGate });
		const acme = mockWs({ id: 'a', org: 'acme' });
		const result = await hooks.subscribeBatch(acme, ['@t/acme/audit:globex', '@t/acme/audit:acme', 'audit:globex', '@t/globex/notes'], ctx);
		expect({ ...result }).toEqual({ '@t/acme/audit:globex': false, 'audit:globex': false, '@t/globex/notes': 'FORBIDDEN' });
		expect(batchGate.mock.calls[0][1]).toEqual(['audit:globex', 'audit:acme', 'audit:globex']);
		expect(batchGate.mock.calls[0][2]).toEqual({ platform: ctx.platform, tenantId: 'acme', wireTopics: ['@t/acme/audit:globex', '@t/acme/audit:acme', 'audit:globex'] });
	});

	it('hands a batch gate the logical topics and maps its answer back', async () => {
		const batchGate = vi.fn((ws, topics) => Object.fromEntries(topics.map((t) => [t, t === 'audit:acme' || 'NOT_YOURS'])));
		const hooks = realtime({ tenant: (user) => user.org ?? null, subscribeBatch: batchGate });
		const acme = mockWs({ id: 'a', org: 'acme' });
		expect({ ...await hooks.subscribeBatch(acme, ['@t/acme/audit:acme', '@t/acme/audit:globex'], ctx) }).toEqual({ '@t/acme/audit:globex': 'NOT_YOURS' });
		expect(batchGate.mock.calls[0][1]).toEqual(['audit:acme', 'audit:globex']);
		expect(await hooks.subscribe(acme, '@t/acme/audit:globex', ctx)).toBe('NOT_YOURS');
		expect(await hooks.subscribe(acme, '@t/acme/audit:acme', ctx)).toBe(undefined);
	});

	it('leaves the topic decision to the adapter when the application has no gate', () => {
		const bare = realtime({});
		expect(bare.subscribe[SIDE_EFFECT_ONLY]).toBe(true);
		const gated = realtime({ subscribe: () => true, subscribeBatch: () => ({}) });
		expect(gated.subscribe[SIDE_EFFECT_ONLY]).toBe(undefined);
		expect(gated.subscribeBatch[SIDE_EFFECT_ONLY]).toBe(undefined);
	});

	it('rejects a gate that is not a function at startup', () => {
		expect(() => realtime({ subscribe: 'yes' })).toThrow(/realtime\(\{ subscribe \}\)/);
		expect(() => realtime({ subscribeBatch: {} })).toThrow(/realtime\(\{ subscribeBatch \}\)/);
	});
});

describe('a tenant-scoped stream subscribe the hooks never saw', () => {
	function declare() {
		const path = 'tgate/audit' + ++n;
		const loads = [];
		__register(path, live.stream((ctx, org) => 'audit:' + org, async (ctx, org) => { loads.push(org); return [{ id: org }]; }, { merge: 'crud', key: 'id' }));
		return { path, loads };
	}

	it('fails closed, holds no membership and runs no loader', async () => {
		realtime({ tenant: (user) => user.org ?? null });
		const { path, loads } = declare();
		const platform = mockPlatform();
		platform.subscribeHook = null;
		const ws = mockWs({ id: 'a', org: 'acme' });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			handleRpc(ws, toArrayBuffer({ rpc: path, id: 's1', args: ['globex'], stream: true }), platform);
			await flush();
			expect(platform.sent[0].data).toMatchObject({ ok: false, code: 'TENANT_GUARD_REQUIRED' });
			expect(ws.getTopics()).toEqual([]);
			expect(loads).toEqual([]);
			expect(warn.mock.calls.some((c) => String(c[0]).includes('Export subscribe and subscribeBatch from the realtime() result'))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it('admits a second stream on a topic the socket already holds and keeps the first', async () => {
		realtime({ tenant: (user) => user.org ?? null });
		const id = ++n;
		const left = [];
		__register('tgate/list' + id, live.stream((ctx, org) => 'audit:' + org, async () => [{ id: 1 }], { merge: 'crud', key: 'id', onUnsubscribe: () => { left.push('list'); } }));
		__register('tgate/count' + id, live.stream((ctx, org) => 'audit:' + org, async () => ({ n: 1 }), { merge: 'set' }));
		const platform = mockPlatform();
		const ws = mockWs({ id: 'a', org: 'acme' });
		handleRpc(ws, toArrayBuffer({ rpc: 'tgate/list' + id, id: 's1', args: ['acme'], stream: true }), platform);
		await flush();
		handleRpc(ws, toArrayBuffer({ rpc: 'tgate/count' + id, id: 's2', args: ['acme'], stream: true }), platform);
		await flush();
		expect(platform.sent.map((frame) => frame.data.ok)).toEqual([true, true]);
		expect(ws.isSubscribed('@t/acme/audit:acme')).toBe(true);
		expect(left).toEqual([]);
	});

	it('keeps the adapter\'s own refusal and does not judge a subscribe it refused', async () => {
		realtime({ tenant: (user) => user.org ?? null });
		const { path } = declare();
		const platform = mockPlatform();
		platform.subscribeHook = null;
		platform.checkSubscribe = async () => 'RATE_LIMITED';
		const ws = mockWs({ id: 'a', org: 'acme' });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			handleRpc(ws, toArrayBuffer({ rpc: path, id: 's1', args: ['acme'], stream: true }), platform);
			await flush();
			expect(platform.sent[0].data).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
		} finally {
			warn.mockRestore();
		}
	});

	it('is admitted when the hooks are in the path, and an untenanted connection needs none', async () => {
		realtime({ tenant: (user) => user.org ?? null });
		const { path, loads } = declare();
		const platform = mockPlatform();
		const ws = mockWs({ id: 'a', org: 'acme' });
		handleRpc(ws, toArrayBuffer({ rpc: path, id: 's1', args: ['acme'], stream: true }), platform);
		await flush();
		expect(platform.sent[0].data).toMatchObject({ ok: true, topic: '@t/acme/audit:acme' });
		expect(loads).toEqual(['acme']);

		const bare = mockPlatform();
		bare.subscribeHook = null;
		const anonymous = mockWs({ id: 'n' });
		handleRpc(anonymous, toArrayBuffer({ rpc: path, id: 's2', args: ['public'], stream: true }), bare);
		await flush();
		expect(bare.sent[0].data).toMatchObject({ ok: true, topic: 'audit:public' });
	});
});
