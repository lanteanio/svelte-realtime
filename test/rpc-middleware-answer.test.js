// Every RPC is answered whatever a global middleware returns: text frames,
// binary frames and batch entries. A middleware's response envelope answers;
// a failure it caught and swallowed answers with that failure; a middleware
// that never called next() fails the call with INTERNAL_ERROR; and a chain the
// middleware did not wait for is still waited for before the answer.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { live, LiveError, guard, _resetMiddleware, setOperationalEventSink } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { handleRpc } from '../src/server/dispatch.js';

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
		async send(env, c, opts, path) {
			handleRpc(c.ws, textFrame('mw/' + path, 'r1'), env.platform, opts);
			return answerFor(c, 'r1');
		}
	},
	{
		name: 'binary',
		async send(env, c, opts, path) {
			handleRpc(c.ws, binaryFrame('mw/' + path + 'Bin', 'r1'), env.platform, opts);
			return answerFor(c, 'r1');
		}
	},
	{
		name: 'batch entry',
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

	beforeEach(() => {
		env = createTestEnv();
		ran = 0;
		finished = 0;
		errors = [];
		events = [];
		unhandled = [];
		process.on('unhandledRejection', onUnhandled);
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
				const failed = events.filter((e) => /execution/.test(e.event) && JSON.stringify(e.attributes).includes('next()'));
				expect(failed.length).toBe(1);
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

			it('a middleware that returns a failure envelope while the handler runs answers after it ends', async () => {
				live.middleware(async (ctx, next) => {
					next();
					return { ok: false, code: 'FORBIDDEN', error: 'Refused late' };
				});
				const c = conn(env);
				const reply = await t.send(env, c, opts(), 'slow');
				expect(reply).toMatchObject({ ok: false, code: 'FORBIDDEN', error: 'Refused late' });
				expect(finished).toBe(1);
				expect(c.sent.filter((f) => f.event === 'r1' || f.event === '__batch').length).toBe(1);
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
});
