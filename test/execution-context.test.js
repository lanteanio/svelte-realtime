// An app establishes request-scoped context (an AsyncLocalStorage store) in
// global middleware. Every handler invocation that runs under a user's ctx
// must see that user's store: wire calls, and the background loader re-runs a
// stream or derived topic performs later on the subscriber's behalf.

import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live, guard, _resetMiddleware, _resetInvalidationWatch, _prepareHmr } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';

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
