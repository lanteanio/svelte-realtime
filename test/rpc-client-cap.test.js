import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A minimal adapter client: records sent frames and lets the test answer them
// on the `__rpc` topic.
const H = vi.hoisted(() => ({ sent: [], listeners: new Map(), status: 'open' }));
vi.mock('svelte-adapter-uws/client', () => {
	const on = (topic) => ({
		subscribe(fn) {
			let set = H.listeners.get(topic);
			if (!set) { set = new Set(); H.listeners.set(topic, set); }
			set.add(fn);
			return () => set.delete(fn);
		}
	});
	const status = { subscribe(fn) { fn(H.status); return () => {}; } };
	const store = { subscribe(fn) { fn(null); return () => {}; } };
	const conn = { on, status, failure: store, denials: store, send: (frame) => { H.sent.push(frame); }, sendQueued: (frame) => { H.sent.push(frame); }, bufferedAmount: 0 };
	return { on, status, failure: store, denials: store, connect: () => conn, setTopicManaged: () => {} };
});

let client;
beforeEach(async () => {
	vi.resetModules();
	H.sent.length = 0;
	H.listeners.clear();
	client = await import('../src/client.js');
});
afterEach(() => {
	vi.useRealTimers();
});

function answer(id, payload) {
	for (const fn of H.listeners.get('__rpc') || []) fn({ event: id, data: payload });
}

describe('rpc.maxPending', () => {
	it('rejects the call past 256 awaiting a response at once, without sending it', async () => {
		const call = client.__rpc('cap/slow');
		const calls = [];
		for (let i = 0; i < 256; i++) calls.push(call.fresh(i));
		expect(H.sent).toHaveLength(256);
		const over = call.fresh(256);
		let error;
		over.catch((err) => { error = err; });
		await Promise.resolve();
		await Promise.resolve();
		expect(error).toBeInstanceOf(client.RpcError);
		expect(error).toMatchObject({ code: 'OVERLOADED', reason: 'concurrency_limit', scope: 'client' });
		expect(H.sent).toHaveLength(256);

		// An answer frees a place for the next call.
		answer(H.sent[0].id, { ok: true, data: 'first' });
		await expect(calls[0]).resolves.toBe('first');
		const next = call.fresh(257);
		expect(H.sent).toHaveLength(257);
		answer(H.sent[256].id, { ok: true, data: 'next' });
		await expect(next).resolves.toBe('next');
		for (let i = 1; i < 256; i++) answer(H.sent[i].id, { ok: true, data: i });
		await Promise.all(calls);
	});

	it('frees a place when a call times out', async () => {
		vi.useFakeTimers();
		client.configure({ rpc: { maxPending: 2 }, timeout: 1000 });
		const call = client.__rpc('cap/timeout');
		const a = call.fresh(1);
		const b = call.fresh(2);
		a.catch(() => {});
		b.catch(() => {});
		await expect(call.fresh(3)).rejects.toMatchObject({ code: 'OVERLOADED', scope: 'client' });
		await vi.advanceTimersByTimeAsync(1001);
		await expect(a).rejects.toMatchObject({ code: 'TIMEOUT' });
		const c = call.fresh(4);
		expect(H.sent.at(-1).args).toEqual([4]);
		answer(H.sent.at(-1).id, { ok: true, data: 4 });
		await expect(c).resolves.toBe(4);
	});

	it('counts binary calls and leaves stream subscribes out', async () => {
		client.configure({ rpc: { maxPending: 1 } });
		const store = client.__stream('cap/feed', { merge: 'crud', key: 'id' });
		const unsubscribe = store.subscribe(() => {});
		await Promise.resolve();
		const upload = client.__binaryRpc('cap/bin');
		const first = upload(new Uint8Array([1]).buffer);
		first.catch(() => {});
		// The open subscribe does not count: the binary call went out.
		expect(H.sent.filter((frame) => frame instanceof ArrayBuffer)).toHaveLength(1);
		await expect(client.__rpc('cap/x')()).rejects.toMatchObject({ code: 'OVERLOADED', scope: 'client' });
		await expect(upload(new Uint8Array([2]).buffer)).rejects.toMatchObject({ code: 'OVERLOADED', scope: 'client' });
		unsubscribe();
	});

	it('0 disables the cap', async () => {
		client.configure({ rpc: { maxPending: 0 } });
		const call = client.__rpc('cap/open');
		for (let i = 0; i < 300; i++) call.fresh(i).catch(() => {});
		expect(H.sent).toHaveLength(300);
	});

	it('validates the option', () => {
		expect(() => client.configure({ rpc: { maxPending: -1 } })).toThrow(/rpc\.maxPending/);
		expect(() => client.configure({ rpc: { maxPending: 1.5 } })).toThrow(/rpc\.maxPending/);
		expect(() => client.configure({ rpc: { maxPending: Infinity } })).toThrow(/rpc\.maxPending/);
		expect(() => client.configure({ rpc: null })).toThrow(/configure\(\{ rpc \}\)/);
	});
});

describe('a server admission refusal', () => {
	it('surfaces as RpcError OVERLOADED carrying reason and scope', async () => {
		const promise = client.__rpc('cap/refused')();
		answer(H.sent[0].id, { ok: false, code: 'OVERLOADED', error: 'The call queue is full', reason: 'queue_full', scope: 'global' });
		await expect(promise).rejects.toMatchObject({ code: 'OVERLOADED', reason: 'queue_full', scope: 'global', message: 'The call queue is full' });
	});

	it('ignores reason and scope values it does not know', async () => {
		const promise = client.__rpc('cap/odd')();
		answer(H.sent[0].id, { ok: false, code: 'OVERLOADED', error: 'x', reason: 'rate_limit', scope: 'tenant' });
		const err = await promise.catch((e) => e);
		expect(err.code).toBe('OVERLOADED');
		expect('reason' in err).toBe(false);
		expect('scope' in err).toBe(false);
	});
});
