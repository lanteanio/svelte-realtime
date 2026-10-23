import { afterEach, describe, expect, it, vi } from 'vitest';
import { live, __register, __registerFlag, _activateDerived, handleRpc, _prepareHmr, _restoreHmr } from '../src/server.js';
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

/** A lazy registry entry that runs `steps` in order, one per load. */
function scripted(steps) {
	let attempts = 0;
	const loader = async () => steps[Math.min(attempts++, steps.length - 1)]();
	loader.__lazy = true;
	return { loader, attempts: () => attempts };
}

describe('reporting live module load failures', () => {
	it('passes every failure to onError and reports each distinct failure once', async () => {
		const events = [];
		cleanups.push(setOperationalEventSink(record => events.push(record)));
		const fail = message => () => { throw new SyntaxError(message); };
		const entry = scripted([fail('first'), fail('first'), () => live(() => 'ok'), fail('first')]);
		__register('reported/echo', entry.loader);
		const errors = [];
		const onError = (path, error, ctx) => errors.push({ path, message: error.message, user: ctx.user.id });
		const ws = mockWs({ id: 'member' });
		const platform = mockPlatform();
		const loadFailures = () => events.filter(record => record.event === 'rpc.module.load-failed').length;

		handleRpc(ws, frame({ rpc: 'reported/echo', id: 'a', args: [] }), platform, { onError });
		await flush();
		handleRpc(ws, frame({ rpc: 'reported/echo', id: 'b', args: [] }), platform, { onError });
		await flush();
		expect(errors).toEqual([
			{ path: 'reported/echo', message: 'first', user: 'member' },
			{ path: 'reported/echo', message: 'first', user: 'member' }
		]);
		expect(loadFailures()).toBe(1);

		// A successful load caches the handler; a later failure of the same
		// path, after it is registered lazily again, reports again.
		handleRpc(ws, frame({ rpc: 'reported/echo', id: 'c', args: [] }), platform, { onError });
		await flush();
		expect(platform.sent.find(item => item.data?.id === 'c').data).toMatchObject({ ok: true, data: 'ok' });
		__register('reported/echo', entry.loader);
		handleRpc(ws, frame({ rpc: 'reported/echo', id: 'd', args: [] }), platform, { onError });
		await flush();
		expect(loadFailures()).toBe(2);
		expect(errors).toHaveLength(3);
	});

	it('loads a lazy module once per fire-and-forget call and still warns about an unmarked handler', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		cleanups.push(() => warn.mockRestore());
		cleanups.push(setOperationalEventSink(() => {}));
		const failing = scripted([() => { throw new SyntaxError('broken'); }]);
		__register('volatile/broken', failing.loader);
		const unmarked = scripted([() => live(() => undefined)]);
		__register('volatile/unmarked', unmarked.loader);
		const ws = mockWs({ id: 'member' });
		const platform = mockPlatform();

		handleRpc(ws, frame({ rpc: 'volatile/broken', args: [] }), platform);
		await flush();
		expect(failing.attempts()).toBe(1);

		handleRpc(ws, frame({ rpc: 'volatile/unmarked', args: [] }), platform);
		await flush();
		expect(unmarked.attempts()).toBe(1);
		expect(warn.mock.calls.filter(args => /not marked live\.volatile/.test(String(args[0])))).toHaveLength(1);
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
	it.each([
		['registers nothing', () => {}],
		['registers the flag again before the edited module fails', () => __registerFlag('flag:hmr-kept', 'idle')]
	])('keeps flags following cluster sets when the failed reload %s', async (_label, failedReload) => {
		const platform = mockPlatform();
		_activateDerived(platform);
		__registerFlag('flag:hmr-kept', 'idle');
		const flag = live.flag('flag:hmr-kept', 'idle');
		const snapshot = _prepareHmr();
		failedReload();
		_restoreHmr(snapshot);

		platform.publish('flag:hmr-kept', 'set', 'active');
		await flush();
		expect(flag.get()).toBe('active');
		platform.publish('flag:hmr-kept', 'set', 'idle');
		await flush();
		expect(flag.get()).toBe('idle');
	});
});
