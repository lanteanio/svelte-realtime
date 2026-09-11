import { AsyncLocalStorage } from 'node:async_hooks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	__register,
	configureWebhooks,
	getDeadLetter,
	handleRpc,
	live
} from '../src/server.js';
import { _fireWebhookOut } from '../src/server/webhook-out.js';
import { createTestContext } from '../src/testing.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { mockWs } from './helpers/mock-ws.js';
import { toArrayBuffer } from './helpers/encode.js';

const deliveryMocks = vi.hoisted(() => ({ hooks: [] }));

vi.mock('svelte-adapter-uws/plugins/webhooks', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		deliverWebhook(...args) {
			deliveryMocks.hooks.push(args[4] ?? null);
			return actual.deliverWebhook(...args);
		}
	};
});

const ROOT = {
	traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
	tracestate: 'vendor=value'
};

function makeTracingPlatform() {
	const platform = mockPlatform();
	const active = new AsyncLocalStorage();
	const spans = [];
	let next = 1;
	const trace = {
		enabled: true,
		current: () => active.getStore() ?? ROOT,
		extract(carrier) {
			const traceparent = carrier?.traceparent ?? carrier?.get?.('traceparent');
			return typeof traceparent === 'string' && traceparent.startsWith('00-')
				? { traceparent, ...(carrier?.tracestate ? { tracestate: carrier.tracestate } : {}) }
				: null;
		},
		inject(carrier, context = trace.current()) {
			if (context) Object.assign(carrier, context);
			return carrier;
		},
		run(name, options, fn) {
			const parent = options.parent ?? trace.current();
			const context = {
				traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-' +
					(next++).toString(16).padStart(16, '0') + '-01',
				...(parent?.tracestate ? { tracestate: parent.tracestate } : {})
			};
			spans.push({ name, options, context });
			return active.run(context, () => fn(null));
		},
		withContext(context, fn) {
			return context ? active.run(context, fn) : fn();
		}
	};
	platform.trace = trace;
	Object.defineProperty(platform, 'traceContext', {
		enumerable: true,
		get: () => trace.current()
	});
	return { platform, spans, trace };
}

describe('operation tracing', () => {
	beforeEach(() => {
		configureWebhooks({ deadLetter: false });
		deliveryMocks.hooks.length = 0;
	});

	it('creates an isolated RPC span and projects its context into ctx', async () => {
		const { platform, spans, trace } = makeTracingPlatform();
		const ws = mockWs();
		let seen;
		__register('tracing/rpc', async (ctx) => {
			await Promise.resolve();
			seen = {
				context: ctx.traceContext,
				platformContext: ctx.platform.traceContext,
				trace: ctx.trace
			};
			return 'ok';
		});

		handleRpc(ws, toArrayBuffer({ rpc: 'tracing/rpc', id: 'trace-rpc', args: [] }), platform);
		await vi.waitFor(() => expect(platform.sent).toHaveLength(1));

		expect(spans).toHaveLength(1);
		expect(spans[0]).toMatchObject({
			name: 'realtime.rpc',
			options: { kind: 'server', parent: ROOT }
		});
		expect(seen.context).toEqual(spans[0].context);
		expect(seen.platformContext).toEqual(spans[0].context);
		expect(seen.trace).toBe(trace);
	});

	it('extracts an inbound webhook parent before verify, transform, and publish', async () => {
		const { platform, spans, trace } = makeTracingPlatform();
		const publishedContexts = [];
		platform.publish = () => {
			publishedContexts.push(trace.current());
			return true;
		};
		const inbound = {
			traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
			tracestate: 'edge=one'
		};
		const handler = live.webhook('payments', {
			verify: ({ body }) => JSON.parse(body),
			transform: (event) => ({ event: 'received', data: event })
		});

		const result = await handler.handle({
			body: '{"id":7}',
			headers: inbound,
			platform
		});

		expect(result).toEqual({ status: 200, body: 'OK' });
		expect(spans[0]).toMatchObject({
			name: 'realtime.webhook.inbound',
			options: { kind: 'server', parent: inbound }
		});
		expect(publishedContexts).toEqual([spans[0].context]);
	});

	it('retains an outbound span context in the dead-letter record for replay', async () => {
		const { platform, spans } = makeTracingPlatform();
		configureWebhooks({ deadLetter: true });
		await _fireWebhookOut(
			{ id: 'tracing/outbound', config: { url: 'http://127.0.0.1:9/blocked' } },
			'orders',
			'created',
			{ id: 7 },
			platform
		);

		expect(spans[0]).toMatchObject({
			name: 'realtime.webhook.outbound',
			options: { kind: 'producer', parent: ROOT }
		});
		expect(getDeadLetter().list()[0].traceContext).toEqual(spans[0].context);
	});

	it('propagates a restored outbound context without allocating a span', async () => {
		const platform = mockPlatform();
		const active = new AsyncLocalStorage();
		const run = vi.fn();
		platform.trace = {
			enabled: false,
			current: () => active.getStore() ?? null,
			run,
			withContext: (context, fn) => context ? active.run(context, fn) : fn()
		};
		Object.defineProperty(platform, 'traceContext', {
			enumerable: true,
			get: () => platform.trace.current()
		});
		configureWebhooks({ deadLetter: true });
		await platform.trace.withContext(ROOT, () => _fireWebhookOut(
			{ id: 'tracing/no-provider', config: { url: 'http://127.0.0.1:9/blocked' } },
			'orders',
			'created',
			{ id: 8 },
			platform
		));

		expect(run).not.toHaveBeenCalled();
		expect(deliveryMocks.hooks).toEqual([expect.objectContaining({ traceContext: ROOT })]);
		expect(getDeadLetter().list()[0].traceContext).toEqual(ROOT);
	});

	it('mirrors trace fields in direct test contexts', () => {
		const { platform, trace } = makeTracingPlatform();
		const ctx = createTestContext({ platform });
		expect(ctx.traceContext).toEqual(ROOT);
		expect(ctx.trace).toBe(trace);
		const detached = createTestContext({ platform, traceContext: null });
		expect(detached.traceContext).toBeNull();
		expect(detached.platform.traceContext).toBeNull();
	});
});
