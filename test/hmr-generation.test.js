import { afterEach, expect, it, vi } from 'vitest';
import { live, realtime, __register, __registerGuard, __registerDerived, __registerEffect, __registerCron, setCronPlatform, __directCall, handleRpc, _activateDerived, _prepareHmr, _restoreHmr, _resetLifecycle } from '../src/server.js';
import { _resolveAllLazy } from '../src/server/lazy.js';
import { effectRegistry } from '../src/server/state.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { mockWs } from './helpers/mock-ws.js';
import { toArrayBuffer } from './helpers/encode.js';

afterEach(() => _prepareHmr());
const context = { user: { id: 'test' } };
function delayed() {
	let finish;
	const started = {};
	const loader = () => {
		started.value = true;
		started.calls = (started.calls || 0) + 1;
		return new Promise(resolve => { finish = resolve; });
	};
	loader.__lazy = true;
	return { loader, started, finish: value => finish(value) };
}

it.each([false, true])('an older pending handler cannot replace or remove a new registration (empty: %s)', async empty => {
	const pending = delayed();
	__register('reload/read', pending.loader);
	const call = __directCall('reload/read', [], {}, context).catch(error => error);
	await expect.poll(() => pending.started.value).toBe(true);
	__register('reload/read', live(() => 'current'));
	pending.finish(empty ? undefined : live(() => 'old'));
	expect(await call).toMatchObject({ code: 'UNAVAILABLE' });
	expect(await __directCall('reload/read', [], {}, context)).toBe('current');
});

