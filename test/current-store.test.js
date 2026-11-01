import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileModule } from 'svelte/compiler';
import ts from 'typescript';
import { _generateSsrStubs } from '../src/vite/codegen-ssr.js';
import { _generateClientStubs } from '../src/vite/codegen-client.js';
import { _generateTypeDeclarations } from '../src/vite/codegen-types.js';

const roomSource = `// realtime-allow-public
import { live } from 'svelte-realtime/server';
export const room = live.room({ topic: (ctx, id) => 'room:' + id, init: () => [], presence: ctx => ({ key: ctx.user.id }), cursors: true, owner: true });
export const multi = live.multiplayer({ topic: (ctx, id) => 'multi:' + id, init: () => [], presence: ctx => ({ key: ctx.user.id }), cursors: true, owner: true, reactions: true });
`;

it('reads every client store through current with real Svelte effects and no cold wire subscriptions', () => {
	const dir = mkdtempSync(resolve('test/__current_rune__'));
	try {
		const rooms = resolve(dir, 'rooms.js');
		writeFileSync(rooms, roomSource);
		const multiplayer = compileModule(readFileSync(resolve('src/client-multiplayer.svelte.js'), 'utf8'), { filename: 'multiplayer.svelte.js', generate: 'client' }).js.code;
		writeFileSync(resolve(dir, 'multiplayer.js'), multiplayer.replaceAll("from './", "from '../../src/"));
		writeFileSync(resolve(dir, 'rooms-client.js'), _generateClientStubs(rooms, 'current-rooms', 'src/live').replace("'svelte-realtime/multiplayer'", "'./multiplayer.js'"));
		writeFileSync(resolve(dir, 'watch.js'), compileModule(`
			export class State {
				store;
				value = $derived(this.store.current);
				constructor(store) { this.store = store; }
			}
			export function watch(read) {
				const values = [];
				const stop = $effect.root(() => {
					const value = $derived.by(read);
					$effect.pre(() => { values.push(value); });
				});
				return { values, stop };
			}
		`, { filename: 'watch.svelte.js', generate: 'client' }).js.code);
		writeFileSync(resolve(dir, 'run.js'), `
import assert from 'node:assert/strict';
import { watch, State } from './watch.js';
class Socket {
	static sockets = [];
	static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
	constructor() { this.readyState = 0; this.sent = []; Socket.sockets.push(this); queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } }); }
	send(frame) { this.sent.push(JSON.parse(frame)); }
	close(code = 1000) { this.readyState = 3; queueMicrotask(() => this.onclose?.({ code, reason: '' })); }
	receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
globalThis.WebSocket = Socket;
globalThis.window = { location: { protocol: 'http:', host: 'localhost:5173' }, addEventListener() {}, removeEventListener() {} };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const client = await import('../../src/client.js');
const adapter = await import('svelte-adapter-uws/client');
const offline = await import('../../src/client/offline.js');
const stream = client.__stream('current/rows', { merge: 'crud', pendingDelay: 0 });
const ownedStreams = [stream];
stream.hydrate([{ id: 1, value: 2 }]);
let projections = 0;
let combinations = 0;
const mapped = stream.map(row => { projections++; return row.value; });
const combined = client.combine(mapped, client.pendingMutations, (rows, pending) => { combinations++; return { rows, pending }; });
const conditional = stream.when(true);
const events = client.onDerived(value => 'derived:' + value, client.status);
const stores = { stream, mapped, combined, conditional, error: stream.error, streamStatus: stream.status, pending: stream.pending, phase: stream.phase,
	status: client.status, failure: client.failure, health: client.health, degradation: client.degradation,
	quiescent: client.quiescent, pendingMutations: client.pendingMutations, uploading: client.uploading, empty: client.empty, events };
for (const [name, store] of Object.entries(stores)) assert.ok('current' in store, name + ' exposes current');
for (let i = 0; i < 3; i++) for (const store of Object.values(stores)) void store.current;
await tick();
assert.equal(Socket.sockets.length, 0, 'plain reads must not open a socket');
assert.deepEqual(stream.current, [{ id: 1, value: 2 }]);
assert.deepEqual(mapped.current, [2]);
assert.deepEqual(combined.current, { rows: [2], pending: 0 });
assert.equal(mapped.current, mapped.current, 'mapped snapshots retain their identity');
assert.equal(combined.current, combined.current, 'combined snapshots retain their identity');
assert.equal(projections, 1, 'plain reads do not repeat user projections');
assert.equal(combinations, 1, 'plain reads do not repeat user combinations');
assert.equal(stream.rune(), stream, 'rune is the same handle');
assert.equal(mapped.rune(), mapped);
assert.equal(client.createReactiveStream(stream), stream);
assert.equal(client.quiescent.current, true);
assert.equal(client.health.current, 'healthy');
assert.equal(client.uploading.current, false);
const observers = Object.fromEntries(Object.entries(stores).map(([name, store]) => [name, watch(() => store.current)]));
const state = new State(stream);
const classObserver = watch(() => state.value);
await tick(); await tick();
assert.equal(Socket.sockets.length, 1);
const ws = Socket.sockets[0];
const request = ws.sent.find(frame => frame.rpc === 'current/rows');
assert.ok(request, 'effect attaches the real stream');
assert.ok(observers.pending.values.includes(true), 'pending reacts before the answer');
assert.ok(observers.quiescent.values.includes(false), 'quiescence reacts while attaching');
ws.receive({ topic: '__rpc', event: request.id, data: { ok: true, data: [{ id: 2, value: 3 }], topic: 'current-rows', merge: 'crud' } });
await tick();
assert.deepEqual(observers.stream.values.at(-1), [{ id: 2, value: 3 }]);
assert.deepEqual(classObserver.values.at(-1), [{ id: 2, value: 3 }]);
assert.deepEqual(observers.mapped.values.at(-1), [3]);
assert.deepEqual(observers.combined.values.at(-1), { rows: [3], pending: 0 });
assert.deepEqual(observers.conditional.values.at(-1), [{ id: 2, value: 3 }]);
assert.equal(observers.phase.values.at(-1), 'attached');
assert.equal(observers.streamStatus.values.at(-1), 'connected');
assert.equal(observers.quiescent.values.at(-1), true);
assert.equal(observers.status.values.at(-1), 'open');
const framesBefore = ws.sent.length;
for (let i = 0; i < 10; i++) for (const store of Object.values(stores)) void store.current;
await tick();
assert.equal(ws.sent.length, framesBefore, 'plain reads leave wire subscriptions alone');
ws.receive({ topic: 'current-rows', event: 'created', data: { id: 3, value: 4 } });
offline._setUploading(true);
client._setSmoothDegraded(true);
ws.receive({ topic: '__realtime', event: 'degraded', data: { mitigation: { retryAfterMs: 2000 } } });
ws.receive({ topic: 'derived:open', event: 'changed', data: { value: 1 } });
await tick();
assert.deepEqual(observers.stream.values.at(-1), [{ id: 2, value: 3 }, { id: 3, value: 4 }]);
assert.deepEqual(observers.mapped.values.at(-1), [3, 4]);
assert.equal(observers.uploading.values.at(-1), true);
assert.equal(observers.health.values.at(-1), 'degraded');
assert.equal(observers.degradation.values.at(-1).mitigation.retryAfterMs, 2000);
assert.equal(observers.events.values.at(-1).data.value, 1);
const { writable } = await import('svelte/store');
const foreign = writable(1);
foreign.current = 1;
const wrapped = client.createReactiveStream(foreign);
const foreignObserver = watch(() => wrapped.current);
await tick();
foreign.set(2);
await tick();
assert.equal(foreignObserver.values.at(-1), 2, 'foreign current properties do not bypass the reactive bridge');
foreignObserver.stop();
const foreignCombined = client.combine(foreign, client.uploading, value => value);
const foreignCombination = watch(() => foreignCombined.current);
await tick();
foreign.set(3);
await tick();
assert.equal(foreignCombination.values.at(-1), 3, 'foreign snapshots do not suppress subscription updates');
foreignCombination.stop();
const peekSource = client.__stream('current/peek', { merge: 'set' });
ownedStreams.push(peekSource);
peekSource.hydrate(1);
const peekCombined = client.combine(peekSource, client.uploading, value => value);
let peek = false;
const stopPeek = peekSource.subscribe(() => { if (peek) void peekCombined.current; });
const deliveries = [];
const stopCombined = peekCombined.subscribe(value => deliveries.push(value));
peek = true;
peekSource.hydrate(2);
assert.equal(deliveries.at(-1), 2, 'a read before delivery cannot consume the notification');
stopCombined(); stopPeek();
const shifted = client.combine(peekSource, client.uploading, value => value + 1);
const diamond = client.combine(peekSource, shifted, (value, next) => [value, next]);
const diamondValues = [];
const stopDiamond = diamond.subscribe(value => diamondValues.push(value));
peekSource.hydrate(3);
assert.deepEqual(diamondValues.at(-1), [3, 4], 'a shared source refreshes every projected input');
stopDiamond();
const always = peekSource.when(true);
const never = peekSource.when(false);
peekSource.hydrate(4);
const beforeConditionalRead = ws.sent.length;
assert.equal(always.current, 4, 'an unconditional view reads the latest cached parent snapshot');
assert.equal(never.current, undefined);
await tick();
assert.equal(ws.sent.length, beforeConditionalRead, 'conditional snapshot reads do not attach');
for (const kind of ['store', 'function']) {
	let enabled = true;
	const toggle = writable(true);
	const gated = stream.when(kind === 'store' ? toggle : () => enabled);
	const stop = gated.subscribe(() => {});
	const last = gated.current;
	stop();
	assert.equal(gated.current, last, 'a detached conditional store keeps its last snapshot');
	enabled = false;
	toggle.set(false);
	const disabledValues = [];
	const stopDisabled = gated.subscribe(value => disabledValues.push(value));
	assert.equal(disabledValues.at(-1), undefined, 'a later false condition clears the retained snapshot');
	assert.equal(gated.current, undefined);
	stopDisabled();
}
const namespaces = await import('./rooms-client.js');
for (const namespace of [namespaces.room, namespaces.multi]) {
	for (const member of ['data', 'presence', 'cursors', 'owner', 'reactions']) {
		if (!namespace[member]) continue;
		const child = namespace[member]('one');
		ownedStreams.push(child);
		assert.ok('current' in child, member + ' has current');
		const before = ws.sent.length;
		void child.current;
		await tick();
		assert.equal(ws.sent.length, before, member + ' cold read sends nothing');
		const observer = watch(() => child.current);
		await tick(); await tick();
		const request = ws.sent.findLast(frame => frame.rpc === child.__streamPath);
		assert.ok(request, member + ' reaction attaches');
		const value = member === 'owner' ? { key: 'one', reason: 'join' } : [{ id: 1, key: 'one' }];
		ws.receive({ topic: '__rpc', event: request.id, data: { ok: true, data: value, topic: child.__streamPath, merge: child.__streamOptions.merge || 'crud' } });
		await tick();
		assert.deepEqual(observer.values.at(-1), value);
		const next = member === 'owner' ? { key: 'two', reason: 'join' } : [{ id: 2, key: 'two' }];
		child.hydrate(next);
		await tick();
		assert.deepEqual(observer.values.at(-1), next, member + ' reacts to its next snapshot');
		observer.stop();
		await tick(); await tick();
		const stopped = ws.sent.length;
		void child.current;
		await tick();
		assert.equal(ws.sent.length, stopped, member + ' stays detached');
	}
}
client.configure({ offline: { queue: true } });
ws.readyState = Socket.CLOSED;
ws.onclose({ code: 1006, reason: '' });
await tick();
assert.equal(observers.failure.values.at(-1).code, 1006);
const queued = client.__rpc('current/edit')();
queued.catch(() => {});
await tick();
assert.equal(observers.pendingMutations.values.at(-1), 1);
assert.equal(observers.status.values.at(-1), 'disconnected');
assert.equal(client.pendingMutations.current, 1);
adapter.connect().close();
await tick();
assert.equal(observers.error.values.at(-1).code, 'CONNECTION_CLOSED');
assert.equal(observers.status.values.at(-1), 'failed');
assert.equal(observers.phase.values.at(-1), 'failed');
for (const observer of Object.values(observers)) observer.stop();
classObserver.stop();
await tick(); await tick();
const framesStopped = ws.sent.length;
for (const store of Object.values(stores)) void store.current;
await tick();
assert.equal(ws.sent.length, framesStopped, 'reads after teardown must not attach again');
client.configure({ resumeGraceMs: 0 });
for (const owned of ownedStreams) owned.subscribe(() => {})();
await tick();
adapter.connect().close();
console.log('current store effects and lifetime passed');
`);
		const result = spawnSync(process.execPath, ['--conditions=browser', resolve(dir, 'run.js')], { encoding: 'utf8', timeout: 15000, windowsHide: true });
		expect(result.error).toBeUndefined();
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(result.stdout).toContain('current store effects and lifetime passed');
	} finally {
		if (dirname(dir) !== resolve('test') || !basename(dir).startsWith('__current_rune__')) throw new Error('Invalid test directory');
		rmSync(dir, { recursive: true, force: true });
	}
});

