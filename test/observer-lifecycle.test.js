import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live, unsubscribe, __register, _prepareHmr } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';

let env, peer;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => {
	env = createTestEnv();
	peer = env.connect({ id: 'observer' });
});
afterEach(() => { peer?.disconnect(); env?.cleanup(); _prepareHmr(); });

function lifecycle() {
	return {
		onSubscribe: vi.fn(),
		onUnsubscribe: vi.fn()
	};
}

describe('aggregate and derived observer lifecycle', () => {
	it('fires single-state aggregate hooks after attach and once at close', async () => {
		const hooks = lifecycle();
		env.register('stats', { single: live.aggregate('events', {
			count: { init: () => 0, reduce: value => value + 1 }
		}, { topic: 'stats:single', ...hooks }) });
		const stream = peer.subscribe('stats/single');
		await stream.waitFor(() => true);
		expect(hooks.onSubscribe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ user: { id: 'observer' } }), 'stats:single');
		expect(hooks.onUnsubscribe).not.toHaveBeenCalled();
		peer.disconnect();
		await flush();
		expect(hooks.onUnsubscribe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ user: { id: 'observer' } }), 'stats:single', 0);
	});

	it('fires per-window hooks on the resolved output topic', async () => {
		const hooks = lifecycle();
		const aggregate = live.aggregate('events', {
			count: { init: () => 0, reduce: value => value + 1 }
		}, { topic: 'stats:trending', windows: { last10min: { type: 'lifetime' } }, ...hooks });
		env.register('stats', { trending: aggregate });
		__register('stats/last10min', aggregate.__windowStreams.last10min);
		const stream = peer.subscribe('stats/last10min');
		await stream.waitFor(() => true);
		expect(hooks.onSubscribe).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'stats:trending:last10min');
		peer.disconnect();
		await flush();
		expect(hooks.onUnsubscribe).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'stats:trending:last10min', 0);
	});

	it.each([false, true])('composes static and dynamic derived lifecycle with internal activation (dynamic: %s)', async dynamic => {
		const hooks = lifecycle();
		const derived = dynamic
			? live.derived(() => ['source'], () => ({ ready: true }), hooks)
			: live.derived(['source'], () => ({ ready: true }), hooks);
		env.register('stats', { derived });
		const stream = peer.subscribe('stats/derived');
		await stream.waitFor(() => true);
		expect(hooks.onSubscribe).toHaveBeenCalledTimes(1);
		const topic = hooks.onSubscribe.mock.calls[0][1];
		const ws = hooks.onSubscribe.mock.calls[0][0].ws;
		unsubscribe(ws, topic, { platform: env.platform });
		unsubscribe(ws, topic, { platform: env.platform });
		await flush();
		expect(hooks.onUnsubscribe).toHaveBeenCalledExactlyOnceWith(expect.anything(), topic, 0);
		peer.reconnect();
		await peer.subscribe('stats/derived').waitFor(() => true);
		expect(hooks.onSubscribe).toHaveBeenCalledTimes(2);
		peer.disconnect();
		await flush();
		expect(hooks.onUnsubscribe).toHaveBeenCalledTimes(2);
	});

	it('does not announce a failed initial load as an observer', async () => {
		const hooks = lifecycle();
		env.register('stats', { derived: live.derived(['source'], () => { throw new Error('load failed'); }, hooks) });
		const stream = peer.subscribe('stats/derived');
		await vi.waitFor(() => expect(stream.error).not.toBeNull());
		expect(hooks.onSubscribe).not.toHaveBeenCalled();
	});

	it('handles repeated subscriptions and drains each logical attachment once', async () => {
		const hooks = lifecycle();
		env.register('stats', { derived: live.derived(['source'], () => true, hooks) });
		await peer.subscribe('stats/derived').waitFor(() => true);
		await peer.subscribe('stats/derived').waitFor(() => true);
		expect(hooks.onSubscribe).toHaveBeenCalledTimes(2);
		const topic = hooks.onSubscribe.mock.calls[0][1];
		const ws = hooks.onSubscribe.mock.calls[0][0].ws;
		unsubscribe(ws, topic, { platform: env.platform });
		await flush();
		expect(hooks.onUnsubscribe).toHaveBeenCalledTimes(2);
		for (const call of hooks.onUnsubscribe.mock.calls) expect(call[1]).toBe(topic);
	});
});