it('an older pending guard cannot replace the current refusal', async () => {
	const pending = delayed();
	__register('reload/read', live(() => 'private'));
	__registerGuard('reload', pending.loader);
	const call = __directCall('reload/read', [], {}, context);
	const rejected = expect(call).rejects.toMatchObject({ code: 'UNAVAILABLE' });
	await expect.poll(() => pending.started.value).toBe(true);
	__registerGuard('reload', () => { throw new Error('denied'); });
	pending.finish(() => true);
	await rejected;
	await expect(__directCall('reload/read', [], {}, context)).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

it('a resolved absent guard stays paired with the loaded handler after a broken save', async () => {
	__register('reload/read', live(() => 'working value'));
	__registerGuard('reload', Object.assign(async () => undefined, { __lazy: true }));
	expect(await __directCall('reload/read', [], {}, context)).toBe('working value');
	const broken = () => Object.assign(async () => { throw new Error('broken module'); }, { __lazy: true });
	__register('reload/read', broken());
	__registerGuard('reload', broken());
	expect(await __directCall('reload/read', [], {}, context)).toBe('working value');
	__register('reload/read', live(() => 'repaired value'));
	__registerGuard('reload', Object.assign(async () => () => { throw new Error('denied'); }, { __lazy: true }));
	await expect(__directCall('reload/read', [], {}, context)).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

it('a stale reload snapshot cannot restore over a newer generation', async () => {
	__register('reload/read', live(() => 'old'));
	const old = _prepareHmr();
	__register('reload/read', live(() => 'middle'));
	_prepareHmr();
	__register('reload/read', live(() => 'current'));
	_restoreHmr(old);
	expect(await __directCall('reload/read', [], {}, context)).toBe('current');
});

it('a pending deferred declaration cannot register after its generation is cleared', async () => {
	const pending = delayed();
	__registerDerived('reload/read', pending.loader);
	const loading = _resolveAllLazy();
	await expect.poll(() => pending.started.value).toBe(true);
	_prepareHmr();
	__register('reload/read', live(() => 'current'));
	pending.finish(live.derived(['reload:source'], () => 'old'));
	await loading;
	expect(await __directCall('reload/read', [], {}, context)).toBe('current');
});

it.each(['direct', 'rpc', 'binary', 'upload'])('an old %s handler cannot run after its pending guard is removed', async kind => {
	const pending = delayed();
	let executions = 0;
	const body = () => { executions++; return 'old private value'; };
	__register('reload/read', kind === 'upload' ? live.upload(body) : kind === 'binary' ? live.binary(body) : live(body));
	__registerGuard('reload', pending.loader);
	const platform = mockPlatform();
	const ws = mockWs({ id: 'test' });
	let call;
	if (kind === 'direct') call = __directCall('reload/read', [], platform, context).then(data => ({ ok: true, data }), error => ({ ok: false, code: error.code }));
	else if (kind === 'rpc') handleRpc(ws, toArrayBuffer({ rpc: 'reload/read', id: 'reload' }), platform);
	else if (kind === 'binary') {
		const header = new TextEncoder().encode(JSON.stringify({ rpc: 'reload/read', id: 'reload', args: [] }));
		const frame = new Uint8Array(3 + header.length);
		new DataView(frame.buffer).setUint16(1, header.length);
		frame.set(header, 3);
		handleRpc(ws, frame.buffer, platform);
	} else {
		const header = new TextEncoder().encode(JSON.stringify({ rpc: 'reload/read', args: [] }));
		const frame = new Uint8Array(12 + header.length);
		frame[0] = 1; frame[1] = 3;
		const view = new DataView(frame.buffer);
		view.setUint32(2, 1); view.setUint32(6, 0); view.setUint16(10, header.length);
		frame.set(header, 12);
		handleRpc(ws, frame.buffer, platform);
	}
	await expect.poll(() => pending.started.value).toBe(true);
	_prepareHmr();
	__register('reload/read', live(() => 'new public value'));
	pending.finish(() => { throw new Error('denied'); });
	let answer;
	if (kind === 'direct') answer = await call;
	else {
		await expect.poll(() => platform.sent.find(entry => entry.data?.ok !== undefined)?.data).toBeTruthy();
		answer = platform.sent.find(entry => entry.data?.ok !== undefined).data;
	}
	expect(answer.ok).toBe(false);
	expect(['FORBIDDEN', 'UNAVAILABLE']).toContain(answer.code);
	expect(executions).toBe(0);
});

it.each(['direct', 'rpc'])('an old %s body cannot start after an already-resolved asynchronous guard allows', async kind => {
	let finish;
	let started = false;
	let executions = 0;
	__register('reload/read', live(() => { executions++; return 'old private value'; }));
	__registerGuard('reload', async () => { started = true; await new Promise(resolve => { finish = resolve; }); });
	const platform = mockPlatform();
	const ws = mockWs({ id: 'test' });
	const call = kind === 'direct' ? __directCall('reload/read', [], platform, context).catch(error => error) : null;
	if (kind === 'rpc') handleRpc(ws, toArrayBuffer({ rpc: 'reload/read', id: 'reload' }), platform);
	await expect.poll(() => started).toBe(true);
	_prepareHmr();
	__register('reload/read', live(() => 'new public value'));
	finish();
	if (kind === 'direct') expect(await call).toMatchObject({ code: 'UNAVAILABLE' });
	else {
		await expect.poll(() => platform.sent.find(entry => entry.event === 'reload')?.data).toBeTruthy();
		expect(platform.sent.find(entry => entry.event === 'reload').data).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
	}
	expect(executions).toBe(0);
});

it.each([false, true])('a rollback restores pending effects including an active import (active: %s)', async active => {
	let loads = 0;
	const pending = delayed();
	const original = active ? pending.loader : Object.assign(async () => { loads++; return live.effect(['reload:source'], () => {}); }, { __lazy: true });
	__registerEffect('reload/original', original);
	let loading;
	if (active) {
		loading = _resolveAllLazy();
		await expect.poll(() => pending.started.value).toBe(true);
	}
	const previous = _prepareHmr();
	__registerEffect('reload/replacement', Object.assign(async () => live.effect(['reload:source'], () => {}), { __lazy: true }));
	_restoreHmr(previous);
	const restored = _resolveAllLazy();
	if (active) pending.finish(live.effect(['reload:source'], () => {}));
	await Promise.all([loading, restored]);
	expect(effectRegistry.has('reload/original')).toBe(true);
	expect(effectRegistry.has('reload/replacement')).toBe(false);
	if (!active) expect(loads).toBe(1);
	else expect(pending.started.calls).toBe(1);
});

it('a restored pending cron declaration fires without an RPC to load it', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
	const platform = mockPlatform();
	try {
		setCronPlatform(platform);
		__registerCron('reload/job', Object.assign(async () => live.cron('* * * * *', 'reload:tick', () => 'fired'), { __lazy: true }));
		const previous = _prepareHmr();
		_restoreHmr(previous);
		await vi.advanceTimersByTimeAsync(60000);
		expect(platform.published.some(frame => frame.topic === 'reload:tick' && frame.data === 'fired')).toBe(true);
	} finally {
		_prepareHmr();
		vi.useRealTimers();
	}
});

it.each(['guard', 'gate', 'filter', 'subscribe'])('a stream paused at %s cannot attach or run an old subscribe hook after reload', async phase => {
	let finish;
	let started = false;
	let joins = 0;
	const pause = async () => { started = true; await new Promise(resolve => { finish = resolve; }); return true; };
	const platform = mockPlatform();
	const ws = mockWs({ id: 'test' });
	let stream = live.stream('reload:private', () => 'private snapshot', { merge: 'set', onSubscribe(ctx) { joins++; ctx.publish('reload:private', 'set', 'private hook value'); } });
	if (phase === 'guard') __registerGuard('reload', pause);
	if (phase === 'gate') stream = live.gate(pause, stream);
	if (phase === 'filter') stream.__streamFilter = pause;
	if (phase === 'subscribe') platform.subscribe = async (socket, topic) => { await pause(); socket.subscribe(topic); return null; };
	__register('reload/view', stream);
	handleRpc(ws, toArrayBuffer({ rpc: 'reload/view', id: 'view', stream: true, attach: true }), platform);
	await expect.poll(() => started).toBe(true);
	_prepareHmr();
	__register('reload/view', live.stream('reload:public', () => 'new value', { merge: 'set' }));
	__registerGuard('reload', () => { throw new Error('denied'); });
	finish();
	await expect.poll(() => platform.sent.find(entry => entry.data?.ok !== undefined)?.data).toBeTruthy();
	expect(platform.sent.find(entry => entry.data?.ok !== undefined).data).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
	expect(joins).toBe(0);
	expect(platform.published).toHaveLength(0);
	expect(platform.sent.some(entry => entry.data?.attach)).toBe(false);
	expect(ws.isSubscribed('reload:private')).toBe(false);
});

it('a reload during a successful-subscribe hook cannot return an old snapshot', async () => {
	let started = false, finish;
	const platform = mockPlatform();
	const ws = mockWs({ id: 'test' });
	const stream = live.stream('reload:private', () => 'private snapshot', { merge: 'set' });
	stream.__onSubscribeSuccess = async () => { started = true; await new Promise(resolve => { finish = resolve; }); };
	__register('reload/view', stream);
	handleRpc(ws, toArrayBuffer({ rpc: 'reload/view', id: 'view', stream: true }), platform);
	await expect.poll(() => started).toBe(true);
	_prepareHmr();
	__register('reload/view', live.stream('reload:public', () => 'new value', { merge: 'set' }));
	finish();
	await expect.poll(() => platform.sent.find(entry => entry.data?.ok !== undefined)?.data).toBeTruthy();
	expect(platform.sent.find(entry => entry.data?.ok !== undefined).data).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
	expect(JSON.stringify(platform.sent)).not.toContain('private snapshot');
	expect(ws.isSubscribed('reload:private')).toBe(false);
});

it.each([false, true])('a batch cannot send an older completed result while waiting for a sibling (sequential: %s)', async sequential => {
	let started = false, finish;
	const platform = mockPlatform();
	const ws = mockWs({ id: 'test' });
	__register('reload/fast', live(() => 'private snapshot'));
	__register('reload/slow', live(async () => { started = true; await new Promise(resolve => { finish = resolve; }); return 'slow value'; }));
	handleRpc(ws, toArrayBuffer({ batch: [{ rpc: 'reload/fast', id: 'fast' }, { rpc: 'reload/slow', id: 'slow' }], sequential }), platform);
	await expect.poll(() => started).toBe(true);
	await new Promise(resolve => setImmediate(resolve));
	_prepareHmr();
	__register('reload/fast', live(() => 'new public value'));
	finish();
	await expect.poll(() => platform.sent.find(entry => entry.data?.batch)?.data).toBeTruthy();
	const answer = platform.sent.find(entry => entry.data?.batch).data;
	expect(answer.batch.find(result => result.id === 'fast')).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
	expect(JSON.stringify(answer)).not.toContain('private snapshot');
});

it.each([false, true])('a batch releases a completed stream when reload rejects its result (sequential: %s)', async sequential => {
	let started = false, finish, loaded = false;
	const onUnsubscribe = vi.fn();
	const onSubscribeSuccess = vi.fn();
	const onUnsubscribePublic = vi.fn();
	const platform = mockPlatform();
	const ws = mockWs({ id: 'test' });
	const stream = live.stream('reload:private', () => { loaded = true; return 'private snapshot'; }, { onUnsubscribe });
	stream.__onSubscribeSuccess = onSubscribeSuccess;
	stream.__onUnsubscribePublic = onUnsubscribePublic;
	__register('reload/fast', stream);
	__register('reload/slow', live(async () => { started = true; await new Promise(resolve => { finish = resolve; }); return 'slow value'; }));
	handleRpc(ws, toArrayBuffer({ batch: [{ rpc: 'reload/fast', id: 'fast', stream: true }, { rpc: 'reload/slow', id: 'slow' }], sequential }), platform);
	await expect.poll(() => started && loaded).toBe(true);
	await new Promise(resolve => setImmediate(resolve));
	expect(ws.isSubscribed('reload:private')).toBe(true);
	expect(onSubscribeSuccess).toHaveBeenCalledTimes(1);
	_prepareHmr();
	__register('reload/fast', live.stream('reload:public', () => 'public snapshot'));
	__registerGuard('reload', () => { throw new Error('denied'); });
	finish();
	await expect.poll(() => platform.sent.find(entry => entry.data?.batch)?.data).toBeTruthy();
	const answer = platform.sent.find(entry => entry.data?.batch).data;
	expect(answer.batch.find(result => result.id === 'fast')).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
	expect(JSON.stringify(answer)).not.toContain('private snapshot');
	expect(ws.isSubscribed('reload:private')).toBe(false);
	await expect.poll(() => onUnsubscribe.mock.calls.length).toBe(1);
	expect(onUnsubscribe).toHaveBeenCalledWith(expect.anything(), 'reload:private', 0);
	await expect.poll(() => onUnsubscribePublic.mock.calls.length).toBe(1);
});

it.each(['same handler', 'new handler'])('a rejected batch stream preserves an accepted %s on the same topic', async overlap => {
	let started = false, finish, loads = 0;
	const onUnsubscribe = vi.fn();
	const onUnsubscribePublic = vi.fn();
	const acceptedUnsubscribe = vi.fn();
	const platform = mockPlatform();
	const ws = mockWs({ id: 'test' });
	const stream = live.stream('reload:shared', () => { loads++; return 'private snapshot'; }, { onUnsubscribe });
	stream.__onSubscribeSuccess = () => {};
	stream.__onUnsubscribePublic = onUnsubscribePublic;
	__register('reload/fast', stream);
	__register('reload/slow', live(async () => { started = true; await new Promise(resolve => { finish = resolve; }); return 'slow value'; }));
	if (overlap === 'same handler') {
		handleRpc(ws, toArrayBuffer({ rpc: 'reload/fast', id: 'accepted', stream: true }), platform);
		await expect.poll(() => platform.sent.find(entry => entry.event === 'accepted')?.data.ok).toBe(true);
	}
	handleRpc(ws, toArrayBuffer({ batch: [{ rpc: 'reload/fast', id: 'fast', stream: true }, { rpc: 'reload/slow', id: 'slow' }] }), platform);
	await expect.poll(() => started && loads === (overlap === 'same handler' ? 2 : 1)).toBe(true);
	await new Promise(resolve => setImmediate(resolve));
	_prepareHmr();
	__registerGuard('reload', () => { throw new Error('denied'); });
	if (overlap === 'new handler') {
		__register('public/accepted', live.stream('reload:shared', () => 'accepted snapshot', { onUnsubscribe: acceptedUnsubscribe }));
		handleRpc(ws, toArrayBuffer({ rpc: 'public/accepted', id: 'accepted', stream: true }), platform);
		await expect.poll(() => platform.sent.find(entry => entry.event === 'accepted')?.data.ok).toBe(true);
	}
	finish();
	await expect.poll(() => platform.sent.find(entry => entry.data?.batch)?.data).toBeTruthy();
	expect(platform.sent.find(entry => entry.data?.batch).data.batch.find(result => result.id === 'fast')).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
	await expect.poll(() => onUnsubscribe.mock.calls.length).toBe(1);
	await new Promise(resolve => setImmediate(resolve));
	expect(onUnsubscribePublic).toHaveBeenCalledTimes(overlap === 'same handler' ? 0 : 1);
	expect(acceptedUnsubscribe).not.toHaveBeenCalled();
	expect(ws.isSubscribed('reload:shared')).toBe(true);
});

it.each([false, true])('a native rejected batch stream releases only its own membership (accepted overlap: %s)', async overlap => {
	const { createTestServer, WS_SUBSCRIPTIONS } = await import('svelte-adapter-uws/testing');
	_resetLifecycle();
	let started = false, finish, loaded = false, serverSocket, server, socket;
	const frames = [];
	const onUnsubscribe = vi.fn();
	const acceptedUnsubscribe = vi.fn();
	const topic = 'reload:native-private';
	__register('reload/fast', live.stream(topic, ctx => { serverSocket = ctx.ws; loaded = true; return 'private snapshot'; }, { onUnsubscribe }));
	__register('reload/slow', live(async () => { started = true; await new Promise(resolve => { finish = resolve; }); return 'slow value'; }));
	try {
		server = await createTestServer({ handler: realtime() });
		socket = new WebSocket(server.wsUrl);
		socket.addEventListener('message', ({ data }) => { if (typeof data === 'string') frames.push(JSON.parse(data)); });
		await new Promise((resolve, reject) => {
			socket.addEventListener('open', resolve, { once: true });
			socket.addEventListener('error', reject, { once: true });
		});
		socket.send(JSON.stringify({ batch: [{ rpc: 'reload/fast', id: 'fast', stream: true }, { rpc: 'reload/slow', id: 'slow' }] }));
		await expect.poll(() => started && loaded).toBe(true);
		await new Promise(resolve => setImmediate(resolve));
		_prepareHmr();
		__registerGuard('reload', () => { throw new Error('denied'); });
		if (overlap) {
			__register('public/accepted', live.stream(topic, () => 'accepted snapshot', { onUnsubscribe: acceptedUnsubscribe }));
			socket.send(JSON.stringify({ rpc: 'public/accepted', id: 'accepted', stream: true }));
			await expect.poll(() => frames.find(frame => frame.event === 'accepted')?.data.ok).toBe(true);
		}
		finish();
		await expect.poll(() => frames.find(frame => frame.data?.batch)?.data).toBeTruthy();
		const answer = frames.find(frame => frame.data?.batch).data;
		expect(answer.batch.find(result => result.id === 'fast')).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
		expect(JSON.stringify(answer)).not.toContain('private snapshot');
		expect(serverSocket.isSubscribed(topic)).toBe(overlap);
		expect(serverSocket.getUserData()[WS_SUBSCRIPTIONS].has(topic)).toBe(overlap);
		expect(server.platform.subscribers(topic)).toBe(overlap ? 1 : 0);
		await expect.poll(() => onUnsubscribe.mock.calls.length).toBe(1);
		expect(acceptedUnsubscribe).not.toHaveBeenCalled();
		if (overlap) {
			server.platform.publish(topic, 'set', 'surviving delivery');
			await expect.poll(() => frames.find(frame => frame.topic === topic)?.data).toBe('surviving delivery');
		}
	} finally {
		finish?.();
		socket?.close();
		await server?.close();
		_resetLifecycle();
	}
});

it.each(['direct', 'rpc', 'upload'])('an old deferred %s waiter drains the current generation before its first publish', async kind => {
	const pending = delayed();
	let effects = 0;
	const platform = mockPlatform();
	const ws = mockWs({ id: 'test' });
	__registerEffect('reload/old', pending.loader);
	_activateDerived(platform);
	let call;
	if (kind === 'direct') call = __directCall('reload/fire', [], platform, context);
	else if (kind === 'rpc') handleRpc(ws, toArrayBuffer({ rpc: 'reload/fire', id: 'fire' }), platform);
	else {
		const header = new TextEncoder().encode(JSON.stringify({ rpc: 'reload/fire', args: [] }));
		const frame = new Uint8Array(12 + header.length);
		frame[0] = 1; frame[1] = 3;
		const view = new DataView(frame.buffer);
		view.setUint32(2, 1); view.setUint16(10, header.length); frame.set(header, 12);
		handleRpc(ws, frame.buffer, platform);
	}
	await expect.poll(() => pending.started.value).toBe(true);
	_prepareHmr();
	__registerEffect('reload/current', Object.assign(async () => live.effect(['reload:source'], () => { effects++; }), { __lazy: true }));
	const fire = ctx => { ctx.publish('reload:source', 'created', {}); return 'sent'; };
	__register('reload/fire', kind === 'upload' ? live.upload(fire) : live(fire));
	_activateDerived(platform);
	pending.finish(live.effect(['reload:old-source'], () => {}));
	if (kind === 'direct') expect(await call).toBe('sent');
	else await expect.poll(() => platform.sent.find(entry => entry.data?.ok === true)?.data.data).toBe('sent');
	await expect.poll(() => effects).toBe(1);
});
