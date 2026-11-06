import { describe, it, expect, vi } from 'vitest';
import { live, __register, handleRpc } from '../src/server.js';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { toArrayBuffer } from './helpers/encode.js';

// Every delta hook receives, after its cursor, the ctx and arguments the
// loader receives, so a stream with a topic factory reads only the changes of
// the topic they name.
describe('delta hooks receive the loader context and arguments', () => {
	async function subscribe(name, delta, frame) {
		const platform = mockPlatform();
		const seen = { topic: null, loader: null };
		const stream = live.stream(
			(ctx, orgId) => { seen.topic = ctx; return name + ':' + orgId; },
			async (ctx, orgId) => { seen.loader = { ctx, orgId }; return [{ id: 'loaded' }]; },
			{ merge: 'crud', key: 'id', delta }
		);
		__register(name, stream);
		handleRpc(mockWs(), toArrayBuffer({ rpc: name, id: 'd1', args: ['org-a'], stream: true, ...frame }), platform);
		await new Promise((r) => setTimeout(r, 10));
		return { response: platform.sent[0].data, seen };
	}

	it('passes them to delta.fromSeq after the cursor', async () => {
		const calls = [];
		const fromSeq = async (sinceSeq, ctx, orgId, ...rest) => {
			calls.push({ sinceSeq, ctx, orgId, rest });
			return [{ event: 'created', data: { id: 'a-8' }, seq: 8 }];
		};
		const { response, seen } = await subscribe('dscope/fromseq', { fromSeq }, { seq: 7 });
		expect(calls).toHaveLength(1);
		expect(calls[0].sinceSeq).toBe(7);
		expect(calls[0].orgId).toBe('org-a');
		expect(calls[0].rest).toEqual([]);
		expect(calls[0].ctx).toBe(seen.topic);
		expect(seen.loader).toBe(null);
		expect(response.topic).toBe('dscope/fromseq:org-a');
		expect(response.fromSeq).toBe(true);
		expect(response.seq).toBe(8);
	});

	it('passes them to delta.version and delta.diff on a version resume', async () => {
		const calls = [];
		const delta = {
			version: async (ctx, orgId) => { calls.push({ hook: 'version', ctx, orgId }); return 5; },
			diff: async (sinceVersion, ctx, orgId) => { calls.push({ hook: 'diff', sinceVersion, ctx, orgId }); return [{ id: 'a-5' }]; }
		};
		const { response, seen } = await subscribe('dscope/diff', delta, { version: 3 });
		expect(calls.map((c) => c.hook)).toEqual(['version', 'diff']);
		expect(calls[1].sinceVersion).toBe(3);
		for (const call of calls) {
			expect(call.orgId).toBe('org-a');
			expect(call.ctx).toBe(seen.topic);
		}
		expect(response.delta).toBe(true);
		expect(response.version).toBe(5);
		expect(response.data).toEqual([{ id: 'a-5' }]);
	});

	it('passes them to delta.version when the loader answers', async () => {
		const calls = [];
		const delta = { version: async (ctx, orgId) => { calls.push({ ctx, orgId }); return 'v-' + orgId; } };
		const { response, seen } = await subscribe('dscope/version', delta, {});
		expect(seen.loader.orgId).toBe('org-a');
		expect(calls).toHaveLength(1);
		expect(calls[0].orgId).toBe('org-a');
		expect(calls[0].ctx).toBe(seen.loader.ctx);
		expect(response.version).toBe('v-org-a');
	});
});

describe('dev warning for a delta hook that may not be scoped to its topic', () => {
	const scopeWarnings = (warn) => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('may not be scoped to its topic'));

	it('warns once per topic factory and hook when diff or fromSeq declares at most one parameter', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const topic = (ctx, orgId) => 'dscope-warn:' + orgId;
			const delta = { version: () => 1, diff: async (since) => [since], fromSeq: async () => [] };
			live.stream(topic, async () => [], { merge: 'crud', key: 'id', delta });
			live.stream(topic, async () => [], { merge: 'crud', key: 'id', delta });
			const calls = scopeWarnings(warn);
			expect(calls).toHaveLength(2);
			expect(calls[0]).toContain('declares delta.diff with at most one parameter');
			expect(calls[0]).toContain('delta.diff receives (sinceVersion, ctx, ...args)');
			expect(calls[1]).toContain('declares delta.fromSeq with at most one parameter');
			expect(calls[1]).toContain('delta.fromSeq receives (sinceSeq, ctx, ...args)');
			expect(calls[1]).toContain("(ctx, orgId) => 'dscope-warn:' + orgId");
		} finally {
			warn.mockRestore();
		}
	});

	it('stays quiet for hooks that take ctx, static topics and version alone', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			live.stream((ctx, orgId) => 'dscope-quiet-a:' + orgId, async () => [], {
				merge: 'crud', key: 'id',
				delta: { version: () => 1, diff: async (since, ctx) => [], fromSeq: async (since, ctx, orgId) => [] }
			});
			live.stream('dscope-quiet-static', async () => [], {
				merge: 'crud', key: 'id',
				delta: { version: () => 1, diff: async (since) => [], fromSeq: async (since) => [] }
			});
			live.stream((ctx, orgId) => 'dscope-quiet-b:' + orgId, async () => [], {
				merge: 'crud', key: 'id',
				delta: { version: () => 1 }
			});
			expect(scopeWarnings(warn)).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});
});
