import { describe, it, expect, vi, afterEach } from 'vitest';

// mutate() over Svelte's real writable. Svelte runs every store's subscribers
// through one module-wide queue, and a subscriber that throws leaves that
// queue undrained, so no store in the page notifies again. This file keeps
// that state to itself: it is never cleared once reached.

const wire = vi.hoisted(() => ({ adapter: null }));
vi.mock('svelte-adapter-uws/client', () => ({
	connect: (...args) => wire.adapter.connect(...args),
	on: (...args) => wire.adapter.on(...args),
	status: { subscribe: (...args) => wire.adapter.status.subscribe(...args) },
	failure: { subscribe: (...args) => wire.adapter.failure.subscribe(...args) },
	denials: { subscribe: (...args) => wire.adapter.denials.subscribe(...args) },
	onRequest: (...args) => wire.adapter.onRequest(...args),
	onDerived: (...args) => wire.adapter.onDerived(...args),
	setTopicManaged: () => {}
}));

const ticks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

afterEach(() => { vi.unstubAllGlobals(); });

describe('mutate() with a throwing subscriber on a real Svelte store', () => {
	it('settles as its call did, reports the error, and the stores stay silent afterwards', async () => {
		const { writable } = await import('svelte/store');
		const topics = new Map(), sent = [];
		const sink = (fn) => { fn(null); return () => {}; };
		const adapter = {
			on(topic) { return { subscribe(fn) {
				if (!topics.has(topic)) topics.set(topic, new Set());
				topics.get(topic).add(fn);
				return () => topics.get(topic).delete(fn);
			} }; },
			status: writable('open'),
			failure: { subscribe: sink },
			denials: { subscribe: sink },
			onRequest: () => () => {},
			onDerived: () => ({ subscribe: () => () => {} })
		};
		const connection = { ...adapter, send: (f) => sent.push(f), sendQueued: (f) => sent.push(f), bufferedAmount: 0 };
		adapter.connect = () => connection;
		wire.adapter = adapter;
		const emit = (topic, envelope) => { for (const fn of [...(topics.get(topic) || [])]) fn(envelope); };
		const frames = () => sent.splice(0).flatMap((f) => f.batch || [f]);
		const report = vi.fn();
		vi.stubGlobal('reportError', report);

		const client = await import('../src/client.js');
		const items = client.__stream('real/items', { merge: 'crud', key: 'id' });
		const seen = [];
		const offSeen = items.subscribe((v) => seen.push(v));
		await ticks();
		const init = frames().find((f) => f.rpc === 'real/items');
		emit('__rpc', { event: init.id, data: { ok: true, topic: 'real-items', merge: 'crud', key: 'id', data: [{ id: 1 }] } });
		await ticks();
		expect(seen.at(-1)).toEqual([{ id: 1 }]);

		let thrown = 0;
		const offThrow = items.subscribe((v) => {
			if (Array.isArray(v) && v.some((row) => row.id === 2)) { thrown++; throw new Error('subscriber threw'); }
		});
		const op = items.mutate(() => client.__rpc('real/save')({ id: 2 }), { event: 'created', data: { id: 2 } });
		expect(thrown).toBe(1);
		expect(report).toHaveBeenCalledTimes(1);
		expect(report.mock.calls[0][0]).toEqual(expect.objectContaining({ message: 'subscriber threw' }));
		const save = frames().find((f) => f.rpc === 'real/save');
		expect(save.args).toEqual([{ id: 2 }]);
		emit('__rpc', { event: save.id, data: { ok: true, data: 'saved' } });
		await expect(op).resolves.toBe('saved');

		// What the throw leaves behind: no subscriber of any store runs again.
		const countBefore = seen.length;
		emit('real-items', { event: 'created', data: { id: 3 } });
		const other = writable(0);
		const otherSeen = [];
		const offOther = other.subscribe((v) => otherSeen.push(v));
		other.set(1);
		expect(seen.length).toBe(countBefore);
		expect(otherSeen).toEqual([0]);
		expect(thrown).toBe(1);
		offOther();
		offThrow();
		offSeen();
	});
});
