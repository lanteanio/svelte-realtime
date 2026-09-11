import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	__directCall,
	__register,
	handleRpc,
	live,
	setOperationalEventSink
} from '../src/server.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { mockWs } from './helpers/mock-ws.js';
import { toArrayBuffer } from './helpers/encode.js';

afterEach(() => {
	setOperationalEventSink(null);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('operational event sink', () => {
	it('reports sync and async live.poll failures without stopping the interval', async () => {
		vi.useFakeTimers();
		const records = [];
		setOperationalEventSink((record) => records.push(record));
		let ticks = 0;
		const stop = live.poll(() => {
			ticks++;
			if (ticks === 1) throw new Error('sync poll failure');
			if (ticks === 2) return Promise.reject(new Error('async poll failure'));
		}, 10);
		await vi.advanceTimersByTimeAsync(35);
		stop();
		expect(ticks).toBe(3);
		expect(records.filter((record) => record.event === 'poll.tick.failed')).toHaveLength(2);
	});

	it('reports unexpected RPC failures in every environment with request correlation', async () => {
		const records = [];
		setOperationalEventSink((record) => records.push(record));
		__register('operational/fail', () => { throw new Error('database unavailable'); });
		const platform = mockPlatform();
		handleRpc(
			mockWs(),
			toArrayBuffer({ rpc: 'operational/fail', id: 'operation-42', args: [] }),
			platform
		);
		await vi.waitFor(() => expect(platform.sent).toHaveLength(1));
		expect(records).toContainEqual(expect.objectContaining({
			event: 'rpc.execution.non-live-error',
			dataClass: 'application',
			attributes: expect.objectContaining({ requestId: 'operation-42' })
		}));
	});

	it('reports direct-call fallback degradation even without onError', async () => {
		const records = [];
		setOperationalEventSink((record) => records.push(record));
		__register('operational/direct-fallback', () => {
			throw new Error('direct loader unavailable');
		});
		const fallback = { stale: true };
		const result = await __directCall(
			'operational/direct-fallback',
			[],
			mockPlatform(),
			{ fallback }
		);
		expect(result).toBe(fallback);
		expect(records).toContainEqual(expect.objectContaining({
			component: 'server.direct-call',
			event: 'direct-call.fallback.used',
			dataClass: 'application',
			attributes: {
				path: 'operational/direct-fallback',
				error: expect.objectContaining({ message: 'direct loader unavailable' })
			}
		}));
	});
});