it('types current as readonly on every public store result', () => {
	const file = resolve('test/current-consumer.ts').replaceAll('\\', '/');
	const source = `
import { __stream, combine, createReactiveStream, onDerived, status, failure, health, degradation,
 quiescent, pendingMutations, uploading, empty, type CurrentReadable, type StreamStore } from '../src/client.js';
declare const stream: StreamStore<{ id: number }[]>;
const value: { id: number }[] = stream.current;
const mapped: number[] = stream.map(row => row.id).current;
const count: number = combine(stream, pendingMutations, (rows, pending) => rows.length + pending).current;
const conditional: { id: number }[] | undefined = stream.when(true).current;
const healthValue: 'healthy' | 'degraded' | 'outdated' | 'incompatible' = health.current;
const active: boolean = degradation.current.active;
const pending: boolean = stream.pending.current;
const error: string | undefined = stream.error.current?.message;
const uploadingValue: boolean = uploading.current;
const quiet: boolean = quiescent.current;
const statusValue: string = status.current;
const streamStatus: string = stream.status.current;
const phase: string = stream.phase.current;
const failureValue = failure.current;
const noValue: undefined = empty.current;
const topic = onDerived(value => value, status).current;
const alias: typeof stream = stream.rune();
const readable: CurrentReadable<number[]> = stream.map(row => row.id);
const primitive = createReactiveStream(stream).current;
// @ts-expect-error current is readonly
stream.current = [];
// @ts-expect-error indicator current is readonly
uploading.current = false;
// @ts-expect-error mapped values keep their element type
const invalid: string[] = stream.map(row => row.id).current;
void value; void mapped; void count; void conditional; void healthValue; void active; void pending; void error;
void uploadingValue; void quiet; void statusValue; void streamStatus; void phase; void failureValue; void noValue;
void topic; void alias; void readable; void primitive; void invalid; void __stream;
`;
	const options = { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
	const host = ts.createCompilerHost(options);
	const getSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (name, ...args) => name === file ? ts.createSourceFile(name, source, options.target, true) : getSourceFile(name, ...args);
	const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([file], options, host)).map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '));
	expect(diagnostics).toEqual([]);
});

