// An app establishes request-scoped context (an AsyncLocalStorage store) in
// global middleware. Every handler invocation that runs under a user's ctx
// must see that user's store: wire calls, and the background loader re-runs a
// stream or derived topic performs later on the subscriber's behalf.

import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live, guard, _resetMiddleware, _resetInvalidationWatch, _prepareHmr } from '../src/server.js';
import { createTestContext, createTestEnv } from '../src/testing.js';

const als = new AsyncLocalStorage();
const actor = () => als.getStore()?.actor ?? null;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

let env;
beforeEach(() => {
	live.middleware((ctx, next) => als.run({ actor: ctx.user?.id ?? null }, next));
	env = createTestEnv();
});
afterEach(() => {
	env.cleanup();
	_resetMiddleware();
	_resetInvalidationWatch();
	_prepareHmr();
	vi.useRealTimers();
});

describe('request context from middleware', () => {
	it('keeps each call on its own store while two sockets interleave, from the guard on', async () => {
		const gates = { alice: deferred(), bob: deferred() };
		const seen = [];
		env.register('audit', {
			_guard: guard(ctx => { seen.push(['guard', ctx.user.id, actor()]); }),
			write: live(async ctx => {
				seen.push(['before', ctx.user.id, actor()]);
				await gates[ctx.user.id].promise;
				seen.push(['after', ctx.user.id, actor()]);
				return actor();
			})
		});
		const alice = env.connect({ id: 'alice' }).call('audit/write');
		const bob = env.connect({ id: 'bob' }).call('audit/write');
		await vi.waitFor(() => expect(seen.filter(([step]) => step === 'before')).toHaveLength(2));
		gates.bob.resolve();
		expect(await bob).toBe('bob');
		gates.alice.resolve();
		expect(await alice).toBe('alice');
		expect(seen.every(([, user, store]) => user === store)).toBe(true);
		expect(seen.filter(([step]) => step === 'guard')).toHaveLength(2);
	});

	it('reloads an invalidated stream under the subscriber, not the publisher', async () => {
		const loads = [];
		env.register('feed', {
			read: live.stream('ctx:feed', async () => { loads.push(actor()); return { n: loads.length }; }, { merge: 'set', invalidateOn: 'ctx:control' }),
			touch: live(ctx => ctx.publish('ctx:control', 'changed', {}))
		});
		const stream = env.connect({ id: 'alice' }).subscribe('feed/read');
		await stream.waitFor(v => v?.n === 1);
		await env.connect({ id: 'bob' }).call('feed/touch');
		await stream.waitFor(v => v?.n === 2);
		expect(loads).toEqual(['alice', 'alice']);
	});

	it('reloads a stale stream under the subscriber, not the publisher that re-armed it', async () => {
		vi.useFakeTimers();
		const loads = [];
		env.register('feed', {
			read: live.stream('ctx:stale', async () => { loads.push(actor()); return { n: loads.length }; }, { merge: 'set', staleAfterMs: 1000 }),
			touch: live(ctx => ctx.publish('ctx:stale', 'set', { n: 0 }))
		});
		const stream = env.connect({ id: 'alice' }).subscribe('feed/read');
		await vi.advanceTimersByTimeAsync(0);
		await env.connect({ id: 'bob' }).call('feed/touch');
		await vi.advanceTimersByTimeAsync(1000);
		expect(stream.value).toEqual({ n: 2 });
		expect(loads).toEqual(['alice', 'alice']);
	});

	it('recomputes a per-argument derived topic under a subscriber, not the publisher', async () => {
		const computes = [];
		env.register('stats', {
			board: live.derived(id => ['ctx:source:' + id], async (ctx, id) => { computes.push([ctx.user?.id ?? null, actor()]); return computes.length; }),
			touch: live((ctx, id) => ctx.publish('ctx:source:' + id, 'set', 1))
		});
		const stream = env.connect({ id: 'alice' }).subscribe('stats/board', 'x');
		await stream.waitFor(v => v === 1);
		await env.connect({ id: 'bob' }).call('stats/touch', 'x');
		await stream.waitFor(v => v === 2);
		expect(computes.at(-1)).toEqual(['alice', 'alice']);
	});

	it('routes a middleware rejection of a reload to the stream onError', async () => {
		const errors = [];
		let refuse = false;
		live.middleware((ctx, next) => { if (refuse && ctx.user?.id === 'alice') throw new Error('refused'); return next(); });
		env.register('feed', {
			read: live.stream('ctx:refuse', async () => ({ ok: true }), {
				merge: 'set', invalidateOn: 'ctx:refuse:control', onError: err => { errors.push(err.message); }
			}),
			touch: live(ctx => ctx.publish('ctx:refuse:control', 'changed', {}))
		});
		const stream = env.connect({ id: 'alice' }).subscribe('feed/read');
		await stream.waitFor(v => v?.ok === true);
		refuse = true;
		await env.connect({ id: 'bob' }).call('feed/touch');
		await vi.waitFor(() => expect(errors).toEqual(['refused']));
		expect(stream.events.filter(e => e.event === 'refreshed')).toEqual([]);
	});
});

