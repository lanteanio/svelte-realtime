import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { writable } from 'svelte/store';

let current, moduleStatus, client, connections;
function connection(state = 'open') {
	const topics = new Map();
	const conn = {
		status: writable(state), failure: writable(null), denials: writable(null),
		send: vi.fn(() => true), sendQueued: vi.fn(() => true),
		on(topic) { if (!topics.has(topic)) topics.set(topic, writable(null)); return topics.get(topic); },
		onRequest: vi.fn(() => () => {}),
		emit(topic, value) { topics.get(topic)?.set(value); }
	};
	connections.push(conn); return conn;
}
function status(value) { moduleStatus.set(value); current.status.set(value); }
function replace() { current = connection('connecting'); status('connecting'); status('open'); return current; }
function answer(conn, request, data = 'ok') { conn.emit('__rpc', { event: request.id, data: { ok: true, data } }); }
const frames = (conn) => [...conn.send.mock.calls, ...conn.sendQueued.mock.calls].map(([f]) => f);
const tick = () => new Promise(resolve => queueMicrotask(resolve));

// One file-level mock that reads the current test's state on every access:
// per-test doMock/doUnmock pairs can race and load the real adapter.
vi.mock('svelte-adapter-uws/client', () => ({
	connect: () => current, status: { subscribe: fn => moduleStatus.subscribe(fn) },
	failure: { subscribe: fn => current.failure.subscribe(fn) }, denials: { subscribe: fn => current.denials.subscribe(fn) },
	setTopicManaged: () => {}, on: topic => current.on(topic), onRequest: fn => current.onRequest(fn)
}));

beforeEach(async () => {
	vi.resetModules(); connections = []; current = connection(); moduleStatus = writable('open');
	client = await import('../src/client.js');
});
afterEach(() => { status('failed'); });

describe('following connection replacement', () => {
	it('rebinds RPC listeners, rejects old work, and ignores stale responses', async () => {
		const old = current;
		const request = client.__rpc('old/request')(); request.catch(() => {});
		status('failed'); await expect(request).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		await expect(client.__rpc('closed/request')()).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		expect(connections).toHaveLength(1);
		const next = replace(); const fresh = client.__rpc('new/request')();
		const frame = next.send.mock.calls.at(-1)[0]; let settled = false;
		fresh.then(() => { settled = true; });
		answer(old, frame, 'stale'); await tick(); expect(settled).toBe(false);
		answer(next, frame, 'fresh'); await expect(fresh).resolves.toBe('fresh');
	});

	it('reloads mounted streams and follows replacement denials', async () => {
		const stream = client.__stream('items/list', { merge: 'set' });
		let value, error;
		const offError = stream.error.subscribe(v => { error = v; });
		const off = stream.subscribe(v => { value = v; });
		await expect.poll(() => frames(current).find(f => f.rpc === 'items/list')).toBeTruthy();
		const initial = frames(current).find(f => f.rpc === 'items/list');
		current.emit('__rpc', { event: initial.id, data: { ok: true, data: [1], topic: 'items', merge: 'set' } });
		await tick(); expect(value).toEqual([1]);
		const old = current; status('failed'); expect(error.code).toBe('CONNECTION_CLOSED');
		const next = replace();
		await expect.poll(() => frames(next).find(f => f.rpc === 'items/list')).toBeTruthy();
		const request = frames(next).find(f => f.rpc === 'items/list');
		next.emit('__rpc', { event: request.id, data: { ok: true, data: [2], topic: 'items', merge: 'set' } });
		await tick(); expect(value).toEqual([2]); expect(error).toBeNull();
		old.denials.set({ topic: 'items', reason: 'FORBIDDEN' }); expect(error).toBeNull();
		next.denials.set({ topic: 'items', reason: 'FORBIDDEN' }); expect(error.code).toBe('FORBIDDEN');
		off(); offError();
	});

	it('leaves rejected offline work rejected on explicit replacement', async () => {
		client.configure({ offline: { queue: true } }); status('disconnected');
		const queued = client.__rpc('old/offline')(); queued.catch(() => {});
		status('failed'); await expect(queued).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		const next = replace(); await tick(); await tick();
		expect(frames(next).filter(f => f.rpc !== undefined)).toEqual([]);
	});

	it('keeps durable entries retained at close out of the replacement drain', async () => {
		client.configure({ offline: { queue: true } });
		const { _offlineQueue } = await import('../src/client/internal-state.js');
		const entry = { path: 'stored/old', args: [], queuedAt: 1, stored: Promise.resolve(true), resolve: vi.fn(), reject: vi.fn() };
		_offlineQueue.push(entry);
		status('failed'); const next = replace(); await tick(); await tick();
		expect(frames(next).filter(f => f.rpc !== undefined)).toEqual([]); expect(_offlineQueue).toContain(entry);
		expect(entry.reject).not.toHaveBeenCalled();
	});

	it('does not revive a drain cut off by close and immediate replacement', async () => {
		client.configure({ offline: { queue: true } }); status('disconnected');
		const first = client.__rpc('queue/first')(); first.catch(() => {});
		const second = client.__rpc('queue/second')(); second.catch(() => {});
		status('open');
		await expect.poll(() => current.send.mock.calls.length).toBeGreaterThan(0);
		status('failed'); const next = replace();
		await expect(first).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		await expect(second).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		expect(frames(next).filter(f => f.rpc !== undefined)).toEqual([]);
	});

	it('does not revive a drain when the close is only seen through the replacement', async () => {
		client.configure({ offline: { queue: true } }); status('disconnected');
		const first = client.__rpc('queue/first')(); first.catch(() => {});
		const second = client.__rpc('queue/second')(); second.catch(() => {});
		status('open');
		await expect.poll(() => current.send.mock.calls.length).toBeGreaterThan(0);
		// The old connection closes, and the module status moves straight on to
		// the replacement without ever reporting 'failed'.
		current.status.set('failed'); const next = replace();
		await expect(first).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		await expect(second).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
		await tick(); await tick();
		expect(frames(next).filter(f => f.rpc !== undefined)).toEqual([]);
	});
});
