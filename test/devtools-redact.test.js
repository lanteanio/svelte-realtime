// The devtools redactKeys mitigation must cover the RPC and volatile
// capture paths, not just stream events. _devtoolsStart / _devtoolsEnd /
// _devtoolsVolatileSent store args and results in window-reachable rings
// (window.__svelte_realtime_devtools), so credential-carrying calls like
// login({ password }) must land there redacted, exactly as stream-event
// payloads already do.

import { describe, it, expect } from 'vitest';
import {
	__devtools,
	_devtoolsStart,
	_devtoolsEnd,
	_devtoolsVolatileSent,
	_devtoolsStream,
	_devtoolsStreamEvent,
	_devtoolsStreamError
} from '../src/client/devtools-instrument.js';

// Under vitest `import.meta.env.PROD` is literally `!!process.env.PROD`, and both
// PROD and NODE_ENV are set with `??=`, so an ambient value in the shell survives.
// That compiles the instrumentation out and fails every test here at once - with
// no hint as to why, unless we supply one.
const GATE = 'devtools instrumentation is off - is PROD or NODE_ENV set in this shell?';

describe('devtools redaction on the RPC/volatile paths', () => {
	it('redacts pending args while the RPC is in flight', () => {
		// Asserted rather than skipped. `if (!__devtools) return` turns every test in
		// this file into a green no-op the moment instrumentation is absent - which is
		// precisely the case where the redaction it covers would go untested. There is
		// no production-mode run of this suite, so a null here means something broke.
		expect(__devtools, GATE).toBeTruthy();
		_devtoolsStart('auth/login', 'dt-1', [{ username: 'alice', password: 'hunter2-PASS', token: 'sk-live-TOKEN' }]);
		const pending = __devtools.pending.get('dt-1');
		expect(pending.args[0].username).toBe('alice');
		expect(pending.args[0].password).toBe('[REDACTED]');
		expect(pending.args[0].token).toBe('[REDACTED]');
	});

	it('redacts args AND result in the history ring on completion', () => {
		expect(__devtools, GATE).toBeTruthy();
		_devtoolsStart('auth/login', 'dt-2', [{ password: 'hunter2-PASS' }]);
		_devtoolsEnd('dt-2', true, { token: 'sess-SECRET', profile: { name: 'alice' } });
		const hist = __devtools.history.filter(Boolean).at(-1);
		expect(hist.args[0].password).toBe('[REDACTED]');
		// `token` is in the default redactKeys (exact full-key match, like
		// stream events); a non-matching sibling key stays readable.
		expect(hist.result.token).toBe('[REDACTED]');
		expect(hist.result.profile.name).toBe('alice');
		// The pending entry is consumed on completion.
		expect(__devtools.pending.has('dt-2')).toBe(false);
	});

	it('redacts volatile (fire-and-forget) send args', () => {
		expect(__devtools, GATE).toBeTruthy();
		_devtoolsVolatileSent('account/updatePassword', [{ password: 'hunter2-PASS', csrf: 'csrf-SECRET', note: 'hi' }]);
		const vol = __devtools.volatile.filter(Boolean).at(-1);
		expect(vol.args[0].password).toBe('[REDACTED]');
		expect(vol.args[0].csrf).toBe('[REDACTED]');
		expect(vol.args[0].note).toBe('hi');
	});

	it('honors an app-extended redactKeys set on the RPC path, like stream events', () => {
		expect(__devtools, GATE).toBeTruthy();
		__devtools.redactKeys.add('api_secret');
		try {
			_devtoolsStart('keys/rotate', 'dt-3', [{ api_secret: 'shh', other: 1 }]);
			expect(__devtools.pending.get('dt-3').args[0].api_secret).toBe('[REDACTED]');
			expect(__devtools.pending.get('dt-3').args[0].other).toBe(1);
		} finally {
			__devtools.redactKeys.delete('api_secret');
		}
	});

	// message/stack are own but NON-enumerable on an Error, so a generic
	// Object.keys walk drops them - and a failed call in the history ring with no
	// reason attached is useless for the thing devtools exists to do.
	it('keeps an Error result readable while still redacting it', () => {
		expect(__devtools, GATE).toBeTruthy();
		_devtoolsStart('auth/login', 'dt-err', [{ user: 'alice' }]);
		const err = Object.assign(new Error('bad password for alice'), { code: 'UNAUTHENTICATED', issues: ['nope'] });
		_devtoolsEnd('dt-err', false, err);
		const hist = __devtools.history.filter(Boolean).at(-1);
		expect(hist.ok).toBe(false);
		expect(hist.result.message).toBe('bad password for alice');
		expect(hist.result.code).toBe('UNAUTHENTICATED');
		expect(hist.result.issues).toEqual(['nope']);
	});

	// Documents the LIMIT rather than a protection: redaction is key-based, so a
	// bare error string cannot be blanked and is captured verbatim. Pinned here
	// so nobody re-adds a redactor call that would be a no-op and reads as a
	// guarantee in review.
	it('captures a stream error message verbatim - key-based redaction cannot blank a string', () => {
		expect(__devtools, GATE).toBeTruthy();
		_devtoolsStream('chat/secure', 'chat', 1, 'crud');
		_devtoolsStreamError('chat/secure', { code: 'FORBIDDEN', message: "invalid password 'hunter2'" });
		const e = __devtools.streams.get('chat/secure');
		expect(e.error.code).toBe('FORBIDDEN');
		expect(e.error.message).toBe("invalid password 'hunter2'");
		_devtoolsStreamError('chat/secure', null);
		expect(e.error).toBe(null);
	});

	// The result branch claims `stack` is not kept. On a real Error that holds for
	// free (stack is own but NON-enumerable, so the spread cannot see it) - but the
	// duck-typed cross-realm shape the branch exists to catch carries `stack` as an
	// own ENUMERABLE property. Both shapes are pinned, because only one of them
	// ever needed the explicit drop and a reader cannot tell that from the comment.
	it('drops the stack for a real Error AND for a duck-typed cross-realm error', () => {
		expect(__devtools, GATE).toBeTruthy();
		_devtoolsStart('x/real', 'dt-stack-1', []);
		_devtoolsEnd('dt-stack-1', false, new Error('boom-real'));
		const real = __devtools.history.filter(Boolean).at(-1);
		expect(real.result.message).toBe('boom-real');
		expect('stack' in real.result).toBe(false);

		_devtoolsStart('x/duck', 'dt-stack-2', []);
		_devtoolsEnd('dt-stack-2', false, {
			name: 'Error',
			message: 'boom-duck',
			stack: 'Error: boom-duck\n    at /srv/app/secret-path.js:42',
			issues: [{ field: 'email' }]
		});
		const duck = __devtools.history.filter(Boolean).at(-1);
		expect(duck.result.message).toBe('boom-duck');
		expect('stack' in duck.result).toBe(false);
		// Own enumerable extras still come through - dropping stack must not drop them.
		expect(duck.result.issues).toEqual([{ field: 'email' }]);
	});

	// Dropping `stack` only at the top level is not enough: an error chain
	// (`err.cause.stack`) or a back-reference (`err.self === err`) walks straight
	// past it and puts the trace in the ring anyway.
	it('drops a nested stack reached through a cause chain or a back-reference', () => {
		expect(__devtools, GATE).toBeTruthy();
		const newest = () => __devtools.history.filter(Boolean).sort((a, b) => a.seq - b.seq).at(-1);

		_devtoolsStart('x/cause', 'dt-cause', []);
		_devtoolsEnd('dt-cause', false, {
			name: 'Error', message: 'outer', stack: 'OUTER at /srv/a.js:1',
			cause: { name: 'Error', message: 'inner', stack: 'INNER at /srv/secret.js:42' }
		});
		const c = newest().result;
		expect(c.message).toBe('outer');
		expect('stack' in c).toBe(false);
		expect(c.cause.message).toBe('inner');
		expect('stack' in c.cause).toBe(false);

		const e = { name: 'Error', message: 'boom', stack: 'SELF at /srv/secret.js:9' };
		e.self = e;
		_devtoolsStart('x/self', 'dt-self', []);
		_devtoolsEnd('dt-self', false, e);
		const s = newest().result;
		expect('stack' in s).toBe(false);
		expect('stack' in (s.self || {})).toBe(false);
	});

	// A SUCCESSFUL call may legitimately resolve to error-shaped data (an error-log
	// row). Treating that as an error would silently delete a field the server
	// really returned - the one thing the panel must not do.
	it('leaves an error-shaped SUCCESS result intact, including its stack field', () => {
		expect(__devtools, GATE).toBeTruthy();
		_devtoolsStart('logs/get', 'dt-ok', []);
		_devtoolsEnd('dt-ok', true, { id: 7, message: 'NPE in checkout', stack: 'at foo.js:1', level: 'error' });
		const r = __devtools.history.filter(Boolean).sort((a, b) => a.seq - b.seq).at(-1).result;
		expect(r.stack).toBe('at foo.js:1');
		expect(r.id).toBe(7);
		expect(r.level).toBe('error');
	});

	// The match was case-insensitive on the payload key only, never on the SET, so
	// the extension the README documents (`redactKeys.add('paymentMethod')`) silently
	// did nothing. The defaults are all lowercase, which is why it held together.
	it('honours a mixed-case redactKeys entry, as the documented extension implies', () => {
		expect(__devtools, GATE).toBeTruthy();
		__devtools.redactKeys.add('paymentMethod');
		try {
			_devtoolsStart('checkout/pay', 'dt-case', [{ paymentMethod: '4111-1111-1111-1111', note: 'keep' }]);
			const args = __devtools.pending.get('dt-case').args;
			expect(args[0].paymentMethod).toBe('[REDACTED]');
			expect(args[0].note).toBe('keep');
		} finally {
			__devtools.redactKeys.delete('paymentMethod');
		}
	});

	// _devtoolsEnd runs inside the RPC settle wrapper, BEFORE the real reject. A
	// throwing `stack` accessor (a broken source-map hook, a locked-down realm)
	// must not propagate, or the caller's promise never settles at all.
	it('does not propagate a throwing stack accessor into the settle path', () => {
		expect(__devtools, GATE).toBeTruthy();
		const bad = new Error('lazy');
		Object.defineProperty(bad, 'stack', { get() { throw new Error('stack read blew up'); }, configurable: true });
		_devtoolsStart('x/lazy', 'dt-lazy', []);
		expect(() => _devtoolsEnd('dt-lazy', false, bad)).not.toThrow();
	});

	// The real-Error case above is the EASY half: `instanceof Error` short-circuits
	// the shape probe, so the throwing accessor is never read. The duck-typed
	// cross-realm shape - the one this branch exists for - fails `instanceof`, so
	// the probe evaluates `typeof result.stack` itself and the getter fires. An
	// object-literal getter is also ENUMERABLE, so the extras walk reads it too.
	it('does not propagate a throwing stack accessor on a duck-typed cross-realm error', () => {
		expect(__devtools, GATE).toBeTruthy();
		const duck = {
			name: 'Error',
			message: 'lazy-duck',
			get stack() { throw new Error('stack read blew up'); }
		};
		_devtoolsStart('x/lazy-duck', 'dt-lazy-2', []);
		expect(() => _devtoolsEnd('dt-lazy-2', false, duck)).not.toThrow();
		// ...and the call is still recorded, so the panel does not lose it.
		const rec = __devtools.history.filter(Boolean).sort((a, b) => a.seq - b.seq).at(-1);
		expect(rec.path).toBe('x/lazy-duck');
		expect(rec.ok).toBe(false);
	});

	// A throwing accessor on any OTHER own enumerable key must not escape either:
	// the extras walk reads every own key, not just `stack`.
	it('does not propagate a throwing accessor on a non-stack field', () => {
		expect(__devtools, GATE).toBeTruthy();
		const duck = {
			name: 'Error',
			message: 'bad-extra',
			stack: 'at x.js:1',
			get detail() { throw new Error('detail read blew up'); }
		};
		_devtoolsStart('x/bad-extra', 'dt-lazy-3', []);
		expect(() => _devtoolsEnd('dt-lazy-3', false, duck)).not.toThrow();
	});

	// The two tests above both land in the ERROR branch, which reads own keys
	// through its own guard. The generic walk is a separate code path - a
	// SUCCESSFUL result, or any non-error-shaped value - and it reads properties
	// too, so it needs its own guard and its own test. (Found by mutation testing:
	// removing the walk's guard left both tests above green.)
	it('does not propagate a throwing accessor on a plain, non-error result', () => {
		expect(__devtools, GATE).toBeTruthy();
		const obj = { keep: 1, get boom() { throw new Error('read blew up'); } };
		_devtoolsStart('x/plain-throw', 'dt-plain', []);
		expect(() => _devtoolsEnd('dt-plain', true, obj)).not.toThrow();
		const rec = __devtools.history.filter(Boolean).sort((a, b) => a.seq - b.seq).at(-1);
		expect(rec.result.keep).toBe(1);
		expect(rec.result.boom).toBe('[unreadable]');
	});

	it('still redacts stream events (the pre-existing mitigation is unchanged)', () => {
		expect(__devtools, GATE).toBeTruthy();
		_devtoolsStream('chat/messages', 'chat', 1, 'crud');
		_devtoolsStreamEvent('chat/messages', 'created', { id: 1, password: 'hunter2-PASS', text: 'hi' });
		const evt = __devtools.streams.get('chat/messages').recentEvents.at(-1);
		expect(evt.data.password).toBe('[REDACTED]');
		expect(evt.data.text).toBe('hi');
	});
});
