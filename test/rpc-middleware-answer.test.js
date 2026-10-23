// Every RPC is answered whatever a global middleware returns: text frames,
// binary frames and batch entries. A middleware's response envelope answers;
// a failure it caught and swallowed answers with that failure; a middleware
// that never called next() fails the call with INTERNAL_ERROR; and a chain the
// middleware did not wait for is still waited for before the answer.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { live, LiveError, guard, _resetMiddleware, setOperationalEventSink } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { handleRpc, __directCall } from '../src/server/dispatch.js';
import { inFlightCount } from '../src/server/lifecycle.js';

const textEncoder = new TextEncoder();
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function conn(env, userData = { id: 'u1' }) {
	const sent = [];
	const waiters = [];
	const ws = {
		getUserData: () => userData,
		subscribe: () => true,
		unsubscribe: () => true,
		isSubscribed: () => false,
		getTopics: () => [],
		_onSend: (topic, event, data) => {
			sent.push({ topic, event, data });
			for (const w of waiters.splice(0)) w();
		}
	};
	env.platform.connections++;
	return { ws, sent };
}

/** Wait for the frame answering `event`, failing instead of hanging. */
async function answerFor(c, event, ms = 500) {
	const start = Date.now();
	for (;;) {
		const hit = c.sent.find((f) => f.topic === '__rpc' && f.event === event);
		if (hit) return hit.data;
		if (Date.now() - start > ms) return undefined;
		await tick(5);
	}
}

function textFrame(path, id, args = []) {
	return textEncoder.encode(JSON.stringify({ rpc: path, id, args })).buffer;
}

function batchFrame(entries) {
	return textEncoder.encode(JSON.stringify({ batch: entries })).buffer;
}

function binaryFrame(path, id, bytes = new Uint8Array([1, 2, 3])) {
	const header = textEncoder.encode(JSON.stringify({ rpc: path, id }));
	const frame = new Uint8Array(3 + header.length + bytes.length);
	frame[0] = 0x00;
	frame[1] = (header.length >> 8) & 0xff;
	frame[2] = header.length & 0xff;
	frame.set(header, 3);
	frame.set(bytes, 3 + header.length);
	return frame.buffer;
}

const transports = [
	{
		name: 'text',
		event: 'rpc.execution.non-live-error',
		async send(env, c, opts, path) {
			handleRpc(c.ws, textFrame('mw/' + path, 'r1'), env.platform, opts);
			return answerFor(c, 'r1');
		}
	},
	{
		name: 'binary',
		event: 'rpc.binary.execution-failed',
		async send(env, c, opts, path) {
			handleRpc(c.ws, binaryFrame('mw/' + path + 'Bin', 'r1'), env.platform, opts);
			return answerFor(c, 'r1');
		}
	},
	{
		name: 'batch entry',
		event: 'rpc.execution.non-live-error',
		async send(env, c, opts, path) {
			handleRpc(c.ws, batchFrame([{ rpc: 'mw/' + path, id: 'r1' }]), env.platform, opts);
			const batch = await answerFor(c, '__batch');
			return batch ? batch.batch.find((e) => e.id === 'r1') : undefined;
		}
	}
];

