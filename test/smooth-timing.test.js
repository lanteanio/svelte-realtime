import { afterEach, beforeEach, expect, it } from 'vitest';
import * as runtime from 'svelte-adapter-uws/plugins/smooth';
import { live, handleRpc, __register, _setSmoothRuntime, _resetSmooth } from '../src/server.js';
import { _smoothTopics } from '../src/server/smooth.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/shared/runtime.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { mockWs } from './helpers/mock-ws.js';

let mono, wallOffset, timers, stamps, workMs, keepAlive, platform, ws, path;
let sequence = 0;
beforeEach(() => {
	mono = 0;
	wallOffset = 100000;
	timers = new Map();
	stamps = [];
	workMs = 0;
	keepAlive = true;
	setRuntimeEnv({
		clock: { monotonic: () => mono, wallEpoch: () => mono + wallOffset },
		timers: {
			set(fn, delay, ...args) {
				const handle = {};
				timers.set(handle, { at: mono + delay, fn: () => fn(...args) });
				return handle;
			},
			clear: handle => timers.delete(handle)
		}
	});
	_setSmoothRuntime(runtime);
	platform = mockPlatform();
	ws = mockWs({ id: 'player' });
	path = 'timing' + ++sequence;
	declare(20);
});
function declare(tickMs) {
	const shape = live.smooth({
		topic: path, tickMs, initial: { x: 0, y: 0 },
		apply: (state, command) => ({ ...state, x: state.x + command.dx }),
		onTick(world, t) {
			stamps.push(t);
			mono += workMs;
			return keepAlive;
		}
	});
	__register(path + '/sync', shape.__smoothSync, path);
	__register(path + '/command', shape.__smoothCommand, path);
}
afterEach(() => {
	_resetSmooth();
	_setSmoothRuntime(null);
	resetRuntimeEnv();
});

async function rpc(action, args = []) {
	const id = 'clock-' + ++sequence;
	handleRpc(ws, new TextEncoder().encode(JSON.stringify({ rpc: path + '/' + action, id, args })).buffer, platform);
	for (let count = 0; count < 100; count++) {
		const reply = platform.sent.find(message => message.event === id);
		if (reply) { expect(reply.data.ok).toBe(true); return reply.data.data; }
		await new Promise(resolve => setImmediate(resolve));
	}
	throw new Error('Smooth RPC did not settle');
}

function next() {
	expect(timers.size).toBe(1);
	return [...timers.entries()][0];
}
function fire(late = 0) {
	const [handle, timer] = next();
	timers.delete(handle);
	mono = timer.at + late;
	timer.fn();
}

it('subtracts callback work from the next delay and keeps long-running cadence', async () => {
	await rpc('sync');
	workMs = 6;
	for (let i = 0; i < 180; i++) fire();
	expect(stamps).toHaveLength(180);
	expect(stamps.at(-1) - stamps[0]).toBe(179 * 20);
	expect(next()[1].at).toBe(181 * 20);
});

it('catches up late timers using actual wall stamps and ignores wall-clock jumps', async () => {
	await rpc('sync');
	fire(45);
	expect(stamps).toEqual([100065, 100065, 100065]);
	expect(next()[1].at).toBe(80);
	wallOffset -= 60000;
	fire();
	expect(stamps.at(-1)).toBe(40080);
	expect(next()[1].at).toBe(100);
	wallOffset += 120000;
	fire();
	expect(stamps.at(-1)).toBe(160100);
	expect(next()[1].at).toBe(120);
});

it('bounds catch-up to eight ticks and yields a full period after a long stall', async () => {
	await rpc('sync');
	fire(1000);
	expect(stamps).toHaveLength(8);
	expect(new Set(stamps)).toEqual(new Set([101020]));
	expect(next()[1].at).toBe(1040);
	fire();
	expect(stamps).toHaveLength(9);
});

it('does not accrue simulation debt while a room is idle', async () => {
	await rpc('sync');
	keepAlive = false;
	fire();
	expect(timers.size).toBe(0);
	mono = 10000;
	keepAlive = true;
	await rpc('command', [[{ id: 1, cmd: { dx: 1 } }]]);
	expect(next()[1].at).toBe(10020);
	fire();
	expect(stamps).toHaveLength(2);
	expect(platform.sent.filter(message => message.event === 'ack').at(-1).data.t).toBe(110020);
});

it('stops catch-up when the clock fence removes cluster ownership', async () => {
	await rpc('sync');
	const record = _smoothTopics.get(path);
	let releases = 0;
	platform.smooth = { releaseOwner: () => { releases++; } };
	platform.clockFence = { fenced: () => stamps.length === 1 };
	record.owned = true;
	record.registry.set('player', ws);
	fire(100);
	expect(stamps).toHaveLength(1);
	expect(releases).toBe(1);
	expect(record.owned).toBe(false);
	expect(timers.size).toBe(0);
});

it('keeps fractional sixty-Hz deadlines within one timer millisecond', async () => {
	declare(1000 / 60);
	await rpc('sync');
	workMs = 6;
	for (let i = 0; i < 600; i++) fire();
	expect(Math.abs(stamps.at(-1) - stamps[0] - 599 * 1000 / 60)).toBeLessThan(1.1);
});

it('yields after eight ticks even when each callback costs more than a period', async () => {
	await rpc('sync');
	workMs = 25;
	fire();
	expect(stamps).toHaveLength(8);
	expect(next()[1].at).toBe(mono + 20);
});
