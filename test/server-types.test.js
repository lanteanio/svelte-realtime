import { it, expect } from 'vitest';
import ts from 'typescript';
import { resolve } from 'node:path';

it('accepts typed server options and rejects invalid values', () => {
	const file = resolve(import.meta.dirname, 'smooth-config-consumer.ts').replaceAll('\\', '/');
	const source = `
import { configureForget, introspect, live, type SmoothConfig, type TenantConfig } from '../src/server.js';
import { LiveError, type ErrorMetadata } from '../src/server.js';
import { RpcError } from '../src/client.js';
import type { SmoothCluster, SmoothClusterHandlers, SmoothOwnershipLease } from '../src/server.js';
declare const coordinator: SmoothCluster;
declare const handlers: SmoothClusterHandlers;
const lease: SmoothOwnershipLease = { epoch: '9007199254740993', leaseMs: 10000 };
coordinator.renewOwner('__smooth:room', lease.epoch);
coordinator.relayBroadcast('__smooth:room', 'event', {}, undefined, 0, lease.epoch);
handlers.onBroadcast('__smooth:room', 'event', {}, undefined, 0, 'owner', lease.epoch);
// @ts-expect-error epochs preserve exact decimal strings
const numericEpoch: SmoothOwnershipLease = { epoch: 1, leaseMs: 10000 };
// @ts-expect-error a renewal must name the tenure
coordinator.renewOwner('__smooth:room');
// @ts-expect-error authoritative frames must carry their epoch
handlers.onAck('__smooth:room', 'user', { id: 1, state: {}, t: 0 });
// @ts-expect-error boolean acquisition has no fenced lease
const unfenced: SmoothCluster['acquireOwner'] = async () => true;
void numericEpoch; void unfenced;

const publicError = new LiveError('LIMIT', 'Limit reached', { params: { count: 3 }, details: ['retry', null] });
const receivedError = new RpcError('LIMIT', 'Limit reached', { params: { count: 3 } });
const metadata: ErrorMetadata = { params: publicError.params, details: receivedError.details };
// @ts-expect-error metadata must be JSON-safe
new LiveError('LIMIT', 'Limit reached', { details: 1n });
// @ts-expect-error params must be an object
new RpcError('LIMIT', 'Limit reached', { params: ['bad'] });
// @ts-expect-error public metadata is readonly
if (publicError.params) publicError.params.count = 4;
void metadata;

import { configureWebhooks, createDeadLetterStore, type DeadLetterStore } from '../src/server.js';
import type { RedisDeadLetterStore } from 'svelte-adapter-uws-extensions/redis/dead-letter';
declare const redisDeadLetter: RedisDeadLetterStore;
live(async (_ctx) => 1, { timeout: 300_000 });
live.stream('budget', async (_ctx) => [], { timeout: 300_000 });
live.upload(async (_ctx) => 1, { timeout: 300_000 });
// @ts-expect-error timeout is numeric
live(async (_ctx) => 1, { timeout: '300000' });
// @ts-expect-error timeout is numeric
live.stream('budget', async (_ctx) => [], { timeout: '300000' });
// @ts-expect-error timeout is numeric
live.upload(async (_ctx) => 1, { timeout: '300000' });

live.webhooks.outbound(['orders'], { url: 'https://receiver.example/hook', pinCacheMs: 250 });
live.webhooks.outbound(['orders'], { url: 'https://receiver.example/hook', pinCacheMs: 0 });
// @ts-expect-error DNS pin cache durations are numeric
live.webhooks.outbound(['orders'], { url: 'https://receiver.example/hook', pinCacheMs: '250' });

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
  snapshot: true, snapshotDebounceMs: 250, maxCommandsPerTick: 2
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
// @ts-expect-error command budgets are numeric
const invalidCommandBudget: SmoothConfig = { ...config, maxCommandsPerTick: '2' };
void invalidCommandBudget;
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
import type { SmoothCustomShotConfig, SmoothHitTestConfig, SmoothShotTiming } from '../src/server.js';
const customProjectile: SmoothCustomShotConfig = {
  maxRewindMs: 100,
  resolveShot(ctx, command, timing) {
    const identity: string = ctx.identity;
    const bounded: SmoothShotTiming = timing;
    const rewind: number = bounded.rewindMs;
    const sample: number | null = bounded.maxUplink;
    const accepted: boolean = ctx.applyTo(identity, command);
    ctx.emitEvent('projectile', { rewind, sample, accepted });
    // @ts-expect-error admitted timing snapshots are readonly
    timing.reach = 999;
  }
};
const customConfig: SmoothConfig = { ...config, hitTest: customProjectile };
void customConfig;
// @ts-expect-error custom and built-in ray consequences cannot be combined
const mixedShot: SmoothCustomShotConfig = { resolveShot() {}, onHit() {} };
// @ts-expect-error custom resolvers must be functions
const invalidResolver: SmoothCustomShotConfig = { resolveShot: 5 };
void mixedShot; void invalidResolver;
const validRay: SmoothHitTestConfig = {
  shot: { type: 'ray', origin: (_command, state) => state, dir: () => 0, maxDist: 100 },
  hitbox: { shape: 'circle', radius: 5 },
  onHit() {}
};
const mixedProjectileVariable = { ...validRay, resolveShot() {} };
// @ts-expect-error predeclared ray configurations cannot carry a custom resolver
const mixedRayVariable: SmoothHitTestConfig = mixedProjectileVariable;
// @ts-expect-error union assignment rejects mixed modes beyond fresh object literals
const mixedConfigVariable: SmoothConfig = { ...config, hitTest: mixedProjectileVariable };
// @ts-expect-error public declaration rejects the same predeclared mixed configuration
live.smooth({ ...config, hitTest: mixedProjectileVariable });
void mixedRayVariable; void mixedConfigVariable;

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
