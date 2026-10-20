import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { resolve } from 'node:path';
import { createCircuitBreaker } from 'svelte-adapter-uws-extensions/breaker';
import { live, __register, handleRpc, _prepareHmr } from '../src/server.js';
import { setOperationalEventSink } from '../src/shared/diagnostic.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { mockWs } from './helpers/mock-ws.js';

const cleanups = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); _prepareHmr(); vi.useRealTimers(); });
function breaker() {
	const cb = createCircuitBreaker({ failureThreshold: 1, resetTimeout: 60000 });
	cleanups.push(() => cb.destroy());
	return cb;
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

describe('circuit breaker integration', () => {
	it.each([undefined, null, {}, { state: 'broken' }, { guard: true }, { isOpen: false }])('rejects an unsupported breaker at registration: %j', (cb) => {
		const operation = vi.fn();
		expect(() => live.breaker({ breaker: cb, fallback: [] }, operation))
			.toThrow(expect.objectContaining({ code: 'VALIDATION' }));
		expect(operation).not.toHaveBeenCalled();
	});

	it('honors the canonical guard and preserves fallback without running the handler', async () => {
		const cb = breaker();
		cb.failure(new Error('database connection failed'));
		const events = [];
		cleanups.push(setOperationalEventSink(record => events.push(record)));
		const operation = vi.fn(() => 'private result');
		const wrapped = live.breaker({ breaker: cb, name: 'database', fallback: [] }, operation);
		await expect(wrapped({})).resolves.toEqual([]);
		await expect(wrapped({})).resolves.toEqual([]);
		expect(operation).not.toHaveBeenCalled();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ event: 'breaker.open', attributes: { name: 'database', state: 'open', openObservedAt: expect.any(Number) } });
	});

	it('sends actionable availability copy without operator state on the wire', async () => {
		cleanups.push(setOperationalEventSink(() => {}));
		const ws = mockWs({ id: 'member' });
		const platform = mockPlatform();
		const cb = { isOpen: () => true };
		__register('availability/work', live(live.breaker({ breaker: cb, name: 'private-database' }, () => 'unreachable')));
		handleRpc(ws, new TextEncoder().encode(JSON.stringify({ rpc: 'availability/work', id: 'request', args: [] })).buffer, platform);
		await flush();
		const response = platform.sent.find(item => item.data?.id === 'request').data;
		expect(response).toMatchObject({ ok: false, code: 'SERVICE_UNAVAILABLE', error: 'Service is temporarily unavailable, try again shortly' });
		expect(JSON.stringify(response)).not.toMatch(/private-database|circuit|openObservedAt/);
	});

	it('records the actual handler error and resumes after the breaker resets', async () => {
		const cb = breaker();
		const failure = vi.spyOn(cb, 'failure');
		const problem = new Error('database unavailable');
		const operation = vi.fn().mockRejectedValueOnce(problem).mockResolvedValue('ready');
		const wrapped = live.breaker({ breaker: cb }, operation);
		await expect(wrapped({})).rejects.toBe(problem);
		expect(failure).toHaveBeenCalledWith(problem);
		expect(cb.state).toBe('broken');
		cb.reset();
		await expect(wrapped({})).resolves.toBe('ready');
		expect(cb.state).toBe('healthy');
	});

	it('does not mistake an unrelated guard error for an open circuit', async () => {
		const problem = new Error('invalid breaker configuration');
		const operation = vi.fn();
		const wrapped = live.breaker({ breaker: { guard() { throw problem; } }, fallback: [] }, operation);
		await expect(wrapped({})).rejects.toBe(problem);
		expect(operation).not.toHaveBeenCalled();
	});
	it('admits only the recovery probe budget and resumes after success', async () => {
		vi.useFakeTimers();
		cleanups.push(setOperationalEventSink(() => {}));
		const cb = breaker();
		cb.failure(new Error('backend down'));
		await vi.advanceTimersByTimeAsync(60000);
		let resolve;
		const operation = vi.fn(() => new Promise(done => { resolve = done; }));
		const wrapped = live.breaker({ breaker: cb, fallback: 'waiting' }, operation);
		const first = wrapped({});
		await expect(wrapped({})).resolves.toBe('waiting');
		expect(operation).toHaveBeenCalledTimes(1);
		resolve('recovered');
		await expect(first).resolves.toBe('recovered');
		expect(cb.state).toBe('healthy');
		operation.mockResolvedValue('ready');
		await expect(wrapped({})).resolves.toBe('ready');
	});

	it('reports a fresh refusal after an admitted operation and bounds its operator name', async () => {
		const events = [];
		cleanups.push(setOperationalEventSink(record => events.push(record)));
		let open = true;
		const wrapped = live.breaker({ breaker: { isOpen: () => open }, name: 'x'.repeat(200), fallback: null }, () => 'ready');
		await wrapped({});
		await wrapped({});
		open = false;
		await wrapped({});
		open = true;
		await wrapped({});
		expect(events).toHaveLength(2);
		expect(events[0].attributes.name).toHaveLength(120);
	});

	it('preserves the fallback even when both a diagnostic sink and its console fallback fail', async () => {
		cleanups.push(setOperationalEventSink(() => { throw new Error('sink unavailable'); }));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('console unavailable'); });
		cleanups.push(() => warn.mockRestore());
		const wrapped = live.breaker({ breaker: { isOpen: () => true }, fallback: () => 'waiting' }, vi.fn());
		await expect(wrapped({})).resolves.toBe('waiting');
	});

	it.each(['guard', 'isOpen'])('preserves context, variadic arguments, and asynchronous results with %s', async (api) => {
		const cb = { [api]: () => false, success: vi.fn(), failure: vi.fn() };
		const ctx = { user: { id: 'member' } };
		const operation = vi.fn(async (actual, a, b) => [actual, a, b]);
		const wrapped = live.breaker({ breaker: cb }, operation);
		await expect(wrapped(ctx, 1, 2)).resolves.toEqual([ctx, 1, 2]);
		expect(operation).toHaveBeenCalledWith(ctx, 1, 2);
		expect(cb.success).toHaveBeenCalledOnce();
		expect(cb.failure).not.toHaveBeenCalled();
	});

});

