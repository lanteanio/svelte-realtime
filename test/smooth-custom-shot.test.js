import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as runtime from 'svelte-adapter-uws/plugins/smooth';
import { live, handleRpc, close, __register, _setSmoothRuntime, _resetSmooth } from '../src/server.js';
import { _smoothTopics } from '../src/server/smooth.js';
import { setRuntimeEnv, resetRuntimeEnv } from '../src/shared/runtime.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { mockWs } from './helpers/mock-ws.js';

let mono, timers, platform, ws, topic, sequence = 0;
beforeEach(() => {
	mono = 0;
	timers = new Map();
	setRuntimeEnv({ clock: { monotonic: () => mono, wallEpoch: () => 100000 + mono }, timers: {
		set(fn, delay, ...args) { const token = {}; timers.set(token, { at: mono + delay, fn: () => fn(...args) }); return token; },
		clear(token) { timers.delete(token); }
	} });
	_setSmoothRuntime(runtime);
	platform = mockPlatform();
	ws = mockWs({ id: 'player' });
	topic = 'custom-shot-' + ++sequence;
});
afterEach(() => { _resetSmooth(); _setSmoothRuntime(null); resetRuntimeEnv(); });
function declare(resolveShot, extra = {}) {
	const shape = live.smooth({ topic, tickMs: 20, initial: { x: 0, y: 0 },
		apply: (state, command) => ({ ...state, x: state.x + (command.dx || 0) }),
		interest: { radius: 100, position: state => state }, hitTest: { resolveShot }, ...extra });
	__register(topic + '/sync', shape.__smoothSync, topic);
	__register(topic + '/shoot', shape.__smoothShoot, topic);
}
async function rpc(action, args = []) {
	const id = 'shot-' + ++sequence;
	handleRpc(ws, new TextEncoder().encode(JSON.stringify({ rpc: topic + '/' + action, id, args })).buffer, platform);
	for (let count = 0; count < 100; count++) {
		const reply = platform.sent.find(frame => frame.event === id);
		if (reply) return reply.data;
		await new Promise(resolve => setImmediate(resolve));
	}
	throw new Error('Custom shot did not settle');
}
function tick() {
	const [token, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
	timers.delete(token);
	mono = timer.at;
	timer.fn();
}

it('runs without ray targets and exposes frozen bounded timing rather than raw stamps', async () => {
	const calls = [];
	declare((ctx, command, timing) => { calls.push({ ctx, command, timing }); ctx.emitEvent('projectile', timing); });
	expect((await rpc('sync')).ok).toBe(true);
	expect((await rpc('shoot', [{ cmd: { fire: 1 }, rt: 99970, ackT: 99940 }])).ok).toBe(true);
	expect(calls).toHaveLength(1);
	expect(calls[0].timing).toEqual({ rewindMs: 30, reach: 70, maxRewindMs: 100, minUplink: 30, maxUplink: 30, interpDelay: 40 });
	expect(Object.isFrozen(calls[0].timing)).toBe(true);
	expect(calls[0].ctx.state).toEqual({ x: 0, y: 0 });
	expect(calls[0].ctx.applyTo('player', { dx: 999 })).toBe(false);
	calls[0].ctx.emitEvent('late', {});
	expect(platform.published.some(frame => frame.data.type === 'late')).toBe(false);
});

it('expires a synchronous resolver before its retained microtask can act', async () => {
	let immediateAccepted, lateAccepted;
	declare(ctx => {
		immediateAccepted = ctx.applyTo(ctx.identity, { dx: 2 });
		ctx.emitEvent('immediate', {});
		queueMicrotask(() => {
			lateAccepted = ctx.applyTo(ctx.identity, { dx: 9 });
			ctx.emitEvent('retained-microtask', {});
		});
	});
	await rpc('sync');
	expect((await rpc('shoot', [{ cmd: {} }])).ok).toBe(true);
	expect(immediateAccepted).toBe(true);
	expect(lateAccepted).toBe(false);
	tick();
	expect(_smoothTopics.get(topic).authority.get('player').state.x).toBe(2);
	expect(platform.published.some(frame => frame.data.type === 'immediate')).toBe(true);
	expect(platform.published.some(frame => frame.data.type === 'retained-microtask')).toBe(false);
});

it('keeps an asynchronous resolver active until its returned promise settles', async () => {
	let retained, accepted;
	declare(async ctx => {
		retained = ctx;
		await Promise.resolve();
		accepted = ctx.applyTo(ctx.identity, { dx: 2 });
		ctx.emitEvent('after-await', {});
	});
	await rpc('sync');
	expect((await rpc('shoot', [{ cmd: {} }])).ok).toBe(true);
	expect(accepted).toBe(true);
	tick();
	expect(_smoothTopics.get(topic).authority.get('player').state.x).toBe(2);
	expect(platform.published.some(frame => frame.data.type === 'after-await')).toBe(true);
	expect(retained.applyTo('player', { dx: 9 })).toBe(false);
});

it.each([16, 50])('uses the server delivery cadence at tickMs=%s', async tickMs => {
	const callback = vi.fn();
	declare(callback, { tickMs });
	await rpc('sync');
	await rpc('shoot', [{ cmd: {}, rt: 99000, ackT: 99940 }]);
	const timing = callback.mock.calls[0][2];
	expect(timing.interpDelay).toBe(2 * tickMs);
	expect(timing.reach).toBe(Math.min(100, 30 + 2 * tickMs));
	expect(timing.rewindMs).toBe(timing.reach);
});

it('drops strictly older shots and never grants future or missing timing a rewind', async () => {
	const callback = vi.fn();
	declare(callback);
	await rpc('sync');
	await rpc('shoot', [{ cmd: {}, rt: 99970, ackT: 99940 }]);
	await rpc('shoot', [{ cmd: {}, rt: 99969, ackT: 99900 }]);
	expect(callback).toHaveBeenCalledTimes(1);
	await rpc('shoot', [{ cmd: {}, rt: 101000, ackT: 99940 }]);
	expect(callback.mock.calls[1][2].rewindMs).toBe(0);
	await rpc('shoot', [{ cmd: {} }]);
	expect(callback.mock.calls[2][2]).toMatchObject({ rewindMs: 0, minUplink: null, maxUplink: null, interpDelay: null });
});

it('drains accepted injections after an error without publishing failed callback events', async () => {
	let retained;
	declare(ctx => { retained = ctx; ctx.applyTo(ctx.identity, { dx: 2 }); ctx.emitEvent('failed', {}); throw new Error('Application failure'); });
	await rpc('sync');
	expect((await rpc('shoot', [{ cmd: {} }])).ok).toBe(false);
	tick();
	expect(_smoothTopics.get(topic).authority.get('player').state.x).toBe(2);
	expect(platform.published.some(frame => frame.data.type === 'failed')).toBe(false);
	expect(retained.applyTo('player', { dx: 9 })).toBe(false);
});

it('revokes an awaiting resolver when its shooter leaves', async () => {
	let resume, accepted;
	declare(async ctx => { await new Promise(done => { resume = done; }); accepted = ctx.applyTo(ctx.identity, { dx: 9 }); ctx.emitEvent('departed', {}); });
	await rpc('sync');
	const pending = rpc('shoot', [{ cmd: {} }]);
	for (let count = 0; count < 100 && !resume; count++) await new Promise(resolve => setImmediate(resolve));
	expect(resume).toBeTypeOf('function');
	close(ws, { platform });
	resume();
	await pending;
	expect(accepted).toBe(false);
	expect(_smoothTopics.has(topic)).toBe(false);
	expect(platform.published.some(frame => frame.data.type === 'departed')).toBe(false);
});

it('refuses malformed or mixed custom resolver configuration', () => {
	expect(() => declare(5)).toThrow('resolveShot must be a function');
	expect(() => declare(() => {}, { hitTest: { resolveShot() {}, onHit() {} } })).toThrow('cannot be combined');
	expect(() => declare(() => {}, { interest: undefined })).toThrow('requires interest');
});

it('runs detection before the custom resolver and contains a throwing detector', async () => {
	const order = [];
	declare(() => {}, { hitTest: {
		detectionHook(info) { order.push(['detect', info.minUplink]); throw new Error('Detector failed'); },
		resolveShot() { order.push(['resolve']); }
	} });
	await rpc('sync');
	expect((await rpc('shoot', [{ cmd: {}, rt: 99970, ackT: 99940 }])).ok).toBe(true);
	expect(order).toEqual([['detect', 30], ['resolve']]);
});

it('revokes an awaiting resolver when the same identity rebinds another socket', async () => {
	let resume, accepted;
	declare(async ctx => { await new Promise(done => { resume = done; }); accepted = ctx.applyTo(ctx.identity, { dx: 9 }); ctx.emitEvent('rebound', {}); });
	await rpc('sync');
	const pending = rpc('shoot', [{ cmd: {} }]);
	for (let count = 0; count < 100 && !resume; count++) await new Promise(resolve => setImmediate(resolve));
	expect(resume).toBeTypeOf('function');
	ws = mockWs({ id: 'player' });
	await rpc('sync');
	resume();
	await pending;
	expect(accepted).toBe(false);
	expect(_smoothTopics.get(topic).authority.get('player').state.x).toBe(0);
	expect(platform.published.some(frame => frame.data.type === 'rebound')).toBe(false);
});