describe('background re-runs in middleware', () => {
	it('builds client and re-run contexts in createTestContext', () => {
		expect(createTestContext().rerun).toBeNull();
		expect(createTestContext({ rerun: 'staleAfterMs' }).rerun).toBe('staleAfterMs');
	});

	it('marks each re-run with ctx.rerun and leaves client calls at null', async () => {
		const seen = [];
		live.middleware((ctx, next) => { seen.push(ctx.rerun); return next(); });
		env.register('marks', {
			feed: live.stream('mark:feed', async () => ({ ok: true }), { merge: 'set', invalidateOn: 'mark:control' }),
			board: live.derived(id => ['mark:source:' + id], async (ctx, id) => ctx.rerun),
			touch: live((ctx, id) => { ctx.publish('mark:control', 'changed', {}); ctx.publish('mark:source:' + id, 'set', 1); })
		});
		const alice = env.connect({ id: 'alice' });
		const feed = alice.subscribe('marks/feed');
		const board = alice.subscribe('marks/board', 'x');
		await feed.waitFor(v => v?.ok === true);
		await board.waitFor(v => v !== undefined);
		expect(seen).toEqual([null, null]);
		await alice.call('marks/touch', 'x');
		await vi.waitFor(() => expect(seen).toEqual(expect.arrayContaining(['invalidateOn', 'derived'])));
		await board.waitFor(v => v === 'derived');
		expect(seen.slice(0, 3)).toEqual([null, null, null]);
	});

	it('marks a stale reload with ctx.rerun', async () => {
		vi.useFakeTimers();
		const seen = [];
		live.middleware((ctx, next) => { seen.push(ctx.rerun); return next(); });
		env.register('marks', {
			feed: live.stream('mark:stale', async ctx => ({ rerun: ctx.rerun }), { merge: 'set', staleAfterMs: 1000 })
		});
		const stream = env.connect({ id: 'alice' }).subscribe('marks/feed');
		await vi.advanceTimersByTimeAsync(0);
		expect(stream.value).toEqual({ rerun: null });
		await vi.advanceTimersByTimeAsync(1000);
		expect(stream.value).toEqual({ rerun: 'staleAfterMs' });
		expect(seen).toEqual([null, 'staleAfterMs']);
	});

	it('moves an invalidation reload to a remaining subscriber once the first one leaves', async () => {
		const loads = [];
		env.register('feed', {
			_guard: guard(ctx => { ctx.tag = 'guarded:' + ctx.user.id; }),
			read: live.stream('move:feed', async ctx => { loads.push([actor(), ctx.tag, ctx.ws?.getUserData().id ?? null]); return { n: loads.length }; }, { merge: 'set', invalidateOn: 'move:control' }),
			touch: live(ctx => ctx.publish('move:control', 'changed', {}))
		});
		const alice = env.connect({ id: 'alice' });
		await alice.subscribe('feed/read').waitFor(v => v?.n === 1);
		const bob = env.connect({ id: 'bob' });
		const stream = bob.subscribe('feed/read');
		await stream.waitFor(v => v?.n === 2);
		alice.disconnect();
		await env.connect({ id: 'carol' }).call('feed/touch');
		await stream.waitFor(v => v?.n === 3);
		expect(loads.at(-1)).toEqual(['bob', 'guarded:bob', 'bob']);
	});

	it('moves a stale reload to a remaining subscriber once the first one disconnects', async () => {
		vi.useFakeTimers();
		const loads = [];
		env.register('feed', {
			read: live.stream('move:stale', async () => { loads.push(actor()); return { n: loads.length }; }, { merge: 'set', staleAfterMs: 1000 })
		});
		const alice = env.connect({ id: 'alice' });
		alice.subscribe('feed/read');
		await vi.advanceTimersByTimeAsync(0);
		const stream = env.connect({ id: 'bob' }).subscribe('feed/read');
		await vi.advanceTimersByTimeAsync(0);
		alice.disconnect();
		await vi.advanceTimersByTimeAsync(1000);
		expect(loads).toEqual(['alice', 'bob', 'bob']);
		expect(stream.value).toEqual({ n: 3 });
	});

	it('runs an invalidation reload under the next subscriber when middleware refuses the first', async () => {
		const errors = [];
		live.middleware((ctx, next) => { if (ctx.rerun && ctx.user?.id === 'alice') throw new Error('refused'); return next(); });
		const loads = [];
		env.register('feed', {
			read: live.stream('skip:feed', async () => { loads.push(actor()); return { n: loads.length }; }, {
				merge: 'set', invalidateOn: 'skip:control', onError: err => { errors.push(err.message); }
			}),
			touch: live(ctx => ctx.publish('skip:control', 'changed', {}))
		});
		await env.connect({ id: 'alice' }).subscribe('feed/read').waitFor(v => v?.n === 1);
		const stream = env.connect({ id: 'bob' }).subscribe('feed/read');
		await stream.waitFor(v => v?.n === 2);
		await env.connect({ id: 'carol' }).call('feed/touch');
		await stream.waitFor(v => v?.n === 3);
		expect(loads).toEqual(['alice', 'bob', 'bob']);
		expect(errors).toEqual([]);
	});

	it('recomputes a shared derived topic under the next subscriber when middleware refuses the first, with ws null', async () => {
		const sockets = [];
		live.middleware((ctx, next) => {
			if (ctx.rerun) sockets.push(ctx.ws);
			if (ctx.rerun && ctx.user?.id === 'alice') throw new Error('refused');
			return next();
		});
		env.register('stats', {
			board: live.derived(id => ['skip:source:' + id], async (ctx, id) => ctx.rerun ? ctx.user.id : 'initial', { scopeKey: () => 'shared' }),
			touch: live((ctx, id) => ctx.publish('skip:source:' + id, 'set', 1))
		});
		const alice = env.connect({ id: 'alice' }).subscribe('stats/board', 'x');
		await alice.waitFor(v => v === 'initial');
		const bob = env.connect({ id: 'bob' }).subscribe('stats/board', 'x');
		await bob.waitFor(v => v === 'initial');
		await env.connect({ id: 'carol' }).call('stats/touch', 'x');
		await bob.waitFor(v => v === 'bob');
		await alice.waitFor(v => v === 'bob');
		expect(sockets).toEqual([null, null]);
	});
});
