import { expect, it, vi } from 'vitest';
import { runCrdtConvergence } from 'svelte-realtime/sim';
import { createTestServer } from 'svelte-adapter-uws/testing';

vi.mock('svelte-adapter-uws/testing', async importOriginal => {
	const actual = await importOriginal();
	return { ...actual, createTestServer: vi.fn(options => actual.createTestServer(options)) };
});

it('restricts the actual native oracle route to loopback peers at a fresh opaque path', async () => {
	const first = await runCrdtConvergence({ seed: 'route-isolation', replicas: 2, operations: 2 });
	const options = createTestServer.mock.calls.at(-1)[0];
	for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '0000:0000:0000:0000:0000:0000:0000:0001', '0:0:0:0:0:ffff:7f00:1']) {
		expect(await options.handler.upgrade({ remoteAddress })).toEqual({});
	}
	for (const remoteAddress of [undefined, '', '192.0.2.1', '127.0.0.1.attacker', '::ffff:192.0.2.1']) {
		expect(await options.handler.upgrade({ remoteAddress, headers: { 'x-forwarded-for': '127.0.0.1' } })).toBe(false);
	}
	expect(options.wsPath).toMatch(/^\/crdt-oracle\/[a-f0-9]{48}$/);
	const second = await runCrdtConvergence({ seed: 'route-isolation', replicas: 2, operations: 2 });
	expect(createTestServer.mock.calls.at(-1)[0].wsPath).not.toBe(options.wsPath);
	expect(second).toEqual(first);
});

it('runs the public no-configuration composition with actual native work', async () => {
	const result = await runCrdtConvergence();
	expect(result.ok).toBe(true);
	expect(result.seed).toBe('realtime-crdt-0');
	expect(result.fault).toBe('reorder-duplicate');
	expect(result.replicas).toBe(3);
	expect(result.executed).toBe(48);
	expect(result.generatedUpdates).toBe(48);
	expect(result.updateRequests).toBe(64);
	// A duplicated request that adds no state is not fanned out again, so each
	// distinct update reaches every other replica exactly once.
	expect(result.deliveries).toBe(result.generatedUpdates * (result.replicas - 1));
	expect(result.deliveries).toBe(96);
});

it('rejects overlapping runs without corrupting the active native run', async () => {
	const active = runCrdtConvergence({ seed: 'active-native-run', operations: 12 });
	await expect(runCrdtConvergence({ seed: 'overlapping-run' })).rejects.toThrow('one at a time');
	expect((await active).ok).toBe(true);
});

it('executes concurrent document edits through native RPCs and validates an independent model', async () => {
	const result = await runCrdtConvergence({ seed: 'native-crdt', operations: 18 });
	expect(result.ok).toBe(true);
	expect(result.executed).toBe(18);
	expect(result.generatedUpdates).toBe(18);
	expect(result.updateRequests).toBe(24);
	expect(result.deliveries).toBe(result.generatedUpdates * (result.replicas - 1));
	expect(result.deliveries).toBe(36);
	expect(result.actual).toHaveLength(4);
	expect(result.actual.every(state => JSON.stringify(state) === JSON.stringify(result.actual[0]))).toBe(true);
	expect(result.actual[0].map).toEqual(result.expected.map);
	expect(result.actual[0].array).toEqual(result.expected.array);
	expect(result.actual[0].text).toBe(result.expected.text);
	expect(result.failures).toEqual([]);
	expect(result.provenance.realtime.name).toBe('svelte-realtime');
	expect(result.provenance.adapter.name).toBe('svelte-adapter-uws');
	expect(result.provenance.yjs.name).toBe('yjs');
	for (const digest of Object.values(result.provenance.sources)) expect(digest).toMatch(/^[a-f0-9]{64}$/);
});

it('independently predicts complete order for concurrent append and prepend writers', async () => {
	const result = await runCrdtConvergence({ seed: 'minimum-order', replicas: 2, operations: 2 });
	expect(result.ok).toBe(true);
	expect(result.expected.array).toEqual(['edit-0', 'edit-1']);
	expect(result.expected.text).toBe('\u1000\u1001');
	for (const state of result.actual) expect(state).toEqual(result.expected);
});

it.each(['ordered', 'reorder-duplicate'])('replays the exact seed and actual counts under %s delivery', async fault => {
	const config = { seed: 'repeatable-documents', replicas: 4, operations: 24, fault };
	const first = await runCrdtConvergence(config);
	const second = await runCrdtConvergence(config);
	expect(first.ok).toBe(true);
	expect(second).toEqual(first);
	expect(first.executed).toBe(24);
});

it.each(['drop-update', 'corrupt-update'])('rejects an omitted genuine update under %s', async fault => {
	const result = await runCrdtConvergence({ seed: 'negative-control', operations: 15, fault });
	expect(result.executed).toBe(15);
	expect(result.generatedUpdates).toBe(15);
	expect(result.ok).toBe(false);
	expect(result.faulted).toBeGreaterThan(0);
	expect(result.failures).toContainEqual({ replica: 0, invariant: 'map-state' });
	expect(result.actual[0].map).not.toEqual(result.expected.map);
});

it('records the configured count only after transactions actually execute', async () => {
	const result = await runCrdtConvergence({ seed: 7, replicas: 2, operations: 7 });
	expect(result.ok).toBe(true);
	expect(result.executed).toBe(7);
	expect(result.generatedUpdates).toBe(7);
	expect(new Set(result.trace.map(item => item.index)).size).toBe(7);
});

it.each([{ replicas: 1 }, { replicas: 9 }, { operations: 0 }, { operations: 513 }, { fault: 'unknown' }])('rejects unsupported configurations before execution: %j', async config => {
	await expect(runCrdtConvergence(config)).rejects.toThrow();
});
