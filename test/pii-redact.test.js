// piiRedact: uniform PII / sensitive-field redaction on a stream's wire egress.
// Covers the pure redactor (createPiiRedactor) plus the live-publish,
// redact-before-buffer, initial-load, fail-closed, and registry-cleanup paths.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPiiRedactor, SENSITIVE_KEY_RE } from '../src/server/pii-redact.js';
import { live, __register, handleRpc, close, publish, setBus, _activateDerived, _resetRedactRegistry } from '../src/server.js';
import { _buildCtx, _getCtxHelpers } from '../src/server/ctx.js';
import { _topicRedact, _declaredRedact, _declaredRedactPattern, _declaredStreamTopic, state } from '../src/server/state.js';
import { _registerReplayTopic, _resetReplayRouting } from '../src/server/replay-routing.js';
import { _redactOrDrop, _resolveRedactor, REDACT_DROP } from '../src/server/publish-helpers.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createPiiRedactor', () => {
	it('true strips the default sensitive-key set, keeps the rest', () => {
		const redact = createPiiRedactor(true);
		const out = redact({ name: 'Ann', token: 'abc', password: 'p', authHeader: 'x', id: 7 });
		expect(out).toEqual({ name: 'Ann', id: 7 });
	});

	it('the default key set matches the documented secrets', () => {
		for (const k of ['token', 'secret', 'password', 'auth', 'session', 'cookie', 'jwt', 'credential']) {
			expect(SENSITIVE_KEY_RE.test(k)).toBe(true);
		}
		// "key" alone is intentionally NOT stripped (id-like fields contain it).
		expect(SENSITIVE_KEY_RE.test('key')).toBe(false);
	});

	it('omit deletes the field; mask replaces with *** ; both keep other fields', () => {
		const redact = createPiiRedactor({ fields: { ssn: 'omit', email: 'mask' }, defaults: false });
		expect(redact({ ssn: '111-22', email: 'a@b.com', name: 'Ann' })).toEqual({ email: '***', name: 'Ann' });
	});

	it('hash yields a stable 16-hex pseudonym; salt changes it; same value+salt repeats', () => {
		const a = createPiiRedactor({ fields: { id: 'hash' }, hashSalt: 'salt1', defaults: false });
		const b = createPiiRedactor({ fields: { id: 'hash' }, hashSalt: 'salt2', defaults: false });
		const h1 = a({ id: 'user-123' }).id;
		const h2 = a({ id: 'user-123' }).id;
		const h3 = b({ id: 'user-123' }).id;
		expect(h1).toMatch(/^[0-9a-f]{16}$/);
		expect(h1).toBe(h2);                 // deterministic
		expect(h1).not.toBe(h3);             // salt-dependent
		expect(h1).not.toContain('user-123');
	});

	it('explicit field rules win over the default sensitive strip', () => {
		// "sessionLabel" matches the sensitive regex, but an explicit mask rule
		// must keep the field (masked) rather than omit it.
		const redact = createPiiRedactor({ fields: { sessionLabel: 'mask' } });
		expect(redact({ sessionLabel: 'Tuesday', password: 'p', name: 'Ann' }))
			.toEqual({ sessionLabel: '***', name: 'Ann' });
	});

	it('defaults default to ON: fields plus the sensitive strip both apply', () => {
		const redact = createPiiRedactor({ fields: { email: 'mask' } });
		expect(redact({ email: 'a@b.com', token: 'abc', name: 'Ann' }))
			.toEqual({ email: '***', name: 'Ann' });
	});

	it('matches field rules by key name at any nesting depth', () => {
		const redact = createPiiRedactor({ fields: { email: 'omit' }, defaults: false });
		expect(redact({ user: { profile: { email: 'a@b.com', name: 'Ann' } } }))
			.toEqual({ user: { profile: { name: 'Ann' } } });
	});

	it('redacts each element of an array', () => {
		const redact = createPiiRedactor({ fields: { email: 'mask' }, defaults: false });
		expect(redact([{ email: 'a@b.com', n: 1 }, { email: 'c@d.com', n: 2 }]))
			.toEqual([{ email: '***', n: 1 }, { email: '***', n: 2 }]);
	});

	it('is non-mutating: the caller object is left untouched', () => {
		const orig = { email: 'a@b.com', token: 'abc', nested: { ssn: '111' } };
		const out = createPiiRedactor({ fields: { email: 'mask', ssn: 'omit' } })(orig);
		expect(orig).toEqual({ email: 'a@b.com', token: 'abc', nested: { ssn: '111' } });
		expect(out).toEqual({ email: '***', nested: {} });
	});

	it('is cycle-safe', () => {
		const o = { name: 'Ann', token: 'x' };
		o.self = o;
		const out = createPiiRedactor(true)(o);
		expect(out.name).toBe('Ann');
		expect(out.token).toBeUndefined();
		expect(out.self).toBeUndefined();   // cycle collapses, no infinite loop
	});

	it('substitutes a placeholder for binary views', () => {
		const out = createPiiRedactor(true)({ blob: new Uint8Array([1, 2, 3]) });
		expect(out.blob).toBe('[bytes: 3]');
	});

	it('passes scalar payloads through unchanged', () => {
		const redact = createPiiRedactor(true);
		expect(redact(42)).toBe(42);
		expect(redact('hello')).toBe('hello');
		expect(redact(null)).toBe(null);
	});

	it('accepts a custom function redactor as-is', () => {
		const redact = createPiiRedactor((data) => ({ only: data.keep }));
		expect(redact({ keep: 1, drop: 2 })).toEqual({ only: 1 });
	});

	it('throws on an invalid config at construction time', () => {
		expect(() => createPiiRedactor({ fields: { x: 'nope' } })).toThrow(/omit.*mask.*hash/);
		expect(() => createPiiRedactor({ fields: { x: 'hash' } })).toThrow(/hashSalt/);
		expect(() => createPiiRedactor({ defaults: false })).toThrow(/no effect/);
		expect(() => createPiiRedactor(123)).toThrow(/piiRedact must be/);
	});
});

