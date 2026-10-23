import { describe, expect, it } from 'vitest';
import { entriesFor, matchKnown, RELOAD, SPLIT } from './kit-compat/known-failures.mjs';

const hooksCheck = 'deleted and recreated hooks.ws restore live handlers and shared state';
const routeCheck = 'route-only HMR shares HTTP and WebSocket state';
const stale = 'Error: ' + RELOAD + ': a new connection did not reach the expected state: connection {"id":"compat-120","ok":true,"data":"compatibility-test-edited"}';

describe('known adapter failure matching', () => {
	const kit2 = entriesFor('0.6.0-next.96', 'kit2-dev-hmr');
	const kit3 = entriesFor('0.6.0-next.96', 'kit3-dev-hmr');

	it('accepts the adapter serving the previous hooks handler', () => {
		expect(matchKnown(kit2, hooksCheck, stale)).toBeGreaterThanOrEqual(0);
	});

	it('fails a recreated hooks file that lost its live handlers', () => {
		const forbidden = 'Error: ' + RELOAD + ': a new connection did not reach the expected state: connection {"id":"compat-120","ok":false,"code":"FORBIDDEN","error":"Access denied"}';
		const timedOut = 'Error: ' + RELOAD + ': a new connection did not reach the expected state: connection RPC timed out: connection';
		expect(matchKnown(kit2, hooksCheck, forbidden)).toBe(-1);
		expect(matchKnown(kit2, hooksCheck, timedOut)).toBe(-1);
	});

	it('accepts a route-only split only with the instance signature', () => {
		const split = 'Error: ' + SPLIT + ': a page store differs from the HTTP count 5 (HTTP instance a, WebSocket instance b)';
		const unsigned = 'Error: a page store differs from the HTTP count 5 (HTTP instance a, WebSocket instance a)';
		expect(matchKnown(kit3, routeCheck, split)).toBeGreaterThanOrEqual(0);
		expect(matchKnown(kit3, routeCheck, unsigned)).toBe(-1);
	});

	it('applies entries only to the runs and adapter that reproduce them', () => {
		expect(matchKnown(kit2, routeCheck, 'Error: ' + SPLIT)).toBe(-1);
		expect(entriesFor('0.6.0-next.97', 'kit2-dev-hmr')).toEqual([]);
		expect(entriesFor('0.6.0-next.96', 'kit2-production')).toEqual([]);
	});
});
