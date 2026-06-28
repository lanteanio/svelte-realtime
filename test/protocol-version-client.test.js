import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the adapter client like degradation-client.test.js: capture the `__realtime`
// subscriber so the test can deliver a `protocol-stale` frame; connect() returns a
// stub with no flow-control input.
const H = vi.hoisted(() => ({ cb: null }));
vi.mock('svelte-adapter-uws/client', () => ({
	on: (topic) => ({ subscribe: (fn) => { if (topic === '__realtime') H.cb = fn; return () => { H.cb = null; }; } }),
	connect: () => null
}));

import { health, _resetHealth, _ensureHealthSubscription } from '../src/client/health.js';
import { configure } from '../src/client/misc.js';

const deliver = (env) => { if (H.cb) H.cb(env); };

describe('protocol-compat signal: client health', () => {
	beforeEach(() => { _resetHealth(); H.cb = null; });

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

	it('configure rejects a non-integer protocolVersion (symmetric with realtime() on the server)', () => {
		expect(() => configure({ protocolVersion: 1.5 })).toThrow(/integer/);
		expect(() => configure({ protocolVersion: null })).toThrow(/integer/);
	});
});
