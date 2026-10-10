import { expect, it, vi } from 'vitest';
import { live, realtime } from '../src/server.js';
import { _topicWsCounts } from '../src/server/state.js';
import { createTestEnv } from '../src/testing.js';
import { mockWs } from './helpers/mock-ws.js';
import { toArrayBuffer } from './helpers/encode.js';

it('releases stream bookkeeping through factory hooks before the socket closes', async () => {
	vi.useFakeTimers();
	const env = createTestEnv();
	const hooks = realtime();
	const ws = mockWs({ id: 'reader' });
	const onUnsubscribe = vi.fn();
	try {
		env.register('counter', { value: live.stream('factory:count', () => 0, { onUnsubscribe }) });
		hooks.message(ws, { data: toArrayBuffer({ rpc: 'counter/value', id: 'first', stream: true, args: [] }), platform: env.platform });
		await vi.advanceTimersByTimeAsync(0);
		expect(_topicWsCounts.get('factory:count')?.size).toBe(1);
		ws.unsubscribe('factory:count');
		hooks.unsubscribe(ws, 'factory:count', { platform: env.platform });
		await vi.advanceTimersByTimeAsync(0);
		expect(_topicWsCounts.has('factory:count')).toBe(false);
		expect(onUnsubscribe).toHaveBeenCalledOnce();
		hooks.close(ws, { platform: env.platform });
		await vi.advanceTimersByTimeAsync(0);
		expect(onUnsubscribe).toHaveBeenCalledOnce();
	} finally {
		hooks.close(ws, { platform: env.platform });
		await vi.advanceTimersByTimeAsync(0);
		env.cleanup();
		vi.useRealTimers();
	}
});
