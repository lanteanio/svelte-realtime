import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileModule } from 'svelte/compiler';
import { writable } from 'svelte/store';
import { _generateClientStubs } from '../src/vite/codegen-client.js';
import { createTestEnv } from '../src/testing.js';
import { live, handleRpc, close, unsubscribe } from '../src/server.js';
import { mockWs } from './helpers/mock-ws.js';
import { toArrayBuffer } from './helpers/encode.js';

const wire = vi.hoisted(() => ({ adapter: null }));
vi.mock('svelte-adapter-uws/client', () => ({
	connect: () => wire.adapter,
	on: topic => wire.adapter.on(topic),
	status: { subscribe: fn => wire.adapter.status.subscribe(fn) },
	failure: { subscribe: fn => wire.adapter.failure.subscribe(fn) },
	denials: { subscribe: fn => wire.adapter.denials.subscribe(fn) },
	onRequest: () => () => {},
	setTopicManaged: () => {}
}));

const root = resolve(import.meta.dirname, '..');
const probeRoot = resolve(import.meta.dirname, '__reconnect_rune__');
const dirs = [];
let env, room, adapter, ws;

afterEach(async () => {
	room?.destroy();
	adapter?.status.set('failed');
	await vi.advanceTimersByTimeAsync(0);
	env?.cleanup();
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

it('the generated room rejoins after grace expiry and restores one merged delta to a peer', async () => {
	vi.useFakeTimers();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	env = createTestEnv();
	env.register('collab', { board: live.multiplayer({
		topic: (ctx, id) => 'reconnect:' + id, topicArgs: 1,
		init: async () => [], presence: ctx => ({ name: ctx.user.id }),
		typing: true, locks: true, selections: 'offset'
	}) });
	const listeners = new Map(), frames = [];
	const emit = (topic, event, data) => {
		for (const fn of [...(listeners.get(topic) || [])]) fn(JSON.parse(JSON.stringify({ event, data })));
	};
	let online = true;
	ws = mockWs({ id: 'alice' });
	const publish = env.platform.publish;
	env.platform.publish = (topic, event, data, options) => {
		const result = publish(topic, event, data, options);
		if (online && ws.isSubscribed(topic)) emit(topic, event, data);
		return result;
	};
	const send = env.platform.send;
	env.platform.send = (target, topic, event, data) => {
		if (target === ws) { if (online) emit(topic, event, data); return 1; }
		return send(target, topic, event, data);
	};
	const sendFrame = frame => {
		if (!online) throw new Error('A room send escaped while disconnected');
		frames.push(frame);
		if (frame.unsubscribe) {
			ws.unsubscribe(frame.unsubscribe);
			unsubscribe(ws, frame.unsubscribe, { platform: env.platform });
		} else handleRpc(ws, toArrayBuffer(frame), env.platform);
	};
	adapter = {
		status: writable('open'), failure: writable(null), denials: writable(null),
		bufferedAmount: 0, send: sendFrame, sendQueued: sendFrame,
		onRequest: () => () => {},
		on(topic) { return { subscribe(fn) {
			if (!listeners.has(topic)) listeners.set(topic, new Set());
			listeners.get(topic).add(fn);
			return () => listeners.get(topic).delete(fn);
		} }; }
	};
	wire.adapter = adapter;
	const client = await import('../src/client.js');
	client.configure({ resumeGraceMs: 0 });
	mkdirSync(probeRoot, { recursive: true });
	const dir = mkdtempSync(resolve(probeRoot, 'probe-'));
	dirs.push(dir);
	const source = readFileSync(resolve(root, 'src/client-multiplayer.svelte.js'), 'utf8')
		.replace("'./shared/color.js'", JSON.stringify(pathToFileURL(resolve(root, 'src/shared/color.js')).href));
	const compiled = compileModule(source, { filename: 'client-multiplayer.svelte.js', generate: 'client' }).js.code
		.replace(/(['"])svelte\/reactivity\1/g, JSON.stringify(pathToFileURL(resolve(root, 'node_modules/svelte/src/reactivity/index-client.js')).href))
		.replace(/from (['"])svelte\1/g, 'from ' + JSON.stringify(pathToFileURL(resolve(root, 'node_modules/svelte/src/index-client.js')).href));
	const runePath = resolve(dir, 'room.js');
	writeFileSync(runePath, compiled);
	const runes = await import(pathToFileURL(runePath).href);
	const fixture = resolve(dir, 'collab.js');
	writeFileSync(fixture, `// realtime-allow-public
import { live } from 'svelte-realtime/server';
export const board = live.multiplayer({
  topic: (ctx, id) => 'reconnect:' + id, topicArgs: 1,
  init: async () => [], presence: ctx => ({ name: ctx.user.id }),
  typing: true, locks: true, selections: 'offset'
});`);
	const generated = _generateClientStubs(fixture, 'collab', 'src/live')
		.replace(/^import .*;\r?\n/gm, '').replace(/^export \{.*;\r?\n/gm, '')
		.replace(/export const /g, 'const ').replace(/^if \(import.meta.hot\).*\r?\n?/gm, '');
	const board = new Function(...Object.keys(client), 'MultiplayerRoom', 'localKeySource', generated + '\nreturn board;')(
		...Object.values(client), runes.MultiplayerRoom, runes.localKeySource);
	board.identify('alice');
	const peer = env.connect({ id: 'bob' });
	const roster = peer.subscribe('collab/board/__presence', 'r');
	room = board.room('r');
	await vi.advanceTimersByTimeAsync(0);
	expect(roster.value.map(value => value.key)).toEqual(['alice']);
	const lock = room.acquireLock('title');
	room.acquireLock('body');
	room.setSelection({ start: 1, end: 3 });
	room.setTyping(true);
	await vi.advanceTimersByTimeAsync(0);
	await lock;
	expect(roster.value[0]).toMatchObject({ 'lock:title': true, 'lock:body': true, typing: true, selection: { start: 1, end: 3 } });
	const subscribeCount = frames.filter(frame => frame.subscribe).length;
	adapter.status.set('suspended');
	const backgroundTyping = room.setTyping(false);
	await vi.advanceTimersByTimeAsync(0);
	await backgroundTyping;
	expect(roster.value[0].typing).toBe(false);
	adapter.status.set('open');
	const foregroundTyping = room.setTyping(true);
	await vi.advanceTimersByTimeAsync(0);
	await foregroundTyping;
	expect(roster.value[0].typing).toBe(true);
	expect(frames.filter(frame => frame.subscribe)).toHaveLength(subscribeCount);
	online = false;
	adapter.status.set('disconnected');
	close(ws, { platform: env.platform });
	await vi.advanceTimersByTimeAsync(5001);
	expect(roster.value).toEqual([]);
	const release = room.releaseLock('title');
	frames.length = 0;
	ws = mockWs({ id: 'alice' });
	online = true;
	adapter.status.set('open');
	expect(frames).toEqual([]);
	await vi.advanceTimersByTimeAsync(100);
	await release;
	expect(roster.value).toHaveLength(1);
	expect(roster.value[0]).toMatchObject({ key: 'alice', 'lock:title': null, 'lock:body': true, typing: true, selection: { start: 1, end: 3 } });
	const fields = frames.flatMap(frame => frame.batch || [frame]).filter(frame => frame.rpc === 'collab/board/__presence/update');
	expect(fields).toHaveLength(1);
	expect(fields[0].args[1]).toEqual({ 'lock:title': null, 'lock:body': true, selection: { start: 1, end: 3 }, typing: true });
});
