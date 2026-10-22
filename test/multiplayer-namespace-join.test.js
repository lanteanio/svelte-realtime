import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileModule } from 'svelte/compiler';
import { writable } from 'svelte/store';
import { _generateClientStubs } from '../src/vite/codegen-client.js';
import { createTestEnv } from '../src/testing.js';
import { live, handleRpc, unsubscribe } from '../src/server.js';
import { mockWs } from './helpers/mock-ws.js';
import { toArrayBuffer } from './helpers/encode.js';

// A generated multiplayer namespace over the real client stream, the real
// dispatcher and the shipped rune class, with frames delivered to the server
// as the adapter would send them. The server answers a subscribe only after
// its guard, platform subscribe and loader have run, so anything sent right
// behind the subscribe frame reaches it before the join exists.

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
const probeRoot = resolve(import.meta.dirname, '__namespace_join_rune__');
const dirs = [];
const svelteUrl = JSON.stringify(pathToFileURL(resolve(root, 'node_modules/svelte/src/index-client.js')).href);
const reactivityUrl = JSON.stringify(pathToFileURL(resolve(root, 'node_modules/svelte/src/reactivity/index-client.js')).href);
let env, adapter, cleanups;

afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) fn();
	// Let the releases a cleanup sends be answered before the connection ends.
	await vi.advanceTimersByTimeAsync(0);
	adapter?.status.set('failed');
	await vi.advanceTimersByTimeAsync(0);
	env?.cleanup();
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (existsSync(probeRoot) && readdirSync(probeRoot).length === 0) rmSync(probeRoot, { recursive: true, force: true });
	vi.restoreAllMocks();
});

const CONFIG = `{
  topic: (ctx, id) => 'ns:' + id, topicArgs: 1,
  init: async () => [], presence: ctx => ({ name: ctx.user.id }),
  cursors: true, typing: true, locks: true, reactions: true
}`;

// Component-shaped helpers, compiled with the same Svelte runtime as the room.
const PROBE = `
import { flushSync } from 'svelte';

// A page that holds board.room(() => id) and, in a mount effect, sends through
// the namespace directly.
export function mountSend(board, first, send) {
	let id = $state(first);
	let room;
	const stop = $effect.root(() => {
		room = board.room(() => id);
		$effect(() => { send(id); });
	});
	flushSync();
	return { room, setId(next) { id = next; flushSync(); }, stop() { stop(); flushSync(); } };
}

// The README lock pattern: the effect takes the lock through here() and
// releases it in its cleanup.
export function lockEffect(board, first) {
	let id = $state(first);
	let room;
	const stop = $effect.root(() => {
		room = board.room(() => id);
		$effect(() => {
			const here = room.here();
			here.acquireLock('title');
			return () => { here.releaseLock('title'); };
		});
	});
	flushSync();
	return { room, setId(next) { id = next; flushSync(); }, stop() { stop(); flushSync(); } };
}
`;

