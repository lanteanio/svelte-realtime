// piiRedact: uniform PII / sensitive-field redaction on a stream's wire egress.
// Covers the pure redactor (createPiiRedactor) plus the live-publish,
// redact-before-buffer, initial-load, fail-closed, and registry-cleanup paths.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPiiRedactor, SENSITIVE_KEY_RE } from '../src/server/pii-redact.js';
import { live, __register, handleRpc, close, publish, _resetRedactRegistry } from '../src/server.js';
import { _buildCtx, _getCtxHelpers } from '../src/server/ctx.js';
import { _topicRedact, _declaredRedact, state } from '../src/server/state.js';
import { _registerReplayTopic, _resetReplayRouting } from '../src/server/replay-routing.js';
import { _redactOrDrop, _resolveRedactor } from '../src/server/publish-helpers.js';
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
