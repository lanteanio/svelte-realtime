import { afterEach, expect, it } from 'vitest';
import { createTestServer } from 'svelte-adapter-uws/testing';
import * as smooth from 'svelte-adapter-uws/plugins/smooth';
import { live, handleRpc, close, __register, _setSmoothRuntime, _resetSmooth } from '../src/server.js';

let server, socket, serial = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label) {
	const deadline = performance.now() + 5000;
	while (performance.now() < deadline) { const value = read(); if (value) return value; await sleep(2); }
	throw new Error('Timed out waiting for ' + label);
}
afterEach(async () => { socket?.close(); socket = null; _resetSmooth(); await server?.close(); server = null; _setSmoothRuntime(null); });

it('carries bounded custom shot timing through native RPC, projectile travel and callback expiry', async () => {
	_setSmoothRuntime(smooth);
	const calls = [], applyContexts = [];
	const topic = 'projectiles-' + ++serial;
	const shape = live.smooth({ topic, tickMs: 16, initial: { x: 0, y: 0, remaining: 0 },
		interest: { radius: 100, position: state => state },
		apply(state, command, ctx) { applyContexts.push(ctx); return { ...state, x: state.x + (command.dx || 0), remaining: command.flight ? 2 : state.remaining }; },
		onTick(world) {
			let travelling = false;
			for (const entry of world.catalog()) {
				if (entry.state.remaining <= 0) continue;
				world.set(entry.key, { ...entry.state, x: entry.state.x + 1, remaining: entry.state.remaining - 1 });
				travelling = true;
			}
			return travelling;
		},
		hitTest: { resolveShot(ctx, command, timing) {
			calls.push({ ctx, timing });
			ctx.applyTo(ctx.identity, { dx: command.dx, flight: true });
			ctx.emitEvent('launched', { timing, command });
		} }
	});
	for (const [action, handler] of [['sync', shape.__smoothSync], ['shoot', shape.__smoothShoot]]) __register(topic + '/' + action, handler, topic);
	server = await createTestServer({ handler: {
		message(ws, ctx) { if (!ctx.isBinary && ctx.msg === undefined) handleRpc(ws, ctx.data, server.platform); }, close
	} });
	socket = new WebSocket(server.wsUrl);
	const frames = [];
	socket.addEventListener('message', event => frames.push(JSON.parse(event.data)));
	await until(() => socket.readyState === WebSocket.OPEN, 'native socket');
	async function rpc(action, args = []) {
		const id = 'native-shot-' + ++serial;
		socket.send(JSON.stringify({ rpc: topic + '/' + action, id, args }));
		const frame = await until(() => frames.find(value => value.topic === '__rpc' && value.event === id), action);
		expect(frame.data.ok).toBe(true);
		return frame.data.data;
	}
	const sync = await rpc('sync');
	const now = Date.now();
	await rpc('shoot', [{ cmd: { dx: 3 }, rt: now - 1000, ackT: now - 60 }]);
	await until(() => frames.some(frame => frame.event === 'event' && frame.data.type === 'launched'), 'projectile event');
	expect(calls).toHaveLength(1);
	const timing = calls[0].timing;
	expect(timing.rewindMs).toBeGreaterThan(0);
	expect(timing.rewindMs).toBeLessThanOrEqual(timing.reach);
	expect(timing.reach).toBeLessThanOrEqual(100);
	expect(timing.minUplink).toBeGreaterThanOrEqual(30);
	expect(timing.maxUplink).toBeGreaterThanOrEqual(timing.minUplink);
	expect(timing.interpDelay).toBeGreaterThan(0);
	await until(() => frames.some(frame => frame.event === 'update' && frame.data.key === sync.you && frame.data.data.x === 5 && frame.data.data.remaining === 0), 'projectile continuation');
	expect(applyContexts.some(ctx => 'rewindMs' in ctx || 'timing' in ctx)).toBe(false);
	expect(calls[0].ctx.applyTo(sync.you, { dx: 999 })).toBe(false);
	calls[0].ctx.emitEvent('late', {});
	await rpc('shoot', [{ cmd: { dx: 1 }, rt: now - 2000, ackT: now - 60 }]);
	expect(calls).toHaveLength(1);
	await rpc('shoot', [{ cmd: { dx: 1 }, rt: Date.now() + 1000 }]);
	expect(calls).toHaveLength(2);
	expect(calls[1].timing.rewindMs).toBe(0);
	expect(frames.some(frame => frame.event === 'event' && frame.data.type === 'late')).toBe(false);
}, 15000);
