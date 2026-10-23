// An app establishes request-scoped context (an AsyncLocalStorage store) in
// global middleware. Every handler invocation that runs under a user's ctx
// must see that user's store: wire calls, and the background loader re-runs a
// stream or derived topic performs later on the subscriber's behalf.

import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live, guard, _resetMiddleware, _resetInvalidationWatch, _prepareHmr } from '../src/server.js';
import { createTestContext, createTestEnv } from '../src/testing.js';
import { _topicInvalidationWatch, _topicStaleWatch } from '../src/server/state.js';

const als = new AsyncLocalStorage();
const actor = () => als.getStore()?.actor ?? null;
const resumeFrame = (path, id, version) => new TextEncoder().encode(JSON.stringify({ rpc: path, id, args: [], stream: true, version })).buffer;
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

	it('reloads under a subscriber that resumed without running the loader once the first one leaves', async () => {
		const loads = [];
		env.register('feed', {
			read: live.stream('resume:feed', async () => { loads.push(actor()); return { n: loads.length }; }, {
				merge: 'set', invalidateOn: 'resume:control', delta: { version: () => 1, diff: async () => null }
			}),
			touch: live(ctx => ctx.publish('resume:control', 'changed', {}))
		});
		const alice = env.connect({ id: 'alice' });
		await alice.subscribe('feed/read').waitFor(v => v?.n === 1);
		const bob = env.connect({ id: 'bob' });
		const replies = [];
		bob.onMessage(message => replies.push(message));
		bob.sendRaw(new TextEncoder().encode(JSON.stringify({ rpc: 'feed/read', id: 'bob-resume', args: [], stream: true, version: 1 })).buffer);
		await vi.waitFor(() => expect(JSON.stringify(replies)).toContain('"unchanged":true'));
		alice.disconnect();
		await env.connect({ id: 'carol' }).call('feed/touch');
		await vi.waitFor(() => expect(loads).toHaveLength(2));
		expect(loads).toEqual(['alice', 'bob']);
	});

	it('skips a stream reload when middleware returns without calling next', async () => {
		live.middleware((ctx, next) => (ctx.rerun ? undefined : next()));
		const loads = [];
		env.register('feed', {
			read: live.stream('skipnext:feed', async () => { loads.push(actor()); return { n: loads.length }; }, { merge: 'set', invalidateOn: 'skipnext:control' }),
			touch: live(ctx => ctx.publish('skipnext:control', 'changed', {})),
			ping: live(() => 'pong')
		});
		const stream = env.connect({ id: 'alice' }).subscribe('feed/read');
		await stream.waitFor(v => v?.n === 1);
		const carol = env.connect({ id: 'carol' });
		await carol.call('feed/touch');
		await carol.call('feed/ping');
		await new Promise(resolve => setImmediate(resolve));
		expect(loads).toEqual(['alice']);
		expect(stream.events.filter(e => e.event === 'refreshed')).toEqual([]);
		expect(stream.value).toEqual({ n: 1 });
	});

	it('skips a derived recompute when middleware returns without calling next', async () => {
		live.middleware((ctx, next) => (ctx.rerun ? undefined : next()));
		let computes = 0;
		env.register('stats', {
			board: live.derived(id => ['skipnext:source:' + id], async () => ++computes),
			touch: live((ctx, id) => ctx.publish('skipnext:source:' + id, 'set', 1)),
			ping: live(() => 'pong')
		});
		const board = env.connect({ id: 'alice' }).subscribe('stats/board', 'x');
		await board.waitFor(v => v === 1);
		const carol = env.connect({ id: 'carol' });
		await carol.call('stats/touch', 'x');
		await carol.call('stats/ping');
		await new Promise(resolve => setImmediate(resolve));
		expect(computes).toBe(1);
		expect(board.events.filter(e => e.event === 'set')).toEqual([]);
	});

	it('checks each derived subscriber once while every one of them is refused', async () => {
		let refusals = 0;
		live.middleware((ctx, next) => {
			if (ctx.rerun) { refusals++; throw new Error('refused'); }
			return next();
		});
		let scopeChecks = 0;
		env.register('stats', {
			board: live.derived(id => ['refuseall:source:' + id], async () => 'initial', { scopeKey: () => { scopeChecks++; return 'shared'; } }),
			touch: live((ctx, id) => ctx.publish('refuseall:source:' + id, 'set', 1))
		});
		const count = 6;
		for (let i = 0; i < count; i++) await env.connect({ id: 'user' + i }).subscribe('stats/board', 'x').waitFor(v => v === 'initial');
		scopeChecks = 0;
		await env.connect({ id: 'carol' }).call('stats/touch', 'x');
		await vi.waitFor(() => expect(refusals).toBe(count));
		await new Promise(resolve => setImmediate(resolve));
		expect(refusals).toBe(count);
		expect(scopeChecks).toBe(count);
	});

	it('reloads a stale topic shared by two streams with the remaining subscriber\'s own stream', async () => {
		vi.useFakeTimers();
		const loads = [];
		env.register('feed', {
			first: live.stream('sharedstale:feed', async () => { loads.push('first:' + actor()); return { from: 'first' }; }, { merge: 'set', staleAfterMs: 1000 }),
			second: live.stream('sharedstale:feed', async () => { loads.push('second:' + actor()); return { from: 'second' }; }, { merge: 'set', staleAfterMs: 1000 })
		});
		const alice = env.connect({ id: 'alice' });
		alice.subscribe('feed/first');
		await vi.advanceTimersByTimeAsync(0);
		env.connect({ id: 'bob' }).subscribe('feed/second');
		await vi.advanceTimersByTimeAsync(0);
		alice.disconnect();
		await vi.advanceTimersByTimeAsync(1000);
		expect(loads).toEqual(['first:alice', 'second:bob', 'second:bob']);
	});
});

