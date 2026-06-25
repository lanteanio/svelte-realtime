import { describe, it, expect, afterEach } from 'vitest';
import { live, __register, handleRpc, _clearCron } from '../src/server.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';

// RPC responses are written on the dispatch microtask; flush before asserting.
const flush = () => new Promise((r) => setTimeout(r, 0));

function call(ws, platform, rpc, id) {
	return handleRpc(ws, toArrayBuffer({ rpc, id, args: [] }), platform);
}

describe('live.deprecate', () => {
	afterEach(() => {
		_clearCron();
	});

	it('validates its arguments', () => {
		expect(() => live.deprecate(123)).toThrow(/requires a handler function/);
		expect(() => live.deprecate(() => {}, null)).toThrow(/options must be an object/);
		expect(() => live.deprecate(() => {}, { since: 5 })).toThrow(/since must be a string/);
		expect(() => live.deprecate(() => {}, { use: {} })).toThrow(/use must be a string/);
		expect(() => live.deprecate(() => {})).not.toThrow();
		expect(() => live.deprecate(() => {}, {})).not.toThrow();
	});

	it('marks the handler in place without altering its identity', () => {
		const fn = async () => {};
		const out = live.deprecate(fn, { since: '0.6', use: 'newThing', message: 'gone soon', removeBy: '0.7' });
		expect(out).toBe(fn);
		expect(/** @type {any} */ (fn).__isLive).toBe(true);
		expect(/** @type {any} */ (fn).__deprecated).toEqual({ since: '0.6', use: 'newThing', message: 'gone soon', removeBy: '0.7' });
	});

	it('attaches a one-shot deprecation signal to the first response per connection', async () => {
		__register('deprecate-test/old', live.deprecate(async () => 'ok', { since: '0.6', use: 'deprecate-test/new' }));
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();

		call(ws, platform, 'deprecate-test/old', 'a');
		await flush();
		const first = platform.sent.find((m) => m.event === 'a');
		expect(first.data.ok).toBe(true);
		expect(first.data.data).toBe('ok');
		expect(first.data.deprecation).toEqual({ path: 'deprecate-test/old', since: '0.6', use: 'deprecate-test/new' });

		// Second call on the SAME connection: signal suppressed (deduped per ws+path).
		call(ws, platform, 'deprecate-test/old', 'b');
		await flush();
		const second = platform.sent.find((m) => m.event === 'b');
		expect(second.data.ok).toBe(true);
		expect(second.data.deprecation).toBeUndefined();
	});

	it('signals each connection independently', async () => {
		__register('deprecate-test/each', live.deprecate(async () => 'ok'));
		const wsA = mockWs({ id: 'a' });
		const wsB = mockWs({ id: 'b' });
		const pA = mockPlatform();
		const pB = mockPlatform();
		call(wsA, pA, 'deprecate-test/each', 'x');
		call(wsB, pB, 'deprecate-test/each', 'y');
		await flush();
		// Empty info object is still a signal (carries the path).
		expect(pA.sent.find((m) => m.event === 'x').data.deprecation).toEqual({ path: 'deprecate-test/each' });
		expect(pB.sent.find((m) => m.event === 'y').data.deprecation).toEqual({ path: 'deprecate-test/each' });
	});

	it('a fire-and-forget call does not consume the one-shot signal', async () => {
		__register('deprecate-test/vol', live.deprecate(async () => 'ok', { since: '0.6' }));
		const ws = mockWs({ id: 'u3' });
		const platform = mockPlatform();
		// fireAndForget = no `id` on the wire -> no response is sent. It must not
		// burn the one-shot, or the next real call would never be warned.
		handleRpc(ws, toArrayBuffer({ rpc: 'deprecate-test/vol', args: [] }), platform);
		await flush();
		// A subsequent real (reply-expecting) call still receives the signal.
		call(ws, platform, 'deprecate-test/vol', 'r');
		await flush();
		const resp = platform.sent.find((m) => m.event === 'r');
		expect(resp.data.deprecation).toEqual({ path: 'deprecate-test/vol', since: '0.6' });
	});

	it('does not attach a signal for a non-deprecated handler', async () => {
		__register('deprecate-test/fresh', async () => 'ok');
		const ws = mockWs({ id: 'u2' });
		const platform = mockPlatform();
		call(ws, platform, 'deprecate-test/fresh', 'z');
		await flush();
		const resp = platform.sent.find((m) => m.event === 'z');
		expect(resp.data.ok).toBe(true);
		expect(resp.data.deprecation).toBeUndefined();
	});

	it('finds the marker through a re-wrapping RPC marker (__wrappedFn chain)', async () => {
		// live.deprecate buried inside an outer rateLimit wrapper must still signal -
		// the wrapper links to the inner via __wrappedFn and _deprecationSignal walks it.
		__register('deprecate-test/wrapped', live.rateLimit(
			{ points: 100, window: 1000 },
			live.deprecate(async () => 'ok', { since: '0.6', use: 'deprecate-test/new' })
		));
		const ws = mockWs({ id: 'w1' });
		const platform = mockPlatform();
		call(ws, platform, 'deprecate-test/wrapped', 'c1');
		await flush();
		const resp = platform.sent.find((m) => m.event === 'c1');
		expect(resp.data.ok).toBe(true);
		expect(resp.data.deprecation).toEqual({ path: 'deprecate-test/wrapped', since: '0.6', use: 'deprecate-test/new' });
	});

	it('copies the marker through a stream re-wrapper (_copyStreamMeta)', () => {
		// live.gate rebuilds the stream fn via _copyStreamMeta; the marker must survive.
		const composed = live.gate(
			() => true,
			live.deprecate(live.stream('dep-gate-topic', async () => ['x']), { since: '0.6', use: 'newStream' })
		);
		expect(/** @type {any} */ (composed).__deprecated).toEqual({ since: '0.6', use: 'newStream' });
		expect(/** @type {any} */ (composed).__isStream).toBe(true);
	});

	it('attaches the signal on a batch response', async () => {
		__register('deprecate-test/batch', live.deprecate(async () => 'ok', { since: '0.6' }));
		const ws = mockWs({ id: 'bt' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ batch: [{ rpc: 'deprecate-test/batch', id: 'bb', args: [] }] }), platform);
		await flush();
		const batchResp = platform.sent.find((m) => m.event === '__batch');
		expect(batchResp).toBeTruthy();
		const inner = batchResp.data.batch.find((r) => r.id === 'bb');
		expect(inner.ok).toBe(true);
		expect(inner.deprecation).toEqual({ path: 'deprecate-test/batch', since: '0.6' });
	});
});