it('types current as readonly on generated room and multiplayer stores', () => {
	const dir = mkdtempSync(resolve('test/__current_rune__'));
	try {
		writeFileSync(resolve(dir, 'rooms.js'), roomSource);
		const declarations = resolve(dir, 'rooms.d.ts');
		writeFileSync(declarations, _generateTypeDeclarations(dir, 'src/live'));
		const consumer = resolve(dir, 'consumer.ts');
		writeFileSync(consumer, `
import { room, multi, empty } from '$live/rooms';
import type { CurrentReadable } from 'svelte-realtime/client';
const data: CurrentReadable<any> = room.data('one');
const presence: CurrentReadable<any> = multi.presence!('one');
const cursors: CurrentReadable<any> = multi.cursors!('one');
const owner: CurrentReadable<any> = multi.owner!('one');
const reactions: CurrentReadable<any> = multi.reactions('one');
const status: string = multi.status.current;
const none: undefined = empty.current;
// @ts-expect-error generated streams expose readonly current
room.data('one').current = [];
// @ts-expect-error the reaction stream retains its readonly store type
multi.reactions('one').current = [];
// @ts-expect-error generated status stores expose readonly current
multi.status.current = 'open';
void data; void presence; void cursors; void owner; void reactions; void status; void none;
`);
		const options = { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
		const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([consumer, declarations], options)).map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '));
		expect(diagnostics).toEqual([]);
	} finally {
		if (dirname(dir) !== resolve('test') || !basename(dir).startsWith('__current_rune__')) throw new Error('Invalid test directory');
		rmSync(dir, { recursive: true, force: true });
	}
});

