import { afterEach, beforeEach, expect, it } from 'vitest';
import * as runtime from 'svelte-adapter-uws/plugins/smooth';
import { live, handleRpc, __register, _setSmoothRuntime, _resetSmooth } from '../src/server.js';
import { _smoothTopics } from '../src/server/smooth.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/shared/runtime.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { mockWs } from './helpers/mock-ws.js';

let mono, wallOffset, timers, stamps, workMs, hitchMs, keepAlive, platform, ws, path;
let sequence = 0;
beforeEach(() => {
	mono = 0;
	wallOffset = 100000;
	timers = new Map();
	stamps = [];
	workMs = 0;
	hitchMs = 0;
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
			mono += workMs + hitchMs;
			hitchMs = 0;
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

it('runs every owed tick after a stall, eight per callback', async () => {
	await rpc('sync');
	fire(1000);
	expect(stamps).toHaveLength(8);
	expect(new Set(stamps)).toEqual(new Set([101020]));
	// The rest of the debt is due now, not a period later.
	expect(next()[1].at).toBe(1020);
	let callbacks = 1;
	while (next()[1].at <= 1020) {
		const before = stamps.length;
		fire();
		expect(stamps.length - before).toBeLessThanOrEqual(8);
		callbacks++;
	}
	// Deadlines 20, 40, ..., 1020.
	expect(stamps).toHaveLength(51);
	expect(callbacks).toBe(7);
	expect(next()[1].at).toBe(1040);
});

it('drops only the debt beyond two seconds after a longer stall', async () => {
	await rpc('sync');
	fire(5000);
	while (next()[1].at <= 5020) fire();
	// The first deadline (20), then the two seconds owed up to 5020.
	expect(stamps).toHaveLength(1 + 2000 / 20 + 1);
	expect(next()[1].at).toBe(5040);
});

it('keeps sixty-Hz rooms on wall time when timers fire late under load', async () => {
	declare(1000 / 60);
	await rpc('sync');
	const start = next()[1].at;
	// Most callbacks run 5 ms late; every tenth is held up for 300 ms, far
	// more than eight ticks.
	for (let i = 0; mono < start + 10000 || next()[1].at <= mono; i++) fire(i % 10 === 9 ? 300 : 5);
	const owed = Math.floor((mono - start) / (1000 / 60) + 1e-9) + 1;
	expect(owed).toBeGreaterThanOrEqual(600);
	expect(stamps.length).toBe(owed);
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

it('drops the debt and waits a full period when each tick costs more than a period', async () => {
	await rpc('sync');
	workMs = 25;
	fire();
	expect(stamps).toHaveLength(8);
	// One burst that ends owing more than it started may be a hitch.
	expect(next()[1].at).toBeLessThanOrEqual(mono);
	fire();
	expect(stamps).toHaveLength(16);
	// The second in a row cannot catch up: ticks cost more than a period.
	expect(next()[1].at).toBe(mono + 20);
	for (let i = 0; i < 100; i++) {
		const before = stamps.length;
		fire();
		expect(stamps.length - before).toBe(8);
		expect(next()[1].at).toBe(mono + 20);
	}
});

it('bounds catch-up in ticks as well as time for a short tickMs', async () => {
	declare(1);
	await rpc('sync');
	const start = next()[1].at;
	fire(2000);
	while (next()[1].at <= mono) fire();
	// The first deadline, then the last 120 owed ticks and the one due now.
	expect(stamps).toHaveLength(1 + 120 + 1);
	expect(next()[1].at).toBe(start + 2000 + 1);
});

it('keeps the debt after one slow tick and pays it off', async () => {
	await rpc('sync');
	for (let i = 0; i < 5; i++) fire();
	workMs = 6;
	hitchMs = 300;
	fire();
	// The 300 ms tick left the burst owing more than it started, once.
	expect(stamps).toHaveLength(5 + 8);
	expect(next()[1].at).toBeLessThanOrEqual(mono);
	const start = stamps[0] - 100000 - 20;
	while (next()[1].at <= mono) fire();
	// Every deadline up to now ran: 20, 40, ..., the one due next is a period away.
	const due = next()[1].at;
	expect(stamps).toHaveLength((due - 20 - start) / 20);
	expect(due).toBeGreaterThan(mono);
	expect(due - mono).toBeLessThanOrEqual(20);
	// A 150 ms tick leaves debt that the next callback pays off in a few
	// ticks. Catching up clears the hitch, so a second one keeps its debt too.
	for (let round = 0; round < 2; round++) {
		for (let i = 0; i < 5; i++) fire();
		hitchMs = 150;
		fire();
		expect(next()[1].at).toBeLessThanOrEqual(mono);
		const before = stamps.length;
		fire();
		expect(stamps.length - before).toBeLessThan(8);
		expect(next()[1].at).toBeGreaterThan(mono);
	}
});

it('forgets a lost burst once the room goes idle and wakes again', async () => {
	await rpc('sync');
	workMs = 25;
	fire();
	// One burst lost ground; the rest of its debt is due now.
	expect(next()[1].at).toBeLessThanOrEqual(mono);
	workMs = 0;
	keepAlive = false;
	fire();
	expect(timers.size).toBe(0);
	mono += 1000;
	keepAlive = true;
	await rpc('command', [[{ id: 1, cmd: { dx: 1 } }]]);
	workMs = 6;
	hitchMs = 300;
	fire();
	// A single hitch on the first tick after the wake keeps its debt.
	expect(next()[1].at).toBeLessThanOrEqual(mono);
});
