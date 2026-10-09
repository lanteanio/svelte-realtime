import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the adapter client like degradation-client.test.js: capture the `__realtime`
// subscriber so the test can deliver a `protocol-stale` frame; the connection has
// no flow-control input.
const H = vi.hoisted(() => ({ cb: null, statusCb: null, sent: [] }));
vi.mock('svelte-adapter-uws/client', () => {
	const on = (topic) => ({ subscribe: (fn) => { if (topic === '__realtime') H.cb = fn; return () => { H.cb = null; }; } });
	const status = { subscribe: (fn) => { H.statusCb = fn; fn('disconnected'); return () => {}; } };
	const conn = { sendQueued: (value) => H.sent.push(value), on, status };
	return { on, status, connect: () => conn, setTopicManaged: () => {} };
});

import { health, _resetHealth, _ensureHealthSubscription } from '../src/client/health.js';
import { configure } from '../src/client/misc.js';

const deliver = (env) => { if (H.cb) H.cb(env); };

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

	it('advertises synchronously before normal and hidden-tab reconnect work', () => {
		configure({
			protocolVersion: 3,
			onConnect: () => H.sent.push('onConnect')
		});
		expect(typeof H.statusCb).toBe('function');
		// Adapter onopen sets `suspended` synchronously when the document is hidden,
		// then continues with hello/resubscribe/sendQueue. The proto must already be
		// queued at that boundary, without running visible-app reconnect work.
		H.statusCb('suspended');
		H.sent.push('adapter-onopen-continues');
		expect(H.sent).toEqual([
			{ type: 'proto', v: 3 },
			'adapter-onopen-continues'
		]);

		H.sent.length = 0;
		H.statusCb('open');
		expect(H.sent).toEqual([
			{ type: 'proto', v: 3 },
			'onConnect'
		]);
	});

	it('configure rejects a non-integer protocolVersion (symmetric with realtime() on the server)', () => {
		expect(() => configure({ protocolVersion: 1.5 })).toThrow(/integer/);
		expect(() => configure({ protocolVersion: null })).toThrow(/integer/);
	});
});
