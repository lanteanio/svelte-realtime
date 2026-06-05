// Realtime health folds the adapter connection's flow-control signal.
//
// Flow control itself lives in the adapter client's send gate. The realtime
// layer's only stake in it is realtime.health: the connection exposes a single
// degraded boolean via conn._onLeaseDegraded, and realtime.health must flip to
// 'degraded' while that boolean is true (OR-ed with the server-pushed degraded
// event on the system topic), and back to 'healthy' only when both inputs are
// clear. This file mocks the adapter connection's _onLeaseDegraded accessor and
// drives it the way a backed-up adapter send gate would, asserting the fold -
// the genuine production contract, not a realtime-owned gate copy.
//
// Mirrors the mocking shape of client.test.js: vi.resetModules per test, doMock
// the adapter client transport, and capture the flow-degraded callback the
// realtime layer registers.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let health, _resetHealth;
let topicCallbacks;
let emitFlowDegraded; // push a boolean through the registered _onLeaseDegraded cb
let flowDegradedRegistered;

/** Replay a pub/sub envelope to the realtime client's topic subscribers. */
function simulateTopicMessage(topic, envelope) {
	const fns = topicCallbacks.get(topic);
	if (fns) for (const cb of fns) cb(envelope);
}

beforeEach(async () => {
	vi.resetModules();

	topicCallbacks = new Map();
	let flowCb = null;
	flowDegradedRegistered = false;
	emitFlowDegraded = (d) => { if (flowCb) flowCb(!!d); };

	const conn = {
		sendQueued: vi.fn(),
		ready: () => Promise.resolve(),
		get bufferedAmount() { return 0; },
		// The genuine production accessor: the realtime layer subscribes to the
		// connection's internal flow-control health and folds the boolean into
		// realtime.health. Emits the current value (healthy) on subscribe.
		_onLeaseDegraded(cb) {
			flowCb = typeof cb === 'function' ? cb : null;
			flowDegradedRegistered = true;
			if (flowCb) flowCb(false);
			return () => { flowCb = null; };
		}
	};

	vi.doMock('svelte-adapter-uws/client', () => ({
		connect: vi.fn(() => conn),
		on: (topic) => ({
			subscribe: (fn) => {
				let fns = topicCallbacks.get(topic);
				if (!fns) { fns = new Set(); topicCallbacks.set(topic, fns); }
				fns.add(fn);
				return () => {
					fns.delete(fn);
					if (fns.size === 0) topicCallbacks.delete(topic);
				};
			}
		})
	}));

	const mod = await import('../client.js');
	health = mod.health;
	_resetHealth = mod._resetHealth;
	_resetHealth();
});

function readHealth() {
	const values = [];
	const unsub = health.subscribe((v) => values.push(v));
	return { values, unsub };
}

describe('realtime health folds the connection flow-control signal', () => {
	it('registers for the connection flow-control signal on first health read', () => {
		const { unsub } = readHealth();
		expect(flowDegradedRegistered).toBe(true);
		unsub();
	});

	it('flips to degraded while the connection reports flow pressure', () => {
		const { values, unsub } = readHealth();
		expect(values[values.length - 1]).toBe('healthy');

		emitFlowDegraded(true);
		expect(values[values.length - 1]).toBe('degraded');

		emitFlowDegraded(false);
		expect(values[values.length - 1]).toBe('healthy');
		unsub();
	});

	it('ORs the server degraded event and the flow signal into one store', () => {
		const { values, unsub } = readHealth();

		// Server-pushed degraded on the system topic.
		simulateTopicMessage('__realtime', { event: 'degraded', data: {} });
		expect(values[values.length - 1]).toBe('degraded');

		// Flow pressure arrives too; the store stays degraded.
		emitFlowDegraded(true);
		expect(values[values.length - 1]).toBe('degraded');

		// Server recovers, but flow pressure is still on: still degraded.
		simulateTopicMessage('__realtime', { event: 'recovered', data: {} });
		expect(values[values.length - 1]).toBe('degraded');

		// Flow pressure clears too: only now is the store healthy again.
		emitFlowDegraded(false);
		expect(values[values.length - 1]).toBe('healthy');
		unsub();
	});

	it('stays healthy when neither input is degraded', () => {
		const { values, unsub } = readHealth();
		emitFlowDegraded(false);
		simulateTopicMessage('__realtime', { event: 'recovered', data: {} });
		expect(values.every((v) => v === 'healthy')).toBe(true);
		unsub();
	});

	it('does not throw when the connection predates the flow-control accessor', async () => {
		// Older adapter connections have no _onLeaseDegraded. The realtime layer
		// must degrade gracefully: server-pushed health still works, flow health
		// simply never contributes.
		vi.resetModules();
		topicCallbacks = new Map();
		const legacyConn = { sendQueued: vi.fn(), ready: () => Promise.resolve(), get bufferedAmount() { return 0; } };
		vi.doMock('svelte-adapter-uws/client', () => ({
			connect: vi.fn(() => legacyConn),
			on: (topic) => ({
				subscribe: (fn) => {
					let fns = topicCallbacks.get(topic);
					if (!fns) { fns = new Set(); topicCallbacks.set(topic, fns); }
					fns.add(fn);
					return () => { fns.delete(fn); if (fns.size === 0) topicCallbacks.delete(topic); };
				}
			})
		}));
		const mod = await import('../client.js');
		mod._resetHealth();
		const values = [];
		const unsub = mod.health.subscribe((v) => values.push(v));
		expect(values[values.length - 1]).toBe('healthy');
		simulateTopicMessage('__realtime', { event: 'degraded', data: {} });
		expect(values[values.length - 1]).toBe('degraded');
		unsub();
	});
});