describe('reload bookkeeping for resumed subscribers', () => {
	it('arms the watchdog and watchers for a first subscriber that resumes without running the loader', async () => {
		vi.useFakeTimers();
		const loads = [];
		env.register('feed', {
			read: live.stream('armresume:feed', async () => { loads.push(actor()); return { n: loads.length }; }, {
				merge: 'set', staleAfterMs: 1000, invalidateOn: 'armresume:control', delta: { version: () => 1, diff: async () => null }
			})
		});
		const bob = env.connect({ id: 'bob' });
		const replies = [];
		bob.onMessage(message => replies.push(message));
		bob.sendRaw(resumeFrame('feed/read', 'bob-resume', 1));
		await vi.advanceTimersByTimeAsync(0);
		expect(JSON.stringify(replies)).toContain('"unchanged":true');
		expect(loads).toEqual([]);
		expect(_topicStaleWatch.has('armresume:feed')).toBe(true);
		expect(_topicInvalidationWatch.size).toBe(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(loads).toEqual(['bob']);
	});

	it('arms nothing for a socket that closes while its resume is still awaiting', async () => {
		const gate = deferred();
		let versionCalled = false;
		let versionRead = false;
		env.register('feed', {
			read: live.stream('closedresume:feed', async () => ({ ok: true }), {
				merge: 'set', staleAfterMs: 1000, invalidateOn: 'closedresume:control',
				delta: { version: async () => { versionCalled = true; await gate.promise; versionRead = true; return 1; }, diff: async () => null }
			})
		});
		const bob = env.connect({ id: 'bob' });
		bob.sendRaw(resumeFrame('feed/read', 'bob-resume', 1));
		await vi.waitFor(() => expect(versionCalled).toBe(true));
		bob.disconnect();
		gate.resolve();
		await vi.waitFor(() => expect(versionRead).toBe(true));
		await new Promise(resolve => setImmediate(resolve));
		expect(_topicStaleWatch.has('closedresume:feed')).toBe(false);
		expect(_topicInvalidationWatch.size).toBe(0);
	});

	it('forgets a rolled-back stream on a socket that keeps the topic through another stream', async () => {
		let failNext = false;
		live.middleware(async (ctx, next) => {
			const result = await next();
			if (failNext) { failNext = false; throw new Error('late failure'); }
			return result;
		});
		const loads = [];
		env.register('feed', {
			keeps: live.stream('rollback:feed', async () => { loads.push('keeps'); return { from: 'keeps' }; }, { merge: 'set' }),
			fails: live.stream('rollback:feed', async () => { loads.push('fails'); return { from: 'fails' }; }, { merge: 'set', invalidateOn: 'rollback:control' }),
			touch: live(ctx => ctx.publish('rollback:control', 'changed', {})),
			ping: live(() => 'pong')
		});
		const alice = env.connect({ id: 'alice' });
		await alice.subscribe('feed/keeps').waitFor(v => v?.from === 'keeps');
		failNext = true;
		const failed = alice.subscribe('feed/fails');
		await vi.waitFor(() => expect(failed.error).not.toBeNull());
		expect(loads).toEqual(['keeps', 'fails']);
		expect(_topicInvalidationWatch.size).toBe(0);
		const carol = env.connect({ id: 'carol' });
		await carol.call('feed/touch');
		await carol.call('feed/ping');
		await new Promise(resolve => setImmediate(resolve));
		expect(loads).toEqual(['keeps', 'fails']);
	});
});
