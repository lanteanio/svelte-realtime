import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';

let server, ws, platform;
const gates = [];
function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	const gate = { promise, resolve, reject };
	gates.push(gate);
	return gate;
}
function chunk(seq, size, last = false) {
	const header = seq === 0 ? new TextEncoder().encode(JSON.stringify({ rpc: 'upload/file', args: [] })) : null;
	const offset = header ? 12 + header.length : 10;
	const bytes = new Uint8Array(offset + size);
	const view = new DataView(bytes.buffer);
	bytes[0] = 1;
	bytes[1] = (header ? 1 : 0) | (last ? 2 : 0);
	view.setUint32(2, 1);
	view.setUint32(6, seq);
	if (header) { view.setUint16(10, header.length); bytes.set(header, 12); }
	return bytes.buffer;
}
function cancel() {
	const bytes = new Uint8Array(6);
	bytes[0] = 2; bytes[1] = 16;
	new DataView(bytes.buffer).setUint32(2, 1);
	return bytes.buffer;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const responses = () => platform.sent.filter(frame => frame.topic === '__upload' && typeof frame.data.ok === 'boolean');
beforeEach(async () => {
	vi.resetModules();
	server = await import('../src/server.js');
	ws = mockWs({ id: 'member' });
	platform = mockPlatform();
});
afterEach(async () => {
	for (const gate of gates.splice(0)) gate.resolve();
	server.close(ws, { platform });
	await flush();
	vi.restoreAllMocks();
});

it.each([false, true])('holds EOF and completion until the final required guard settles (allow=%s)', async allow => {
	const guard = deferred(), started = deferred();
	let checks = 0, eof = false, committed = 0, context;
	server.__registerGuard('upload', server.guard(() => ++checks === 1 ? undefined : guard.promise));
	server.__register('upload/file', server.live.upload(async ctx => {
		context = ctx;
		started.resolve();
		let bytes = 0;
		for await (const value of ctx.stream) bytes += value.byteLength;
		eof = true;
		committed++;
		return bytes;
	}, { reauthEvery: 1 }));
	server.handleRpc(ws, chunk(0, 0), platform);
	await started.promise;
	server.handleRpc(ws, chunk(1, 1, true), platform);
	await flush();
	expect(checks).toBe(2);
	expect(eof).toBe(false);
	expect(committed).toBe(0);
	expect(responses()).toHaveLength(0);
	if (allow) guard.resolve();
	else guard.reject(new server.LiveError('FORBIDDEN', 'Upload permission changed'));
	await vi.waitFor(() => expect(responses()).toHaveLength(1));
	expect(responses()[0].data).toMatchObject(allow ? { ok: true, data: 1 } : { ok: false, code: 'FORBIDDEN' });
	expect(committed).toBe(allow ? 1 : 0);
	expect(context.abortSignal.aborted).toBe(!allow);
});

it('does not report an early-returning handler as successful while a required guard is pending', async () => {
	const guard = deferred(), started = deferred(), returned = deferred();
	let checks = 0;
	server.__registerGuard('upload', server.guard(() => ++checks === 1 ? undefined : guard.promise));
	server.__register('upload/file', server.live.upload(async () => {
		started.resolve();
		await returned.promise;
		return 'finished';
	}, { reauthEvery: 1 }));
	server.handleRpc(ws, chunk(0, 0), platform);
	await started.promise;
	server.handleRpc(ws, chunk(1, 1, true), platform);
	returned.resolve();
	await flush();
	expect(checks).toBe(2);
	expect(responses()).toHaveLength(0);
	guard.reject(new server.LiveError('FORBIDDEN', 'Upload permission changed'));
	await vi.waitFor(() => expect(responses()).toHaveLength(1));
	expect(responses()[0].data).toMatchObject({ ok: false, code: 'FORBIDDEN' });
});

it.each(['cancel', 'disconnect'])('late guard approval cannot finish an upload after %s', async action => {
	const guard = deferred(), started = deferred();
	let checks = 0, committed = 0;
	server.__registerGuard('upload', server.guard(() => ++checks === 1 ? undefined : guard.promise));
	server.__register('upload/file', server.live.upload(async ctx => {
		started.resolve();
		for await (const value of ctx.stream) {}
		committed++;
		return 'finished';
	}, { reauthEvery: 1, maxConcurrentPerSession: 1 }));
	server.handleRpc(ws, chunk(0, 0), platform);
	await started.promise;
	server.handleRpc(ws, chunk(1, 1, true), platform);
	if (action === 'cancel') server.handleRpc(ws, cancel(), platform);
	else server.close(ws, { platform });
	guard.resolve();
	await flush(); await flush();
	expect(committed).toBe(0);
	expect(responses().some(frame => frame.data.ok)).toBe(false);
	if (action === 'cancel') {
		expect(responses()).toHaveLength(1);
		expect(responses()[0].data.code).toBe('CANCELLED');
	}
	// The settled old guard releases its one admission slot for a new upload.
	if (action === 'disconnect') ws = mockWs({ id: 'member' });
	server.handleRpc(ws, chunk(0, 2, true), platform);
	await vi.waitFor(() => expect(responses().filter(frame => frame.data.ok)).toHaveLength(1));
	expect(committed).toBe(1);
});

it('completion also waits for a check started while an earlier check settles', async () => {
	const first = deferred(), second = deferred(), started = deferred(), returned = deferred();
	let checks = 0;
	server.__registerGuard('upload', server.guard(() => {
		checks++;
		return checks === 1 ? undefined : checks === 2 ? first.promise : second.promise;
	}));
	server.__register('upload/file', server.live.upload(async () => {
		started.resolve();
		await returned.promise;
		return 'finished';
	}, { reauthEvery: 1 }));
	server.handleRpc(ws, chunk(0, 0), platform);
	await started.promise;
	server.handleRpc(ws, chunk(1, 1), platform);
	returned.resolve();
	await flush();
	first.promise.then(() => queueMicrotask(() => server.handleRpc(ws, chunk(2, 1, true), platform)));
	first.resolve();
	await flush();
	expect(checks).toBe(3);
	expect(responses()).toHaveLength(0);
	second.reject(new server.LiveError('FORBIDDEN', 'Upload permission changed'));
	await vi.waitFor(() => expect(responses()).toHaveLength(1));
	expect(responses()[0].data).toMatchObject({ ok: false, code: 'FORBIDDEN' });
});

it.each(['cancel', 'disconnect'])('retains admission for pending guard work after %s', async action => {
	const guard = deferred(), started = deferred();
	let checks = 0, handlers = 0;
	server.__registerGuard('upload', server.guard(() => ++checks === 2 ? guard.promise : undefined));
	server.__register('upload/file', server.live.upload(async ctx => {
		handlers++;
		started.resolve();
		let size = 0;
		for await (const value of ctx.stream) size += value.byteLength;
		return size;
	}, { reauthEvery: 1, maxConcurrentPerSession: 1, maxConcurrentPerUser: 1, maxConcurrentTotal: 1 }));
	server.handleRpc(ws, chunk(0, 0), platform);
	await started.promise;
	server.handleRpc(ws, chunk(1, 1, true), platform);
	if (action === 'cancel') server.handleRpc(ws, cancel(), platform);
	else { server.close(ws, { platform }); ws = mockWs({ id: 'member' }); }
	await flush(); await flush();
	server.handleRpc(ws, chunk(0, 0), platform);
	await flush(); await flush();
	expect(handlers).toBe(1);
	expect(responses().some(frame => frame.data.code === 'TOO_MANY_UPLOADS')).toBe(true);
	guard.resolve();
	await flush(); await flush();
	server.handleRpc(ws, chunk(0, 2, true), platform);
	await vi.waitFor(() => expect(responses().filter(frame => frame.data.ok)).toHaveLength(1));
	expect(handlers).toBe(2);
	expect(responses().find(frame => frame.data.ok).data.data).toBe(2);
});

it.each(['pending', 'running'])('refuses a chunk after LAST while authorization is %s', async phase => {
	const guard = deferred(), entered = deferred(), started = deferred();
	let checks = 0, handlers = 0, committed = 0;
	server.__registerGuard('upload', server.guard(() => {
		checks++;
		if (checks === (phase === 'pending' ? 1 : 2)) { entered.resolve(); return guard.promise; }
	}));
	server.__register('upload/file', server.live.upload(async ctx => {
		handlers++;
		started.resolve();
		for await (const value of ctx.stream) {}
		committed++;
		return 'finished';
	}, { reauthEvery: 1 }));
	server.handleRpc(ws, chunk(0, 0, phase === 'pending'), platform);
	if (phase === 'running') {
		await started.promise;
		server.handleRpc(ws, chunk(1, 1, true), platform);
	}
	await entered.promise;
	server.handleRpc(ws, chunk(phase === 'pending' ? 1 : 2, 1), platform);
	await flush();
	expect(responses()).toHaveLength(1);
	expect(responses()[0].data).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
	guard.resolve();
	await flush(); await flush();
	expect(committed).toBe(0);
	expect(handlers).toBe(phase === 'pending' ? 0 : 1);
	expect(responses()).toHaveLength(1);
});

it.each(['cancel', 'disconnect'])('discards unread ended input immediately after %s', async action => {
	const paused = deferred(), started = deferred();
	let handlers = 0, oldConsumed = 0, oldFailure;
	server.__register('upload/file', server.live.upload(async ctx => {
		const old = ++handlers === 1;
		if (old) { started.resolve(); await paused.promise; }
		let size = 0;
		try {
			for await (const value of ctx.stream) {
				size += value.byteLength;
				if (old) oldConsumed += value.byteLength;
			}
			return size;
		} catch (error) { if (old) oldFailure = error; throw error; }
	}, { maxBufferedBytesTotal: 1, maxConcurrentPerSession: 2, maxConcurrentPerUser: 2, maxConcurrentTotal: 2 }));
	server.handleRpc(ws, chunk(0, 1, true), platform);
	await started.promise;
	if (action === 'cancel') server.handleRpc(ws, cancel(), platform);
	else { server.close(ws, { platform }); ws = mockWs({ id: 'member' }); }
	server.handleRpc(ws, chunk(0, 1, true), platform);
	await vi.waitFor(() => expect(responses().filter(frame => frame.data.ok)).toHaveLength(1));
	expect(responses().find(frame => frame.data.ok).data.data).toBe(1);
	paused.resolve();
	await vi.waitFor(() => expect(oldFailure).toBeDefined());
	expect(oldFailure.code).toBe(action === 'cancel' ? 'CANCELLED' : 'DISCONNECTED');
	expect(oldConsumed).toBe(0);
});