describe('RPC answers whatever the global middleware returns', () => {
	let env, ran, finished, errors, events, restoreSink, unhandled;
	const onUnhandled = (err) => { unhandled.push(err); };
	const onUncaught = (err) => { unhandled.push(err); };

	beforeEach(() => {
		env = createTestEnv();
		ran = 0;
		finished = 0;
		errors = [];
		events = [];
		unhandled = [];
		process.on('unhandledRejection', onUnhandled);
		process.on('uncaughtException', onUncaught);
		restoreSink = setOperationalEventSink((record) => { events.push(record); });
		const slow = async () => { ran++; await tick(30); finished++; return 'done'; };
		const fails = () => { ran++; throw new LiveError('CONFLICT', 'Version mismatch', { details: { version: 3 } }); };
		const crashes = () => { ran++; throw new Error('private detail'); };
		env.register('mw', {
			plain: live(async () => 'plain'),
			ok: live(async () => { ran++; return 'value'; }),
			okBin: live.binary(async () => { ran++; return 'value'; }),
			slow: live(slow),
			slowBin: live.binary(slow),
			fails: live(fails),
			failsBin: live.binary(fails),
			crashes: live(crashes),
			crashesBin: live.binary(crashes)
		});
	});

	afterEach(async () => {
		await tick(40);
		process.off('unhandledRejection', onUnhandled);
		process.off('uncaughtException', onUncaught);
		if (typeof restoreSink === 'function') restoreSink(); else setOperationalEventSink(null);
		_resetMiddleware();
		env.cleanup();
		expect(unhandled).toEqual([]);
	});

	const opts = () => ({ onError: (path, err) => { errors.push({ path, err }); } });

	for (const t of transports) {
		describe(t.name, () => {
			it('a middleware that returns undefined without next() fails the call with INTERNAL_ERROR', async () => {
				live.middleware(async () => undefined);
				const c = conn(env);
				const reply = await t.send(env, c, opts(), 'ok');
				expect(reply).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' });
				expect(ran).toBe(0);
				expect(errors.map((e) => String(e.err?.message))).toEqual([expect.stringContaining('next()')]);
				const failed = events.filter((e) => e.event === t.event);
				expect(failed.length).toBe(1);
				expect(failed[0].attributes.error.message).toContain('next()');
			});

			it('a middleware that returns a non-envelope value without next() fails the call', async () => {
				live.middleware(async () => 'nope');
				const c = conn(env);
				if (t.name === 'batch entry') {
					handleRpc(c.ws, batchFrame([{ rpc: 'mw/ok', id: 'r1' }]), env.platform, opts());
					const batch = await answerFor(c, '__batch');
					expect(batch.batch[0]).toMatchObject({ id: 'r1', ok: false, code: 'INTERNAL_ERROR' });
				} else {
					const reply = await t.send(env, c, opts(), 'ok');
					expect(reply).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' });
				}
				expect(ran).toBe(0);
			});

			it('a returned failure envelope refuses with its code and metadata, as-is', async () => {
				live.middleware(async (ctx, next) => {
					if (ctx.user.id === 'u1') return { ok: false, code: 'RATE_LIMITED', error: 'Slow down', retryAfter: 5, details: { bucket: 'b' } };
					return next();
				});
				const c = conn(env);
				if (t.name === 'batch entry') {
					handleRpc(c.ws, batchFrame([{ rpc: 'mw/ok', id: 'r1' }]), env.platform, opts());
					const batch = await answerFor(c, '__batch');
					expect(batch.batch[0]).toMatchObject({ id: 'r1', ok: false, code: 'RATE_LIMITED', error: 'Slow down', retryAfter: 5, details: { bucket: 'b' } });
				} else {
					const reply = await t.send(env, c, opts(), 'ok');
					expect(reply).toMatchObject({ ok: false, code: 'RATE_LIMITED', error: 'Slow down', retryAfter: 5, details: { bucket: 'b' } });
				}
				expect(ran).toBe(0);
				expect(errors).toEqual([]);
			});

			it('a LiveError the middleware caught and swallowed answers with that error', async () => {
				live.middleware(async (ctx, next) => {
					try { return await next(); } catch { return undefined; }
				});
				const c = conn(env);
				const reply = await t.send(env, c, opts(), 'fails');
				expect(reply).toMatchObject({ ok: false, code: 'CONFLICT', error: 'Version mismatch', details: { version: 3 } });
				expect(ran).toBe(1);
			});

			it('a guard failure the middleware swallowed answers with the guard error', async () => {
				const gated = () => { ran++; return 'value'; };
				env.register('mwg', {
					_guard: guard(() => { throw new LiveError('FORBIDDEN', 'Nope'); }),
					ok: live(gated),
					okBin: live.binary(gated)
				});
				live.middleware(async (ctx, next) => {
					try { return await next(); } catch { return 42; }
				});
				const c = conn(env);
				const frame = t.name === 'text' ? textFrame('mwg/ok', 'r1')
					: t.name === 'binary' ? binaryFrame('mwg/okBin', 'r1')
						: batchFrame([{ rpc: 'mwg/ok', id: 'r1' }]);
				handleRpc(c.ws, frame, env.platform, opts());
				const raw = await answerFor(c, t.name === 'batch entry' ? '__batch' : 'r1');
				const reply = t.name === 'batch entry' ? raw?.batch[0] : raw;
				expect(reply).toMatchObject({ ok: false, code: 'FORBIDDEN', error: 'Nope' });
				expect(ran).toBe(0);
			});

			it('a non-LiveError the middleware swallowed answers INTERNAL_ERROR and reaches onError', async () => {
				live.middleware(async (ctx, next) => {
					try { return await next(); } catch { return 'swallowed'; }
				});
				const c = conn(env);
				const reply = await t.send(env, c, opts(), 'crashes');
				expect(reply).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' });
				expect(JSON.stringify(reply)).not.toContain('private detail');
				expect(errors.map((e) => e.err?.message)).toEqual(['private detail']);
			});

			it('a middleware that awaits next() but returns nothing answers with the handler result', async () => {
				live.middleware(async (ctx, next) => { await next(); });
				const c = conn(env);
				const reply = await t.send(env, c, opts(), 'ok');
				expect(reply).toMatchObject({ ok: true, data: 'value' });
			});

			it('a middleware that calls next() without awaiting it waits for the handler', async () => {
				live.middleware(async (ctx, next) => { next(); return undefined; });
				const c = conn(env);
				const reply = await t.send(env, c, opts(), 'slow');
				expect(finished).toBe(1);
				expect(reply).toMatchObject({ ok: true, data: 'done' });
			});

			it('a failure envelope returned while the handler runs answers at once; the handler still counts in-flight', async () => {
				live.middleware(async (ctx, next) => {
					next();
					return { ok: false, code: 'TIMEOUT', error: 'Took too long' };
				});
				const c = conn(env);
				const reply = await t.send(env, c, opts(), 'slow');
				expect(reply).toMatchObject({ ok: false, code: 'TIMEOUT', error: 'Took too long' });
				expect(ran).toBe(1);
				expect(finished).toBe(0);
				expect(inFlightCount()).toBe(1);
				await tick(60);
				expect(finished).toBe(1);
				expect(inFlightCount()).toBe(0);
				expect(c.sent.filter((f) => f.event === 'r1' || f.event === '__batch').length).toBe(1);
			});

			it('a timeout middleware racing next() answers when the timer wins', async () => {
				live.middleware((ctx, next) => Promise.race([
					next(),
					tick(5).then(() => ({ ok: false, code: 'TIMEOUT', error: 'Took too long' }))
				]));
				const c = conn(env);
				const reply = await t.send(env, c, opts(), 'slow');
				expect(reply).toMatchObject({ ok: false, code: 'TIMEOUT' });
				expect(finished).toBe(0);
			});

			it('a late next() after the answer throws and runs no handler', async () => {
				const late = [];
				live.middleware(async (ctx, next) => {
					setTimeout(() => { try { Promise.resolve(next()).catch((e) => late.push(e)); } catch (e) { late.push(e); } }, 5);
					return { ok: false, code: 'FORBIDDEN', error: 'No' };
				});
				const c = conn(env);
				const reply = await t.send(env, c, opts(), 'ok');
				expect(reply).toMatchObject({ ok: false, code: 'FORBIDDEN' });
				await tick(30);
				expect(late.map((e) => e.message)).toEqual([expect.stringContaining('after the call was answered')]);
				expect(ran).toBe(0);
			});
		});
	}

	it('a middleware that refuses after a stream subscribe completed releases the subscription', async () => {
		env.register('feeds', { feed: live.stream('feeds:main', async () => [{ id: 1 }]) });
		live.middleware(async (ctx, next) => {
			await next();
			return { ok: false, code: 'FORBIDDEN', error: 'Refused' };
		});
		const c = conn(env);
		const topics = new Set();
		c.ws.subscribe = (t) => { topics.add(t); return true; };
		c.ws.unsubscribe = (t) => { topics.delete(t); return true; };
		c.ws.isSubscribed = (t) => topics.has(t);
		c.ws.getTopics = () => [...topics];
		handleRpc(c.ws, textEncoder.encode(JSON.stringify({ rpc: 'feeds/feed', id: 's1', args: [], stream: true })).buffer, env.platform);
		const reply = await answerFor(c, 's1');
		expect(reply).toMatchObject({ ok: false, code: 'FORBIDDEN' });
		expect([...topics]).toEqual([]);
	});

	it('a late next() from a timer or a detached async function does not crash the process', async () => {
		let n = 0;
		live.middleware(async (ctx, next) => {
			if (n++ === 0) setTimeout(next, 5);
			else (async () => { await tick(5); next(); })();
			return { ok: false, code: 'FORBIDDEN', error: 'No' };
		});
		const c = conn(env);
		handleRpc(c.ws, textFrame('mw/ok', 'r1'), env.platform);
		handleRpc(c.ws, textFrame('mw/ok', 'r2'), env.platform);
		expect(await answerFor(c, 'r1')).toMatchObject({ code: 'FORBIDDEN' });
		expect(await answerFor(c, 'r2')).toMatchObject({ code: 'FORBIDDEN' });
		await tick(40);
		expect(ran).toBe(0);
		expect(events.filter((e) => e.event === 'rpc.middleware.next-after-answer').map((e) => e.attributes.path)).toEqual(['mw/ok', 'mw/ok']);
	});

	it('a handler failing after an early answer emits an event without its message', async () => {
		env.register('late', { boom: live(async () => { await tick(20); throw new Error('secret detail'); }) });
		live.middleware(async (ctx, next) => {
			next();
			return { ok: false, code: 'TIMEOUT', error: 'Took too long' };
		});
		const c = conn(env);
		handleRpc(c.ws, textFrame('late/boom', 'r1'), env.platform);
		expect(await answerFor(c, 'r1')).toMatchObject({ code: 'TIMEOUT' });
		await tick(50);
		const failed = events.filter((e) => e.event === 'rpc.execution.failed-after-answer');
		expect(failed).toHaveLength(1);
		expect(failed[0].attributes).toEqual({ path: 'late/boom', error: { name: 'Error', code: null } });
		expect(JSON.stringify(failed[0])).not.toContain('secret detail');
	});

	it('a sequential batch starts the next entry only after an early-answered one ends', async () => {
		const log = [];
		env.register('shop', {
			createOrder: live(async () => { log.push('order:start'); await tick(30); log.push('order:end'); return 1; }),
			charge: live(async () => { log.push('charge:start'); return 2; })
		});
		live.middleware((ctx, next) => Promise.race([
			next(),
			tick(5).then(() => ({ ok: false, code: 'TIMEOUT', error: 'Took too long' }))
		]));
		const c = conn(env);
		handleRpc(c.ws, textEncoder.encode(JSON.stringify({ batch: [{ rpc: 'shop/createOrder', id: 'a', args: [] }, { rpc: 'shop/charge', id: 'b', args: [] }], sequential: true })).buffer, env.platform);
		const batch = await answerFor(c, '__batch', 1000);
		expect(batch.batch[0]).toMatchObject({ id: 'a', code: 'TIMEOUT' });
		expect(batch.batch[1]).toMatchObject({ id: 'b', ok: true, data: 2 });
		expect(log).toEqual(['order:start', 'order:end', 'charge:start']);
	});

	function trackTopics(c) {
		const topics = new Set();
		c.ws.subscribe = (t) => { topics.add(t); return true; };
		c.ws.unsubscribe = (t) => { topics.delete(t); return true; };
		c.ws.isSubscribed = (t) => topics.has(t);
		c.ws.getTopics = () => [...topics];
		return topics;
	}

	it('a refusal answered before the chain subscribes never subscribes or attaches', async () => {
		let loaded = 0;
		env.register('slowfeeds', {
			_guard: guard(async () => { await tick(20); }),
			feed: live.stream('slowfeeds:main', async () => { loaded++; return [{ id: 1 }]; })
		});
		live.middleware(async (ctx, next) => {
			next();
			return { ok: false, code: 'FORBIDDEN', error: 'Refused' };
		});
		const c = conn(env);
		const topics = trackTopics(c);
		handleRpc(c.ws, textEncoder.encode(JSON.stringify({ rpc: 'slowfeeds/feed', id: 's1', args: [], stream: true, attach: true })).buffer, env.platform);
		const reply = await answerFor(c, 's1');
		expect(reply).toMatchObject({ ok: false, code: 'FORBIDDEN' });
		await tick(60);
		expect([...topics]).toEqual([]);
		expect(loaded).toBe(0);
		expect(c.sent.filter((f) => f.event === 's1').length).toBe(1);
		expect(inFlightCount()).toBe(0);
	});

	it('a refusal answered while the loader runs releases the subscription when it ends', async () => {
		env.register('slowload', { feed: live.stream('slowload:main', async () => { await tick(20); return [{ id: 1 }]; }) });
		live.middleware(async (ctx, next) => {
			next();
			await tick(5);
			return { ok: false, code: 'FORBIDDEN', error: 'Refused' };
		});
		const c = conn(env);
		const topics = trackTopics(c);
		handleRpc(c.ws, textEncoder.encode(JSON.stringify({ rpc: 'slowload/feed', id: 's1', args: [], stream: true })).buffer, env.platform);
		const reply = await answerFor(c, 's1');
		expect(reply).toMatchObject({ ok: false, code: 'FORBIDDEN' });
		await tick(60);
		expect([...topics]).toEqual([]);
	});

	it('an ok envelope without next() answers a plain call but fails a subscribe', async () => {
		env.register('cached', { feed: live.stream('cached:main', async () => [{ id: 1 }]) });
		live.middleware(async () => ({ ok: true, data: 'cached' }));
		const c = conn(env);
		handleRpc(c.ws, textFrame('mw/ok', 'r1'), env.platform, opts());
		expect(await answerFor(c, 'r1')).toMatchObject({ ok: true, data: 'cached' });
		handleRpc(c.ws, textEncoder.encode(JSON.stringify({ rpc: 'cached/feed', id: 's1', args: [], stream: true })).buffer, env.platform, opts());
		expect(await answerFor(c, 's1')).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' });
		expect(errors.map((e) => e.err.message)).toEqual([expect.stringContaining('stream subscribe')]);
	});

	it('a binary deprecation signal survives a middleware refusal', async () => {
		env.register('old', { up: live.deprecate(live.binary(async () => 'ok'), { use: 'new/up' }) });
		let calls = 0;
		live.middleware(async (ctx, next) => {
			const r = await next();
			return calls++ === 0 ? { ok: false, code: 'RATE_LIMITED', error: 'Wait' } : r;
		});
		const c = conn(env);
		handleRpc(c.ws, binaryFrame('old/up', 'b1'), env.platform);
		const first = await answerFor(c, 'b1');
		expect(first).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
		expect(first.deprecation).toBeUndefined();
		handleRpc(c.ws, binaryFrame('old/up', 'b2'), env.platform);
		const second = await answerFor(c, 'b2');
		expect(second).toMatchObject({ ok: true, data: 'ok' });
		expect(second.deprecation).toBeDefined();
	});

	describe('server-side direct calls', () => {
		it('a failure envelope throws a LiveError, so fallback and onError apply', async () => {
			live.middleware(async () => ({ ok: false, code: 'FORBIDDEN', error: 'No', details: { why: 'x' } }));
			await expect(__directCall('mw/ok', [], env.platform, { user: { id: 'u1' } })).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'No', details: { why: 'x' } });
			const seen = [];
			const out = await __directCall('mw/ok', [], env.platform, { user: { id: 'u1' }, fallback: 'fb', onError: (e) => seen.push(e.code) });
			expect(out).toBe('fb');
			expect(seen).toEqual(['FORBIDDEN']);
			expect(ran).toBe(0);
		});

		it('an ok envelope answers with its data', async () => {
			live.middleware(async () => ({ ok: true, data: 5 }));
			await expect(__directCall('mw/ok', [], env.platform, { user: { id: 'u1' } })).resolves.toBe(5);
		});

		it('a redacting middleware returns its own value', async () => {
			env.register('acct', { me: live(async () => ({ id: 'u1', email: 'a@example.test' })) });
			live.middleware(async (ctx, next) => {
				const user = await next();
				return { ...user, email: undefined };
			});
			await expect(__directCall('acct/me', [], env.platform, { user: { id: 'u1' } })).resolves.toEqual({ id: 'u1', email: undefined });
		});

		it('a caching middleware that skips next() returns its cached value', async () => {
			live.middleware(async () => ['cached']);
			await expect(__directCall('mw/ok', [], env.platform, { user: { id: 'u1' } })).resolves.toEqual(['cached']);
			expect(ran).toBe(0);
		});

		it('a middleware that catches and returns null returns null', async () => {
			live.middleware(async (ctx, next) => {
				try { return await next(); } catch { return null; }
			});
			await expect(__directCall('mw/fails', [], env.platform, { user: { id: 'u1' } })).resolves.toBeNull();
		});

		it('a pass-through middleware returns the handler value unchanged', async () => {
			live.middleware(async (ctx, next) => next());
			await expect(__directCall('mw/ok', [], env.platform, { user: { id: 'u1' } })).resolves.toBe('value');
		});
	});

	it('a batch answers every entry when the middleware skips next() for all of them', async () => {
		live.middleware(async () => undefined);
		const c = conn(env);
		handleRpc(c.ws, batchFrame([{ rpc: 'mw/ok', id: 'a', args: [] }, { rpc: 'mw/plain', id: 'b', args: [] }]), env.platform);
		const batch = await answerFor(c, '__batch');
		expect(batch?.batch).toEqual([
			expect.objectContaining({ id: 'a', ok: false, code: 'INTERNAL_ERROR' }),
			expect.objectContaining({ id: 'b', ok: false, code: 'INTERNAL_ERROR' })
		]);
	});

	it('a late next() runs no inner middleware either, from a timer or a detached function', async () => {
		let inner = 0;
		let n = 0;
		live.middleware(async (ctx, next) => {
			if (n++ === 0) setTimeout(next, 5);
			else (async () => { await tick(5); next(); })();
			return { ok: false, code: 'FORBIDDEN', error: 'No' };
		});
		live.middleware(async (ctx, next) => { inner++; return next(); });
		const c = conn(env);
		handleRpc(c.ws, textFrame('mw/ok', 'r1'), env.platform);
		handleRpc(c.ws, textFrame('mw/ok', 'r2'), env.platform);
		expect(await answerFor(c, 'r1')).toMatchObject({ code: 'FORBIDDEN' });
		expect(await answerFor(c, 'r2')).toMatchObject({ code: 'FORBIDDEN' });
		await tick(40);
		expect(inner).toBe(0);
		expect(ran).toBe(0);
		expect(events.filter((e) => e.event === 'rpc.middleware.next-after-answer')).toHaveLength(2);
	});

	it('a subscribe answered while its admission is pending is released without a failure event', async () => {
		env.register('admit', { feed: live.stream('admit:main', async () => { ran++; return []; }) });
		live.middleware(async (ctx, next) => {
			next();
			return { ok: false, code: 'TIMEOUT', error: 'Took too long' };
		});
		const c = conn(env);
		const topics = trackTopics(c);
		const original = env.platform.subscribe;
		env.platform.subscribe = async (ws, topic) => { await tick(20); ws.subscribe(topic); return null; };
		try {
			handleRpc(c.ws, textEncoder.encode(JSON.stringify({ rpc: 'admit/feed', id: 's1', args: [], stream: true, attach: true })).buffer, env.platform);
			expect(await answerFor(c, 's1')).toMatchObject({ code: 'TIMEOUT' });
			await tick(60);
		} finally {
			env.platform.subscribe = original;
		}
		expect([...topics]).toEqual([]);
		expect(ran).toBe(0);
		expect(c.sent.filter((f) => f.event === 's1')).toHaveLength(1);
		expect(events.filter((e) => e.event === 'rpc.execution.failed-after-answer')).toEqual([]);
		expect(inFlightCount()).toBe(0);
	});
});