describe('piiRedact - live publish egress', () => {
	afterEach(() => {
		_resetRedactRegistry();
		_resetReplayRouting();
	});

	function ctxFor(platform) {
		return _buildCtx(null, null, platform, _getCtxHelpers(platform), null);
	}

	it('redacts the wire data on a live publish', () => {
		const platform = mockPlatform();
		_topicRedact.set('room:1', { redact: createPiiRedactor(true), onError: null, refcount: 1 });
		const ctx = ctxFor(platform);
		ctx.publish('room:1', 'set', { name: 'Ann', token: 'sekret', sessionId: 'abc' });
		expect(platform.published).toHaveLength(1);
		expect(platform.published[0].data).toEqual({ name: 'Ann' });
		expect(JSON.stringify(platform.published[0].data)).not.toContain('sekret');
	});

	it('does not mutate the publisher-supplied object', () => {
		const platform = mockPlatform();
		_topicRedact.set('room:2', { redact: createPiiRedactor({ fields: { email: 'mask' } }), onError: null, refcount: 1 });
		const data = { email: 'a@b.com', name: 'Ann' };
		ctxFor(platform).publish('room:2', 'set', data);
		expect(data).toEqual({ email: 'a@b.com', name: 'Ann' });
	});

	it('redacts BEFORE the replay buffer - PII never rests in replay', () => {
		const buffer = [];
		const platform = mockPlatform();
		platform.replay = {
			publish: (_p, topic, event, data) => { buffer.push({ topic, event, data }); return true; },
			seq: async () => 0
		};
		_registerReplayTopic('room:rep');
		_topicRedact.set('room:rep', { redact: createPiiRedactor({ fields: { ssn: 'omit' } }), onError: null, refcount: 1 });
		ctxFor(platform).publish('room:rep', 'set', { ssn: '111-22-3333', name: 'Ann' });
		expect(buffer).toHaveLength(1);
		expect(buffer[0].data).toEqual({ name: 'Ann' });
		expect(JSON.stringify(buffer[0].data)).not.toContain('111-22-3333');
		// And the redacted publish never took the bare platform.publish path.
		expect(platform.published).toHaveLength(0);
	});

	it('fail-closed: a throwing redactor with an onError drops the publish', () => {
		const platform = mockPlatform();
		let observed = null;
		_topicRedact.set('room:fc', {
			redact: () => { throw new Error('boom'); },
			onError: (err, _data, topic) => { observed = { msg: err.message, topic }; },
			refcount: 1
		});
		const ok = ctxFor(platform).publish('room:fc', 'set', { ssn: '111' });
		expect(ok).toBe(false);
		expect(platform.published).toHaveLength(0);
		expect(observed).toEqual({ msg: 'boom', topic: 'room:fc' });
	});

	it('fail-closed: a throwing redactor with NO onError throws and never broadcasts', () => {
		const platform = mockPlatform();
		_topicRedact.set('room:fc2', { redact: () => { throw new Error('boom'); }, onError: null, refcount: 1 });
		expect(() => ctxFor(platform).publish('room:fc2', 'set', { ssn: '111' })).toThrow('boom');
		expect(platform.published).toHaveLength(0);
	});

	it('redacts publishThrottled (the immediate edge) - no bypass', () => {
		const platform = mockPlatform();
		_topicRedact.set('room:thr', { redact: createPiiRedactor(true), onError: null, refcount: 1 });
		ctxFor(platform).publishThrottled('room:thr', 'set', { name: 'Ann', token: 'sekret' }, 50);
		expect(platform.published).toHaveLength(1);
		expect(platform.published[0].data).toEqual({ name: 'Ann' });
		expect(JSON.stringify(platform.published[0].data)).not.toContain('sekret');
	});

	it('redacts publishDebounced (trailing edge) - no bypass', async () => {
		const platform = mockPlatform();
		_topicRedact.set('room:deb', { redact: createPiiRedactor(true), onError: null, refcount: 1 });
		ctxFor(platform).publishDebounced('room:deb', 'set', { name: 'Bo', secret: 'shh' }, 5);
		await new Promise((r) => setTimeout(r, 20));
		expect(platform.published).toHaveLength(1);
		expect(platform.published[0].data).toEqual({ name: 'Bo' });
		expect(JSON.stringify(platform.published[0].data)).not.toContain('shh');
	});

	it('redacts ctx.batch through native platform.batch - no bypass', () => {
		const platform = mockPlatform();
		_topicRedact.set('room:b1', { redact: createPiiRedactor({ fields: { email: 'mask' } }), onError: null, refcount: 1 });
		ctxFor(platform).batch([
			{ topic: 'room:b1', event: 'set', data: { email: 'a@b.com', name: 'Ann' } },
			{ topic: 'room:plain', event: 'set', data: { name: 'Cy' } }
		]);
		const redacted = platform.published.find((p) => p.topic === 'room:b1');
		const plain = platform.published.find((p) => p.topic === 'room:plain');
		expect(redacted.data).toEqual({ email: '***', name: 'Ann' });
		expect(plain.data).toEqual({ name: 'Cy' });   // unredacted topic untouched
	});

	it('fail-closed: a throwing redactor drops a throttled publish', () => {
		const platform = mockPlatform();
		_topicRedact.set('room:thrfc', { redact: () => { throw new Error('boom'); }, onError: null, refcount: 1 });
		ctxFor(platform).publishThrottled('room:thrfc', 'set', { ssn: '111' }, 50);
		expect(platform.published).toHaveLength(0);
	});
});

