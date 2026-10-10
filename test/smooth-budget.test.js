import { afterEach, expect, it, vi } from 'vitest';
import * as installed from 'svelte-adapter-uws/plugins/smooth';
import { live, handleRpc, __register, _setSmoothRuntime, _resetSmooth } from '../src/server.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { _smoothTopics, _smoothRecord } from '../src/server/smooth.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { mockWs } from './helpers/mock-ws.js';

const config = { topic: 'budget', initial: { x: 0 }, apply: state => state };
afterEach(() => { _resetSmooth(); _setSmoothRuntime(null); });
it.each([0, -1, 0.5, Infinity, NaN, null, false, '2'])('rejects maxCommandsPerTick=%s', value => {
	expect(() => live.smooth({ ...config, maxCommandsPerTick: value })).toThrow('maxCommandsPerTick');
});
it.each([undefined, 1, 2])('accepts the optional positive command budget %s', value => {
	expect(() => live.smooth({ ...config, maxCommandsPerTick: value })).not.toThrow();
});
async function sync(shape, name) {
	const platform = mockPlatform(), ws = mockWs({ id: 'player' });
	__register(name + '/sync', shape.__smoothSync, name);
	handleRpc(ws, new TextEncoder().encode(JSON.stringify({ rpc: name + '/sync', id: 's', args: [] })).buffer, platform);
	await vi.waitFor(() => expect(platform.sent).toHaveLength(1));
	return { result: platform.sent[0].data, ws };
}
it('rejects an explicit budget when an older adapter ignores it without creating a topic', async () => {
	const factory = vi.fn(({ maxCommandsPerTick, ...options }) => installed.createSmoothAuthority(options));
	_setSmoothRuntime({ ...installed, createSmoothAuthority: factory });
	for (const topic of ['budget-old-a', 'budget-old-b']) {
		const { result } = await sync(live.smooth({ ...config, topic, maxCommandsPerTick: 1 }), topic);
		expect(result).toMatchObject({ ok: false, code: 'INTERNAL' });
		expect(result.error).toContain('maxCommandsPerTick requires an adapter');
		expect(_smoothTopics.has(topic)).toBe(false);
	}
	expect(factory).toHaveBeenCalledTimes(1); // Unsupported capability is cached per factory.
});
it('keeps the default compatible without probing or adding a drain budget', async () => {
	const factory = vi.fn(options => installed.createSmoothAuthority(options));
	_setSmoothRuntime({ ...installed, createSmoothAuthority: factory });
	const { result } = await sync(live.smooth(config), 'budget-default');
	expect(result.ok).toBe(true);
	expect(factory).toHaveBeenCalledTimes(1);
	expect(factory.mock.calls[0][0].maxCommandsPerTick).toBeUndefined();
});

const budgetModule = process.env.REALTIME_SMOOTH_BUDGET_RUNTIME
	? await import(pathToFileURL(resolve(process.env.REALTIME_SMOOTH_BUDGET_RUNTIME)).href) : installed;
let supportsBudget = false;
try { budgetModule.createSmoothAuthority({ apply: state => state, maxCommandsPerTick: 0 }); }
catch { supportsBudget = true; }

it.skipIf(!supportsBudget)('forwards the budget while retaining the waiting tail under reentrant queue overflow', () => {
	let record;
	const shape = live.smooth({
		topic: 'budget-reentrant', initial: 0, maxCommandsPerTick: 1, queueCap: 3,
		apply(state, command) {
			if (command === 1) record.authority.enqueue('player', [{ id: 4, cmd: 4 }, { id: 5, cmd: 5 }]);
			return state + command;
		}
	});
	record = _smoothRecord('budget-reentrant', shape.__smoothCfg, mockPlatform(), budgetModule);
	record.authority.ensure('player', {}, 0);
	record.authority.enqueue('player', [1, 2, 3].map(id => ({ id, cmd: id })));
	const results = Array.from({ length: 4 }, () => record.authority.drain().acks[0]);
	expect(results.map(ack => ack.id)).toEqual([1, 3, 4, 5]);
	expect(results.map(ack => ack.state)).toEqual([1, 4, 8, 13]);
});

it.skipIf(!supportsBudget)('retains a failed prefix for explicit retry before its waiting tail', () => {
	let fail = true;
	const shape = live.smooth({
		topic: 'budget-retry', initial: 0, maxCommandsPerTick: 2,
		apply(state, command) {
			if (command === 2 && fail) { fail = false; throw new Error('retry'); }
			return state + command;
		}
	});
	const record = _smoothRecord('budget-retry', shape.__smoothCfg, mockPlatform(), budgetModule);
	record.authority.ensure('player', {}, 0);
	record.authority.enqueue('player', [1, 2, 3].map(id => ({ id, cmd: id })));
	expect(() => record.authority.drain()).toThrow('retry');
	expect(record.authority.get('player').state).toBe(0);
	expect(record.authority.drain().acks[0]).toMatchObject({ id: 2, state: 3 });
	expect(record.authority.drain().acks[0]).toMatchObject({ id: 3, state: 6 });
});

it.skipIf(!supportsBudget)('probes a supported factory once without invoking application callbacks', () => {
	const factory = vi.fn(options => budgetModule.createSmoothAuthority(options));
	const runtime = { ...budgetModule, createSmoothAuthority: factory };
	const apply = vi.fn(state => state);
	for (const maxCommandsPerTick of [2, 3]) {
		const topic = 'budget-cached-' + maxCommandsPerTick;
		const shape = live.smooth({ ...config, topic, apply, maxCommandsPerTick });
		_smoothRecord(topic, shape.__smoothCfg, mockPlatform(), runtime);
	}
	expect(factory.mock.calls.map(call => call[0].maxCommandsPerTick)).toEqual([1, 2, 3]);
	expect(apply).not.toHaveBeenCalled();
});
