import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the adapter client like degradation-client.test.js: capture the `__realtime`
// subscriber so the test can deliver a `protocol-stale` frame; the connection has
// no flow-control input.
const H = vi.hoisted(() => ({ cb: null, statusSubs: [], status: 'disconnected', sent: [] }));
vi.mock('svelte-adapter-uws/client', () => {
	const on = (topic) => ({ subscribe: (fn) => { if (topic === '__realtime') H.cb = fn; return () => { H.cb = null; }; } });
	// Every status subscriber hears every change, in subscription order, as the
	// adapter's store delivers them.
	const status = {
		subscribe: (fn) => {
			H.statusSubs.push(fn);
			fn(H.status);
			return () => { H.statusSubs.splice(H.statusSubs.indexOf(fn), 1); };
		}
	};
	const conn = { send: (value) => H.sent.push(value), sendQueued: (value) => H.sent.push(value), on, status };
	return { on, status, connect: () => conn, setTopicManaged: () => {} };
});

import { status as adapterStatus } from 'svelte-adapter-uws/client';
import { health, _resetHealth, _ensureHealthSubscription } from '../src/client/health.js';
import { configure } from '../src/client/misc.js';

const deliver = (env) => { if (H.cb) H.cb(env); };
const setStatus = (s) => {
	H.status = s;
	for (const fn of [...H.statusSubs]) fn(s);
};

describe('protocol-compat signal: client health', () => {
	beforeEach(() => { _resetHealth(); H.cb = null; H.sent.length = 0; });

	it('flips health to outdated on a protocol-stale event', () => {
		let h;
		const u = health.subscribe((v) => { h = v; });
		deliver({ event: 'protocol-stale', data: { server: 2, client: 1 } });
		expect(h).toBe('outdated');
		u();
	});

	it('outdated is sticky: a later degraded / recovered does not clear it', () => {
		let h;
		const u = health.subscribe((v) => { h = v; });
		deliver({ event: 'protocol-stale', data: { server: 2, client: 1 } });
		expect(h).toBe('outdated');
		deliver({ event: 'degraded', data: {} });
		expect(h).toBe('outdated');
		deliver({ event: 'recovered', data: {} });
		expect(h).toBe('outdated');
		u();
	});

	it('surfaces a strict rollback/missing mismatch as sticky incompatible', () => {
		let h;
		const u = health.subscribe((v) => { h = v; });
		deliver({
			event: 'protocol-mismatch',
			data: { code: 'PROTOCOL_MISMATCH', reason: 'too-new', client: 4, server: { current: 3, minimum: 2 } }
		});
		expect(h).toBe('incompatible');
		deliver({ event: 'recovered', data: {} });
		expect(h).toBe('incompatible');
		u();
	});

	it('warns once with the strict mismatch range and reason', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const u = health.subscribe(() => {});
		deliver({
			event: 'protocol-mismatch',
			data: { reason: 'missing', client: null, server: { current: 3, minimum: 2 } }
		});
		deliver({
			event: 'protocol-mismatch',
			data: { reason: 'too-old', client: 1, server: { current: 3, minimum: 2 } }
		});
		const mismatchWarns = warn.mock.calls.filter((c) => String(c[0]).includes('protocol-incompatible'));
		expect(mismatchWarns).toHaveLength(1);
		expect(String(mismatchWarns[0][0])).toContain('reason=missing');
		warn.mockRestore();
		u();
	});

	it('warns once in dev on protocol-stale', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const u = health.subscribe(() => {});
		deliver({ event: 'protocol-stale', data: { server: 2, client: 1 } });
		deliver({ event: 'protocol-stale', data: { server: 3, client: 1 } });
		const staleWarns = warn.mock.calls.filter((c) => String(c[0]).includes('outdated bundle'));
		expect(staleWarns).toHaveLength(1);
		warn.mockRestore();
		u();
	});

	it('_ensureHealthSubscription activates the __realtime listener without a health subscriber', () => {
		// The configure({ protocolVersion }) opt-in path calls this so the signal is
		// observed even if the app never reads the health store directly.
		_ensureHealthSubscription();
		expect(typeof H.cb).toBe('function');
	});

	it('advertises once per socket, before any other status subscriber sends', () => {
		// Bind the connection first, then attach app work the way a stream created
		// before configure() does: its status subscriber runs ahead of configure's.
		_ensureHealthSubscription();
		adapterStatus.subscribe((s) => { if (s === 'open' || s === 'suspended') H.sent.push('app-work'); });
		configure({
			protocolVersion: 3,
			onConnect: () => H.sent.push('onConnect')
		});
		// Adapter onopen sets `suspended` synchronously when the document is hidden,
		// then continues with hello/resubscribe/sendQueue. The proto must already be
		// sent at that boundary, without running visible-app reconnect work.
		setStatus('suspended');
		H.sent.push('adapter-onopen-continues');
		expect(H.sent).toEqual([
			{ type: 'proto', v: 3 },
			'app-work',
			'adapter-onopen-continues'
		]);

		// The tab comes back on the same socket; the server already has the version.
		H.sent.length = 0;
		setStatus('open');
		expect(H.sent).toEqual(['app-work', 'onConnect']);

		// A new socket after a drop advertises again, ahead of everything else.
		H.sent.length = 0;
		setStatus('disconnected');
		setStatus('open');
		expect(H.sent).toEqual([
			{ type: 'proto', v: 3 },
			'app-work',
			'onConnect'
		]);
	});

	it('configure rejects a non-integer protocolVersion (symmetric with realtime() on the server)', () => {
		expect(() => configure({ protocolVersion: 1.5 })).toThrow(/integer/);
		expect(() => configure({ protocolVersion: null })).toThrow(/integer/);
	});
});