describe('piiRedact - stream option', () => {
	afterEach(() => {
		_resetRedactRegistry();
		_resetReplayRouting();
	});

	it('redacts the initial-load egress on subscribe', async () => {
		__register('pii/feed', live.stream(
			'piifeed',
			async () => ({ email: 'a@b.com', name: 'Ann', token: 'sekret' }),
			{ merge: 'set', piiRedact: { fields: { email: 'mask' } } }
		));
		const ws = mockWs({ id: 'u1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'pii/feed', id: 's1', args: [], stream: true }), platform);
		await flush();
		const resp = platform.sent.find((m) => m.event === 's1');
		expect(resp.data.ok).toBe(true);
		expect(resp.data.data).toEqual({ email: '***', name: 'Ann' });
		expect(JSON.stringify(resp.data.data)).not.toContain('sekret');
	});

	it('registers a redactor on subscribe and cleans it up on close', async () => {
		__register('pii/cleanup', live.stream('piiclean', async () => ({ token: 'x' }), { merge: 'set', piiRedact: true }));
		const ws = mockWs({ id: 'u2' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'pii/cleanup', id: 's2', args: [], stream: true }), platform);
		await flush();
		expect(_topicRedact.has('piiclean')).toBe(true);
		close(ws, { platform });
		expect(_topicRedact.has('piiclean')).toBe(false);
	});

	it('throws at declaration on a bad piiRedact config', () => {
		expect(() => live.stream('t', async () => ({}), { piiRedact: { fields: { x: 'nope' } } })).toThrow(/omit.*mask.*hash/);
		expect(() => live.stream('t', async () => ({}), { piiRedact: { fields: { x: 'hash' } } })).toThrow(/hashSalt/);
	});
});

describe('piiRedact - declaration-time coverage (zero-subscriber + out-of-band)', () => {
	let savedCron;
	beforeEach(() => { savedCron = state.cronPlatform; });
	afterEach(() => { state.cronPlatform = savedCron; _resetRedactRegistry(); _resetReplayRouting(); });

	it('registers the redactor at DECLARATION for a static topic (not just at subscribe)', () => {
		__register('pii/decl', live.stream('decltopic', async () => ({}), { merge: 'set', piiRedact: { fields: { ssn: 'omit' } } }));
		expect(_declaredRedact.has('decltopic')).toBe(true);
	});

	it('redacts a live ctx.publish to a static piiRedact topic with NO subscriber', () => {
		// Security-critical: replay-eligibility is declaration-time but
		// subscribe-time redactor registration would leave a zero-subscriber
		// publish un-redacted, poisoning the replay buffer. Declaration-time
		// registration closes it.
		__register('pii/zerosub', live.stream('zerosub', async () => ({}), { merge: 'set', replay: true, piiRedact: { fields: { ssn: 'omit' } } }));
		const platform = mockPlatform();
		const ctx = _buildCtx(null, null, platform, _getCtxHelpers(platform), null);
		ctx.publish('zerosub', 'set', { ssn: '111-22-3333', name: 'Ann' });
		expect(platform.published).toHaveLength(1);
		expect(platform.published[0].data).toEqual({ name: 'Ann' });
		expect(JSON.stringify(platform.published[0].data)).not.toContain('111-22-3333');
	});

	it('redacts the out-of-band top-level publish() export', () => {
		__register('pii/oob', live.stream('oobtopic', async () => ({}), { merge: 'set', piiRedact: true }));
		const platform = mockPlatform();
		state.cronPlatform = platform;   // getPlatform() resolves this for publish()
		publish('oobtopic', 'set', { name: 'Bo', token: 'sekret' });
		expect(platform.published).toHaveLength(1);
		expect(platform.published[0].data).toEqual({ name: 'Bo' });
		expect(JSON.stringify(platform.published[0].data)).not.toContain('sekret');
	});

	it('clears the declaration-time registry on reset', () => {
		__register('pii/reset', live.stream('resettopic', async () => ({}), { merge: 'set', piiRedact: true }));
		expect(_declaredRedact.size).toBeGreaterThan(0);
		_resetRedactRegistry();
		expect(_declaredRedact.size).toBe(0);
	});

	it('redacts a zero-subscriber publish to a DYNAMIC topic after the subscriber leaves', async () => {
		// Dynamic-topic leak: replay-eligibility is permanent but the subscribe-time
		// redactor is refcount-evicted on close. The resolved topic must keep a
		// permanent redactor or a later zero-subscriber publish poisons the buffer.
		__register('pii/dyn', live.stream((ctx, room) => 'dyn:' + room, async () => ({}), { merge: 'set', replay: true, piiRedact: { fields: { ssn: 'omit' } } }));
		const ws = mockWs({ id: 'd1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'pii/dyn', id: 'd', args: ['1'], stream: true }), platform);
		await flush();
		expect(_declaredRedact.has('dyn:1')).toBe(true);
		close(ws, { platform });
		expect(_topicRedact.has('dyn:1')).toBe(false);   // subscribe-time entry gone
		const ctx = _buildCtx(null, null, platform, _getCtxHelpers(platform), null);
		ctx.publish('dyn:1', 'set', { ssn: '111-22-3333', name: 'Ann' });
		const pub = platform.published.find((p) => p.topic === 'dyn:1');
		expect(pub.data).toEqual({ name: 'Ann' });
		expect(JSON.stringify(pub.data)).not.toContain('111-22-3333');
	});

	it('resolves the logical redactor for a tenant-scoped WIRE topic', () => {
		// A tenant publish uses the wire topic '@t/<id>/<logical>'; _declaredRedact
		// is keyed by the logical topic, so the lookup must strip the prefix.
		__register('pii/ten', live.stream('secret', async () => ({}), { merge: 'set', piiRedact: { fields: { ssn: 'omit' } } }));
		expect(_declaredRedact.has('secret')).toBe(true);
		expect(_resolveRedactor('@t/acme/secret')).toBeTruthy();
		expect(_redactOrDrop('@t/acme/secret', { ssn: '999-88', name: 'Bo' })).toEqual({ name: 'Bo' });
	});
});

describe('piiRedact - cluster-transient DYNAMIC topic (never-subscribed instance)', () => {
	// A recording bus mirroring the extensions' redis/pubsub `wrap`: records a
	// relay for each publish where `options.relay !== false`. The relayed frame
	// is exactly what reaches a PEER instance that DOES hold the subscriber, so
	// asserting it stays redacted proves the cluster-transient leak is closed at
	// the source (send-side, before the wire).
	const makeRecordingBus = () => {
		const relays = [];
		return {
			relays,
			wrap(platform) {
				return {
					...platform,
					publish(topic, event, data, options) {
						const result = platform.publish(topic, event, data, options);
						if (!options || options.relay !== false) relays.push({ topic, event, data, options });
						return result;
					}
				};
			}
		};
	};

	let savedCron;
	beforeEach(() => { savedCron = state.cronPlatform; });
	afterEach(() => {
		state.cronPlatform = savedCron;
		setBus(null);
		_resetRedactRegistry();
		_resetReplayRouting();
	});

	it('registers a matchable pattern for a factory topic, not an exact entry', () => {
		__register('pii/dyn-reg', live.stream((ctx, room) => 'room:' + room, async () => ({}), { merge: 'set', piiRedact: { fields: { ssn: 'omit' } } }));
		// No exact entry for any resolved topic (nobody subscribed), but the
		// derived pattern is registered so a publish resolves the redactor.
		expect(_declaredRedact.has('room:7')).toBe(false);
		expect(_declaredRedactPattern.size).toBeGreaterThan(0);
		expect(_resolveRedactor('room:7')).toBeTruthy();
	});

	it('does NOT over-match a topic outside the factory pattern', () => {
		__register('pii/dyn-precise', live.stream((ctx, room) => 'room:' + room, async () => ({}), { merge: 'set', piiRedact: { fields: { ssn: 'omit' } } }));
		expect(_resolveRedactor('room:9')).toBeTruthy();     // matches the pattern
		expect(_resolveRedactor('lobby:9')).toBeNull();      // different namespace - untouched
		expect(_resolveRedactor('room')).toBeNull();         // prefix only, no variable segment
	});

	it('skips a pure pass-through (x) => x topic - no match-everything footgun', () => {
		__register('pii/passthrough', live.stream((x) => x, async () => ({}), { merge: 'set', piiRedact: true }));
		// The derived pattern is {arg0} alone (no literal anchor); registering it
		// would redact every topic, so it is intentionally not registered.
		expect(_declaredRedactPattern.size).toBe(0);
		expect(_resolveRedactor('anything-at-all')).toBeNull();
	});

	it('skips a variable-first factory - no app-wide over-redaction or publish DoS', () => {
		// (ctx, uid, kind) => uid + ':' + kind derives `{arg1}:{arg2}`, whose
		// matcher would be `^.+:.+$` and redact EVERY colon topic. A throwing
		// custom redactor would then drop unrelated streams' publishes entirely.
		// Such a variable-first pattern is skipped, so co-located streams are safe.
		__register('pii/varfirst', live.stream(
			(ctx, uid, kind) => uid + ':' + kind,
			async () => ({}),
			{ merge: 'set', piiRedact: (d) => ({ id: d.user.id }) }   // throws on any shape without `user`
		));
		expect(_declaredRedactPattern.size).toBe(0);
		expect(_resolveRedactor('presence:main')).toBeNull();
		// An unrelated, non-redact publish is untouched (not redacted, not dropped).
		const platform = mockPlatform();
		const ok = _buildCtx(null, null, platform, _getCtxHelpers(platform), null)
			.publish('presence:main', 'set', { secret: 'KEEP-ME', count: 42 });
		expect(ok).not.toBe(false);
		expect(platform.published).toHaveLength(1);
		expect(platform.published[0].data).toEqual({ secret: 'KEEP-ME', count: 42 });
	});

	it('skips a variable-first-with-suffix factory (broad blast radius)', () => {
		// (ctx, x) => x + ':chat' derives `{arg1}:chat` -> `^.+:chat$`, matching
		// any co-located topic ending in :chat; treated like variable-first.
		__register('pii/suffix', live.stream((ctx, x) => x + ':chat', async () => ({}), { merge: 'set', piiRedact: true }));
		expect(_declaredRedactPattern.size).toBe(0);
		expect(_resolveRedactor('room:chat')).toBeNull();
	});

	it('bounds a placeholder to one segment - does not over-match a nested co-located topic', () => {
		// (ctx, room) => 'chat/' + room derives `chat/{arg1}` -> `^chat/[^/:]+$`,
		// which matches the stream's own `chat/5` but NOT a nested non-redact
		// sub-stream like `chat/typing/5` (a greedy `.+` would swallow it).
		__register('pii/nested', live.stream((ctx, room) => 'chat/' + room, async () => ({}), { merge: 'set', piiRedact: { fields: { ssn: 'omit' } } }));
		expect(_resolveRedactor('chat/5')).toBeTruthy();
		expect(_resolveRedactor('chat/typing/5')).toBeNull();
		expect(_resolveRedactor('chat/rooms:9')).toBeNull();
	});

	it('collapses adjacent placeholders so the matcher is not quadratic', () => {
		// (ctx, a, b) => 'foo' + a + b + 'bar' derives `foo{arg1}{arg2}bar`; the
		// two adjacent placeholders must collapse to one segment, never `X+X+`.
		__register('pii/adjacent', live.stream((ctx, a, b) => 'foo' + a + b + 'bar', async () => ({}), { merge: 'set', piiRedact: true }));
		const entry = [..._declaredRedactPattern.values()][0];
		expect(entry.regex.source).toBe('^foo[^/:]+bar$');
		expect(entry.regex.source).not.toContain('[^/:]+[^/:]+');
		expect(entry.regex.test('fooXYbar')).toBe(true);
	});

	it('keeps the full literal prefix when the topic contains a literal brace', () => {
		// `a{b}/` + arg derives `a{b}/{arg1}`; the prefix must be the run up to the
		// PLACEHOLDER (`a{b}/`), not up to the first literal `{`.
		__register('pii/brace', live.stream((ctx, id) => 'a{b}/' + id, async () => ({}), { merge: 'set', piiRedact: true }));
		const entry = [..._declaredRedactPattern.values()][0];
		expect(entry.prefix).toBe('a{b}/');
		expect(_resolveRedactor('a{b}/7')).toBeTruthy();
		expect(_resolveRedactor('other/7')).toBeNull();
	});

	it('warns when two streams derive the same pattern with different redactors', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			__register('pii/dup-a', live.stream((ctx, room) => 'dup:' + room, async () => ({}), { merge: 'set', piiRedact: { fields: { a: 'omit' } } }));
			expect(warn).not.toHaveBeenCalled();   // first declaration is silent
			__register('pii/dup-b', live.stream((ctx, room) => 'dup:' + room, async () => ({}), { merge: 'set', piiRedact: { fields: { b: 'omit' } } }));
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0][0]).toContain('dup:{arg1}');
		} finally {
			warn.mockRestore();
		}
	});

	it('clears the dynamic pattern registry on reset', () => {
		__register('pii/dyn-reset', live.stream((ctx, room) => 'room:' + room, async () => ({}), { merge: 'set', piiRedact: true }));
		expect(_declaredRedactPattern.size).toBeGreaterThan(0);
		_resetRedactRegistry();
		expect(_declaredRedactPattern.size).toBe(0);
	});

	it('redacts a live ctx.publish to a resolved dynamic topic NEVER subscribed on this instance', async () => {
		__register('pii/dyn-live', live.stream((ctx, room) => 'room:' + room, async () => ({}), { merge: 'set', piiRedact: { fields: { ssn: 'omit' } } }));
		// This instance subscribes to room 1 only.
		const ws = mockWs({ id: 'a1' });
		const platform = mockPlatform();
		handleRpc(ws, toArrayBuffer({ rpc: 'pii/dyn-live', id: 's1', args: ['1'], stream: true }), platform);
		await flush();
		expect(_declaredRedact.has('room:2')).toBe(false);   // never subscribed to room 2

		// A publish to room 2 (another origin has that subscriber) - the leak.
		const ctx = _buildCtx(null, null, platform, _getCtxHelpers(platform), null);
		ctx.publish('room:2', 'set', { ssn: '111-22-3333', name: 'Ann' });
		const pub = platform.published.find((p) => p.topic === 'room:2');
		expect(pub).toBeTruthy();
		expect(pub.data).toEqual({ name: 'Ann' });
		expect(JSON.stringify(pub.data)).not.toContain('111-22-3333');
	});

	it('redacts the RELAYED frame for a never-subscribed dynamic topic (cluster-transient)', async () => {
		__register('pii/dyn-relay', live.stream((ctx, room) => 'room:' + room, async () => ({}), { merge: 'set', piiRedact: { fields: { ssn: 'omit' } } }));
		const bus = makeRecordingBus();
		setBus(bus);
		const platform = mockPlatform();
		_activateDerived(platform);          // installs the reactive relay wrap on platform.publish
		state.cronPlatform = platform;       // getPlatform() resolves this for the out-of-band publish()

		// This instance holds a room-1 subscriber; room 2 lives on a peer.
		const ws = mockWs({ id: 'r1' });
		handleRpc(ws, toArrayBuffer({ rpc: 'pii/dyn-relay', id: 's1', args: ['1'], stream: true }), platform);
		await flush();

		// Out-of-band publish to room 2 - relays to the peer that has the subscriber.
		publish('room:2', 'msg', { ssn: '111-22-3333', name: 'Ann' });

		const local = platform.published.find((p) => p.topic === 'room:2');
		const relayed = bus.relays.find((r) => r.topic === 'room:2');
		expect(local).toBeTruthy();
		expect(relayed).toBeTruthy();
		expect(relayed.data).toEqual({ name: 'Ann' });
		// The raw SSN must never leave this instance on the cluster relay.
		expect(JSON.stringify(relayed.data)).not.toContain('111-22-3333');
		expect(JSON.stringify(local.data)).not.toContain('111-22-3333');
	});

	// --- OWNERSHIP guard + FAIL-OPEN: a pattern match is a heuristic and must
	// never strip or drop a co-located stream. ---

	const publishVia = (platform, topic, event, data) =>
		_buildCtx(null, null, platform, _getCtxHelpers(platform), null).publish(topic, event, data);

	it('records every static stream/channel topic in the ownership index', () => {
		__register('pii/own-fac', live.stream((ctx, room) => 'chat/' + room, async () => ({}), { merge: 'set', piiRedact: true }));
		__register('pii/own-chan', live.channel('chat/typing', { merge: 'set' }));
		expect(_declaredStreamTopic.has('chat/typing')).toBe(true);   // the static channel is indexed
		expect(_declaredStreamTopic.has('chat/room1')).toBe(false);   // a resolved factory instance is NOT
	});

	it('does NOT drop a co-located static channel a throwing factory redactor would otherwise swallow', () => {
		// chat/{room} redactor expects the chat shape and throws on anything else.
		__register('pii/chat', live.stream((ctx, room) => 'chat/' + room, async () => ({}), { merge: 'set', piiRedact: (d) => ({ author: d.author.name, text: d.text }) }));
		__register('pii/typing', live.channel('chat/typing', { merge: 'set' }));   // co-located flat sibling
		// Ownership guard: the pattern does not claim the explicitly-declared topic.
		expect(_resolveRedactor('chat/typing')).toBeNull();
		const platform = mockPlatform();
		const ok = publishVia(platform, 'chat/typing', 'set', { user: 'bob', typing: true });
		expect(ok).not.toBe(false);                                    // NOT dropped
		expect(platform.published).toHaveLength(1);
		expect(platform.published[0].data).toEqual({ user: 'bob', typing: true });   // delivered raw
	});

	it('does NOT strip a co-located static sibling field (fields redactor)', () => {
		__register('pii/chat2', live.stream((ctx, room) => 'chat/' + room, async () => ({}), { merge: 'set', piiRedact: { fields: { user: 'omit' }, defaults: false } }));
		__register('pii/typing2', live.channel('chat/typing', { merge: 'set' }));
		expect(_resolveRedactor('chat/typing')).toBeNull();
		const platform = mockPlatform();
		publishVia(platform, 'chat/typing', 'set', { user: 'bob', typing: true });
		expect(platform.published[0].data).toEqual({ user: 'bob', typing: true });   // user NOT stripped
	});

	it('excludes a static sibling in a colon namespace but still covers resolved instances', () => {
		__register('pii/room', live.stream((ctx, id) => 'room:' + id, async () => ({}), { merge: 'set', piiRedact: { fields: { ssn: 'omit' } } }));
		__register('pii/lobby', live.channel('room:lobby', { merge: 'set' }));
		expect(_resolveRedactor('room:lobby')).toBeNull();     // declared static -> excluded
		expect(_resolveRedactor('room:42')).toBeTruthy();      // resolved dynamic instance -> covered
	});

	it('fail-open (ctx.publish): an UNDECLARED matching topic whose redactor throws passes through raw, not dropped', () => {
		__register('pii/chat3', live.stream((ctx, room) => 'chat/' + room, async () => ({}), { merge: 'set', piiRedact: (d) => ({ author: d.author.name }) }));
		expect(_declaredStreamTopic.has('chat/adhoc')).toBe(false);   // not a declared stream
		const entry = _resolveRedactor('chat/adhoc');
		expect(entry).toBeTruthy();
		expect(entry.failOpen).toBe(true);
		const platform = mockPlatform();
		const ok = publishVia(platform, 'chat/adhoc', 'set', { note: 'hi' });   // redactor throws on this shape
		expect(ok).not.toBe(false);                                   // NOT dropped (fail-open)
		expect(platform.published).toHaveLength(1);
		expect(platform.published[0].data).toEqual({ note: 'hi' });   // raw pass-through, = pre-fix baseline
	});

	it('fail-open (_redactOrDrop / deferred path): a throwing pattern match returns the data, not REDACT_DROP', () => {
		__register('pii/chat4', live.stream((ctx, room) => 'chat/' + room, async () => ({}), { merge: 'set', piiRedact: (d) => ({ author: d.author.name }) }));
		const out = _redactOrDrop('chat/adhoc', { note: 'hi' });
		expect(out).not.toBe(REDACT_DROP);
		expect(out).toEqual({ note: 'hi' });
	});

	it('still redacts a real resolved instance when the redactor SUCCEEDS (the fix keeps working)', () => {
		__register('pii/chat5', live.stream((ctx, room) => 'chat/' + room, async () => ({}), { merge: 'set', piiRedact: (d) => ({ text: d.text }) }));
		const platform = mockPlatform();
		publishVia(platform, 'chat/room5', 'set', { text: 'hello', ssn: '111-22-3333' });
		expect(platform.published[0].data).toEqual({ text: 'hello' });   // the factory's own topic still redacts
		expect(JSON.stringify(platform.published[0].data)).not.toContain('111-22-3333');
	});

	it('does NOT index a dynamic factory as a literal (only strings), so resolved instances stay pattern-matchable', () => {
		__register('pii/dyn-c', live.stream((ctx, room) => 'chat/' + room, async () => ({}), { merge: 'set', piiRedact: true }));
		// Only string topics enter the ownership index; the derived pattern skeleton
		// never does. A co-located sibling written as a constant-returning factory is
		// a documented residual - declare co-located topics as strings for ownership.
		expect(_declaredStreamTopic.has('chat/{arg1}')).toBe(false);  // the pattern skeleton is not a literal entry
		expect(_resolveRedactor('chat/anyroom')).toBeTruthy();        // a resolved instance is still covered
	});

	it('clears the ownership index on reset', () => {
		__register('pii/reg', live.stream((ctx, id) => 'x:' + id, async () => ({}), { merge: 'set', piiRedact: true }));
		__register('pii/static', live.channel('x:static', { merge: 'set' }));
		expect(_declaredStreamTopic.size).toBeGreaterThan(0);
		_resetRedactRegistry();
		expect(_declaredStreamTopic.size).toBe(0);
	});
});