async function setup() {
	vi.resetModules();
	vi.useFakeTimers();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	cleanups = [];
	env = createTestEnv();
	env.register('collab', { board: new Function('live', `return live.multiplayer(${CONFIG});`)(live) });
	const listeners = new Map(), frames = [];
	const emit = (topic, event, data) => {
		for (const fn of [...(listeners.get(topic) || [])]) fn(JSON.parse(JSON.stringify({ event, data })));
	};
	const ws = mockWs({ id: 'alice' });
	const publish = env.platform.publish;
	env.platform.publish = (topic, event, data, options) => {
		const result = publish(topic, event, data, options);
		if (ws.isSubscribed(topic)) emit(topic, event, data);
		return result;
	};
	const send = env.platform.send;
	env.platform.send = (target, topic, event, data) => {
		if (target === ws) { emit(topic, event, data); return 1; }
		return send(target, topic, event, data);
	};
	const sendFrame = frame => {
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
	const compile = (source, filename) => compileModule(source, { filename, generate: 'client' }).js.code
		.replace(/(['"])svelte\/reactivity\1/g, reactivityUrl)
		.replace(/from (['"])svelte\1/g, 'from ' + svelteUrl);
	const runeSource = readFileSync(resolve(root, 'src/client-multiplayer.svelte.js'), 'utf8')
		.replace("'./shared/color.js'", JSON.stringify(pathToFileURL(resolve(root, 'src/shared/color.js')).href))
		.replace("'./client.js'", JSON.stringify(pathToFileURL(resolve(root, 'src/client.js')).href));
	writeFileSync(resolve(dir, 'room.js'), compile(runeSource, 'client-multiplayer.svelte.js'));
	writeFileSync(resolve(dir, 'probe.js'), compile(PROBE, 'probe.svelte.js'));
	const runes = await import(pathToFileURL(resolve(dir, 'room.js')).href);
	const probe = await import(pathToFileURL(resolve(dir, 'probe.js')).href);
	const fixture = resolve(dir, 'collab.js');
	writeFileSync(fixture, `// realtime-allow-public\nimport { live } from 'svelte-realtime/server';\nexport const board = live.multiplayer(${CONFIG});`);
	const generated = _generateClientStubs(fixture, 'collab', 'src/live')
		.replace(/^import .*;\r?\n/gm, '').replace(/^export \{.*;\r?\n/gm, '')
		.replace(/export const /g, 'const ').replace(/^if \(import.meta.hot\).*\r?\n?/gm, '');
	const board = new Function(...Object.keys(client), 'MultiplayerRoom', 'localKeySource', generated + '\nreturn board;')(
		...Object.values(client), runes.MultiplayerRoom, runes.localKeySource);
	board.identify('alice');
	const peer = env.connect({ id: 'bob' });
	const watch = id => ({
		roster: peer.subscribe('collab/board/__presence', id),
		cursors: peer.subscribe('collab/board/__cursors', id),
		reactions: peer.subscribe('collab/board/__reactions', id)
	});
	const sent = path => frames.flatMap(frame => frame.batch || [frame]).filter(frame => frame.rpc === 'collab/board/' + path);
	return { board, probe, frames, sent, watch };
}

it('a namespace move and field sent in a mount effect beside board.room() reach every peer after the join', async () => {
	const { board, probe, sent, watch } = await setup();
	const peer = watch('r');
	await vi.advanceTimersByTimeAsync(0);
	const page = probe.mountSend(board, 'r', id => {
		board.move(id, { x: 5, y: 6 });
		board._setField(id, { typing: true });
		board._emitReaction.fireAndForget(id, 'wave');
	});
	cleanups.push(() => page.stop());
	// Nothing goes out ahead of the join the page's room view started.
	expect(sent('__cursor/move')).toEqual([]);
	expect(sent('__presence/update')).toEqual([]);
	expect(sent('__reaction/emit')).toEqual([]);
	await vi.advanceTimersByTimeAsync(0);
	expect(sent('__cursor/move')).toHaveLength(1);
	expect(sent('__presence/update')).toHaveLength(1);
	expect(sent('__reaction/emit')).toHaveLength(1);
	expect(peer.cursors.value).toEqual([expect.objectContaining({ key: 'alice', x: 5, y: 6 })]);
	expect(peer.roster.value).toEqual([expect.objectContaining({ key: 'alice', typing: true })]);
	expect(JSON.stringify(peer.reactions.value)).toContain('wave');
	expect(page.room.typing).toEqual([]);
});

it('an awaited namespace field send held for the join answers its caller with the server reply', async () => {
	const { board, sent, watch } = await setup();
	const peer = watch('r');
	const room = board.room('r');
	cleanups.push(() => room.destroy());
	const results = [];
	const pending = board._setField('r', { 'lock:title': true }).then(value => results.push(['ok', value]), error => results.push(['error', error.code]));
	const viaWith = board._setField.with({ timeout: 5000 })('r', { typing: true }).then(() => results.push(['with']));
	expect(sent('__presence/update')).toEqual([]);
	await vi.advanceTimersByTimeAsync(0);
	await pending;
	await viaWith;
	expect(results).toEqual([['ok', undefined], ['with']]);
	// Both fields went out merged in one delta, after the join.
	expect(sent('__presence/update')).toHaveLength(1);
	expect(sent('__presence/update')[0].args).toEqual(['r', { 'lock:title': true, typing: true }]);
	expect(peer.roster.value[0]).toMatchObject({ key: 'alice', 'lock:title': true, typing: true });
});

it('a namespace send with no view holding the room, or for another room, goes out at once', async () => {
	const { board, sent } = await setup();
	board.move('free', { x: 1 });
	expect(sent('__cursor/move')).toHaveLength(1);
	const room = board.room('r');
	cleanups.push(() => room.destroy());
	board.move('other', { x: 2 });
	expect(sent('__cursor/move')).toHaveLength(2);
	board.move('r', { x: 3 });
	expect(sent('__cursor/move')).toHaveLength(2);
	await vi.advanceTimersByTimeAsync(0);
	expect(sent('__cursor/move').map(frame => frame.args)).toEqual([['free', { x: 1 }], ['other', { x: 2 }], ['r', { x: 3 }]]);
	// Once joined, a namespace send for the held room goes straight out.
	board.move('r', { x: 4 });
	expect(sent('__cursor/move')).toHaveLength(4);
});

it('the hold over a real stream store flushes exactly once when the subscribe is attached', async () => {
	const { board, sent, watch } = await setup();
	const peer = watch('r');
	const phases = [];
	const off = board.data('r').phase.subscribe(p => phases.push(p));
	const room = board.room('r');
	cleanups.push(() => { room.destroy(); off(); });
	const lock = room.acquireLock('title');
	room.move({ x: 1 });
	room.move({ x: 2 });
	expect(phases.at(-1)).toBe('attaching');
	expect(sent('__presence/update')).toEqual([]);
	expect(sent('__cursor/move')).toEqual([]);
	await vi.advanceTimersByTimeAsync(0);
	await lock;
	expect(phases).toEqual(['initialized', 'attaching', 'attached']);
	expect(sent('__presence/update')).toHaveLength(1);
	expect(sent('__cursor/move').map(frame => frame.args)).toEqual([['r', { x: 2 }]]);
	expect(peer.roster.value[0]).toMatchObject({ key: 'alice', 'lock:title': true });
	await vi.advanceTimersByTimeAsync(1000);
	expect(sent('__presence/update')).toHaveLength(1);
	expect(sent('__cursor/move')).toHaveLength(1);
});

it('the hold over a real stream store flushes exactly once when the store detaches while attaching', async () => {
	const { board, sent } = await setup();
	const phases = [];
	const off = board.data('r').phase.subscribe(p => phases.push(p));
	cleanups.push(off);
	const room = board.room('r');
	const lock = room.acquireLock('title');
	room.destroy();
	expect(sent('__presence/update')).toEqual([]);
	await vi.advanceTimersByTimeAsync(0);
	await lock;
	expect(phases).toContain('detached');
	expect(sent('__presence/update')).toHaveLength(1);
	await vi.advanceTimersByTimeAsync(1000);
	expect(sent('__presence/update')).toHaveLength(1);
});

it('a switch while the first join is in flight keeps the cleanup release on a real stream store', async () => {
	const { board, probe, sent, watch } = await setup();
	const a = watch('a');
	const b = watch('b');
	await vi.advanceTimersByTimeAsync(0);
	const view = probe.lockEffect(board, 'a');
	cleanups.push(() => view.stop());
	view.setId('b');
	expect(sent('__presence/update')).toEqual([]);
	await vi.advanceTimersByTimeAsync(0);
	const updates = sent('__presence/update').map(frame => frame.args);
	// The lock taken and released in 'a' goes out once, as the release.
	expect(updates.filter(args => args[0] === 'a')).toEqual([['a', { 'lock:title': null }]]);
	expect(updates.filter(args => args[0] === 'b')).toEqual([['b', { 'lock:title': true }]]);
	expect(a.roster.value.some(entry => entry['lock:title'] === true)).toBe(false);
	expect(b.roster.value[0]).toMatchObject({ key: 'alice', 'lock:title': true });
});