it('renders current values, maps and combinations from generated SSR stores', () => {
	const dir = mkdtempSync(resolve('test/__current_rune__'));
	try {
		const source = resolve(dir, 'live.js');
		writeFileSync(source, roomSource + `\nexport const rows = live.stream('rows', () => []);\nexport const page = live.stream(id => 'page:' + id, () => []);\nexport const readable = live.stream('readable', () => []);`);
		const code = _generateSsrStubs(source, 'current');
		// The generator writes a Vite-resolved source path. This probe executes
		// only its client-shaped stores under Node, without re-exporting handlers.
		writeFileSync(resolve(dir, 'ssr.js'), code.replace(/^export \* from .*;$/m, ''));
		writeFileSync(resolve(dir, 'run.js'), `
import assert from 'node:assert/strict';
import { rows, page, room, multi, readable } from './ssr.js';
import { combine, empty } from '../../src/client.js';
const hydrated = rows.hydrate([{ id: 1 }]);
assert.deepEqual(hydrated.current, [{ id: 1 }]);
assert.deepEqual(hydrated.map(row => row.id).current, [1]);
assert.equal(hydrated.rune(), hydrated);
assert.equal(hydrated.pending.current, false);
assert.equal(hydrated.error.current, null);
assert.equal(hydrated.status.current, 'loading');
assert.equal(hydrated.phase.current, 'initialized');
assert.equal(Object.getOwnPropertyDescriptor(hydrated, 'current').set, undefined);
assert.deepEqual(page('one').hydrate([2]).current, [2]);
assert.deepEqual(readable.hydrate([3]).current, [3]);
assert.deepEqual(combine(hydrated, empty, rows => rows).current, [{ id: 1 }]);
for (const namespace of [room, multi]) {
	for (const member of ['data', 'presence', 'cursors', 'owner']) {
		assert.ok('current' in namespace[member]('one'));
		assert.equal(namespace[member]('one').current, undefined);
	}
}
assert.equal(multi.status.current, 'connecting');
assert.equal(multi.reactions('one').current, undefined);
console.log('SSR current values passed');
`);
		const result = spawnSync(process.execPath, [resolve(dir, 'run.js')], { encoding: 'utf8', timeout: 15000, windowsHide: true });
		expect(result.error).toBeUndefined();
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(result.stdout).toContain('SSR current values passed');
	} finally {
		if (dirname(dir) !== resolve('test') || !basename(dir).startsWith('__current_rune__')) throw new Error('Invalid test directory');
		rmSync(dir, { recursive: true, force: true });
	}
});
