import { it, expect } from 'vitest';
import ts from 'typescript';
import { resolve } from 'node:path';

it('accepts typed server options and rejects invalid values', () => {
	const file = resolve(import.meta.dirname, 'smooth-config-consumer.ts').replaceAll('\\', '/');
	const source = `
import { configureForget, introspect, live, type SmoothConfig, type TenantConfig } from '../src/server.js';
import { configureWebhooks, createDeadLetterStore, type DeadLetterStore } from '../src/server.js';
import type { RedisDeadLetterStore } from 'svelte-adapter-uws-extensions/redis/dead-letter';
declare const redisDeadLetter: RedisDeadLetterStore;
configureWebhooks({ deadLetter: redisDeadLetter });
const asyncDeadLetter: DeadLetterStore = {
  add: async () => null, get: async () => null, remove: async () => false,
  count: async () => 0, list: async () => [],
  summary: async () => ({ total: 0, byTopic: {}, oldest: null, newest: null }),
  purgeUser: async () => 0, clear: async () => {}
};
configureWebhooks({ deadLetter: asyncDeadLetter });
const memoryCount: number = createDeadLetterStore().count();
void memoryCount;
const tenantConfig: TenantConfig = { metadata: { entitlement: 'pro', caps: { windowMs: 1000, actions: 1, bytes: 2048, recipientDeliveries: 2, storedBytes: 4096 } } };
const tenant = live.tenant('acme', tenantConfig);
const registered: TenantConfig | null = tenant.config;
void registered;
// @ts-expect-error legacy quota has no enforcement consumer
live.tenant('acme', { quota: { actions: 1 } });
// @ts-expect-error unknown metadata fields are rejected
live.tenant('acme', { metadata: { plan: 'pro' } });
// @ts-expect-error cap windows are required
live.tenant('acme', { metadata: { caps: { actions: 1 } } });
// @ts-expect-error cap values are numeric
live.tenant('acme', { metadata: { caps: { windowMs: 1000, bytes: '2048' } } });
// @ts-expect-error the registry exposes readonly metadata
if (tenant.config?.metadata?.caps) tenant.config.metadata.caps.actions = 2;
// @ts-expect-error handles expose a getter, not a writable config slot
tenant.config = {};
const publicHandler = live.public((ctx, label: string, count: number): string => {
  ctx.signal('reader', 'status', { label });
  return label.repeat(count);
});
const publicTyped: (ctx: import('../src/server.js').LiveContext, label: string, count: number) => string = publicHandler;
const publicAsync = live.public(async (_ctx, count: number): Promise<number> => count);
const publicAsyncTyped: (ctx: import('../src/server.js').LiveContext, count: number) => Promise<number> = publicAsync;
void publicTyped; void publicAsyncTyped;
// @ts-expect-error a public RPC marker requires a handler function
live.public(42);
// @ts-expect-error the marker preserves the required handler arguments
publicHandler({} as import('../src/server.js').LiveContext, 42, 'bad');
const config: SmoothConfig = {
  topic: 'positions', apply: (state) => state, initial: {},
  snapshot: true, snapshotDebounceMs: 250
};
live.smooth(config);
live.smooth({
  ...config, interest: { radius: 100, position: (state) => state },
  hitTest: {
    hitbox: { shape: 'circle', radius: 5 },
    shot: { type: 'ray', origin: (_cmd, state) => state, dir: () => 0, maxDist: 100 },
    onHit: (ctx, target, info) => {
      const rewindMs: number = info.rewindMs;
      ctx.emitEvent('hit', { target: target.key, rewindMs });
      // @ts-expect-error applied rewind duration is numeric
      const text: string = info.rewindMs;
      void text;
    }
  }
});
live.smooth({ topic: 'positions', apply: (state) => state, initial: {}, snapshot: false });
// @ts-expect-error snapshots are enabled with a boolean
const invalidSnapshot: SmoothConfig = { ...config, snapshot: 'true' };
// @ts-expect-error the cadence is numeric
const invalidCadence: SmoothConfig = { ...config, snapshotDebounceMs: '250' };
void invalidSnapshot; void invalidCadence;
configureForget({ hashKey: 'a'.repeat(32) });
configureForget({ hashKey: new Uint8Array(32) });
configureForget({ hashKey: null });
live.forget('user', { hashKey: new Uint8Array(32), onForget: ({ userIdHash }) => { const hash: string = userIdHash; void hash; } });
live.forget('user', { hashKey: null });
// @ts-expect-error audit keys must be strings, byte arrays or null
configureForget({ hashKey: 42 });
// @ts-expect-error audit keys must be strings, byte arrays or null
live.forget('user', { hashKey: true });
const versions = introspect().transport?.versions;
if (versions) {
  const adapter: string | null = versions.adapter;
  const protocol: number | null = versions.protocolRevision;
  const realtime: string | null = versions.realtime;
  const extensions: string | null = versions.extensions;
  void adapter; void protocol; void realtime; void extensions;
}

live.derived((id: string) => [id], (ctx, id: string) => id, {
  scopeKey: (ctx, id) => ctx.user.id + id
});
live.derived(() => ['source'], () => 1, { scopeKey: () => 7 });
// @ts-expect-error scope keys must be synchronous scalars
live.derived(() => ['source'], () => 1, { scopeKey: async () => 'scope' });
// @ts-expect-error object scope keys are not supported
live.derived(() => ['source'], () => 1, { scopeKey: () => ({ id: 'scope' }) });
`;
	const options = {
		noEmit: true, strict: true, skipLibCheck: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler
	};
	const host = ts.createCompilerHost(options);
	const getSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (name, ...args) => name === file
		? ts.createSourceFile(name, source, options.target, true)
		: getSourceFile(name, ...args);
	const program = ts.createProgram([file], options, host);
	const diagnostics = ts.getPreEmitDiagnostics(program)
		.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
	expect(diagnostics).toEqual([]);
});