it('types both supported breaker APIs and rejects unsupported shapes', () => {
	const file = resolve(import.meta.dirname, 'breaker-consumer.ts').replaceAll('\\', '/');
	const source = `
import { live } from '../src/server.js';
import { createCircuitBreaker } from 'svelte-adapter-uws-extensions/breaker';
const handler = (_ctx: unknown, value: number) => value;
live.breaker({ breaker: createCircuitBreaker() }, handler);
live.breaker({ breaker: { guard() {}, success() {}, failure(_error: Error) {} } }, handler);
live.breaker({ breaker: { isOpen: () => true }, fallback: 0 }, handler);
// @ts-expect-error an empty object cannot enforce circuit admission
live.breaker({ breaker: {} }, handler);
// @ts-expect-error a state property alone does not admit recovery probes
live.breaker({ breaker: { state: 'broken' } }, handler);
// @ts-expect-error guard must be callable
live.breaker({ breaker: { guard: true } }, handler);
// @ts-expect-error isOpen must return a boolean
live.breaker({ breaker: { isOpen: () => 'open' } }, handler);
// @ts-expect-error null is not a breaker
live.breaker({ breaker: null }, handler);
`;
	const options = {
		noEmit: true, strict: true, skipLibCheck: true,
		target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler
	};
	const host = ts.createCompilerHost(options);
	const getSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (name, ...args) => name === file
		? ts.createSourceFile(name, source, options.target, true)
		: getSourceFile(name, ...args);
	const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([file], options, host))
		.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '));
	expect(diagnostics).toEqual([]);
});
