import { afterEach, describe, expect, it } from 'vitest';
import { live, __register, handleRpc, _prepareHmr, _restoreHmr } from '../src/server.js';
import { setOperationalEventSink } from '../src/shared/diagnostic.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { mockWs } from './helpers/mock-ws.js';

const cleanups = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); _prepareHmr(); });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const frame = (body) => new TextEncoder().encode(JSON.stringify(body)).buffer;

/** A lazy registry entry, as the Vite registry emits it, that fails to load once. */
function failingOnce(fn) {
	let attempts = 0;
	const loader = async () => {
		attempts++;
		if (attempts === 1) throw new SyntaxError('Unexpected token in live module');
		return fn;
	};
	loader.__lazy = true;
	return { loader, attempts: () => attempts };
}

function watchUnhandled() {
	const reasons = [];
	const onUnhandled = reason => reasons.push(reason);
	process.on('unhandledRejection', onUnhandled);
	cleanups.push(() => process.off('unhandledRejection', onUnhandled));
	return reasons;
}

describe('live modules that fail to load', () => {
	it.each([
		['an RPC', { rpc: 'broken/echo', id: 'first', args: ['x'] }],
		['a stream subscribe', { rpc: 'broken/echo', id: 'first', args: ['x'], stream: true }]
	])('answers %s with an internal error and loads the module on the next call', async (_label, request) => {
		const unhandled = watchUnhandled();
		const events = [];
		cleanups.push(setOperationalEventSink(record => events.push(record)));
		const entry = failingOnce(live((_ctx, value) => ({ value })));
		__register('broken/echo', entry.loader);
		const ws = mockWs({ id: 'member' });
		const platform = mockPlatform();

		handleRpc(ws, frame(request), platform);
		await flush();
		await new Promise(resolve => setImmediate(resolve));
		const failed = platform.sent.find(item => item.data?.id === 'first').data;
		expect(failed).toMatchObject({ ok: false, code: 'INTERNAL_ERROR', error: 'Internal server error' });
		expect(JSON.stringify(failed)).not.toMatch(/Unexpected token/);
		expect(events.find(record => record.event === 'rpc.module.load-failed')).toMatchObject({
			severity: 'error',
			attributes: { path: 'broken/echo', error: { name: 'SyntaxError' } }
		});
		expect(unhandled).toEqual([]);

		handleRpc(ws, frame({ rpc: 'broken/echo', id: 'second', args: ['y'] }), platform);
		await flush();
		expect(platform.sent.find(item => item.data?.id === 'second').data).toMatchObject({ ok: true, data: { value: 'y' } });
		expect(entry.attempts()).toBe(2);
	});
});

describe('a development reload that fails', () => {
	it('restores the previous handlers without keeping what the failed reload registered', async () => {
		__register('hmr/kept', live(() => 'kept'));
		const snapshot = _prepareHmr();
		// The reload registers the regenerated registry, then the edited module fails.
		__register('hmr/partial', live(() => 'partial'));
		_restoreHmr(snapshot);
		const ws = mockWs({ id: 'member' });
		const platform = mockPlatform();
		handleRpc(ws, frame({ rpc: 'hmr/kept', id: 'kept', args: [] }), platform);
		handleRpc(ws, frame({ rpc: 'hmr/partial', id: 'partial', args: [] }), platform);
		await flush();
		expect(platform.sent.find(item => item.data?.id === 'kept').data).toMatchObject({ ok: true, data: 'kept' });
		// An unregistered path: NOT_FOUND, or the masked guard reply under maskNotFound.
		const partial = platform.sent.find(item => item.data?.id === 'partial').data;
		expect(partial.ok).toBe(false);
		expect(['NOT_FOUND', 'FORBIDDEN', 'UNAUTHENTICATED']).toContain(partial.code);
	});
});
