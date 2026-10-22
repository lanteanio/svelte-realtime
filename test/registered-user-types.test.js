import { expect, it } from 'vitest';
import ts from 'typescript';
import { resolve } from 'node:path';

const declaration = `
declare module 'svelte-realtime/server' {
  interface Register { user: User }
}
`;
const consumer = `
import { live, guard, type LiveContext, type UploadContext, type RegisteredUser,
  type StreamOptions, type HandleRpcOptions, type CreateMessageOptions, pipe, realtime } from 'svelte-realtime/server';
import { live as rootLive } from 'svelte-realtime';
import { upgradeResponse } from 'svelte-adapter-uws/upgrade-response';
import { createTestContext, createTestEnv } from 'svelte-realtime/testing';
interface User { id: string; role: 'reader' | 'writer' }
export async function upgrade() { return { id: '1', role: 'reader' as User['role'] }; }
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
declare const allowed: boolean;
async function upgradeWrapped() { return allowed ? upgradeResponse({ id: '1', role: 'reader' as User['role'] }, { 'X-Example': 'ok' }) : false; }
type UnwrapUpgrade<U> = U extends { __upgradeResponse: true; userData: infer D } ? D : U;
type WrappedMatches = Assert<Equal<UnwrapUpgrade<Exclude<Awaited<ReturnType<typeof upgradeWrapped>>, false>>, RegisteredUser>>;
type UpgradeMatches = Assert<Equal<Awaited<ReturnType<typeof upgrade>>, RegisteredUser>>;
type ContextMatches = Assert<Equal<LiveContext['user'], User>>;
type SocketMatches = Assert<Equal<ReturnType<LiveContext['ws']['getUserData']>, User>>;
type UploadMatches = Assert<Equal<UploadContext['user'], User>>;
const check = <T extends LiveContext>(ctx: T & (0 extends (1 & T['user']) ? never : unknown)) => {
  const role: User['role'] = ctx.user.role;
  // @ts-expect-error unknown user properties must not become any
  ctx.user.missing;
  // @ts-expect-error socket user data has the same registered shape
  ctx.ws.getUserData().missing;
  return role;
};
const rpc = live(ctx => { check(ctx); return ctx.user.role; });
type RpcMatches = Assert<Equal<ReturnType<typeof rpc>, User['role']>>;
rootLive(ctx => { const user: User = ctx.user; return user; });
live.public(ctx => check(ctx));
live.stream(ctx => ctx.user.id, ctx => check(ctx), {
  onSubscribe: ctx => { check(ctx); },
  onUnsubscribe: ctx => { check(ctx); },
  filter: ctx => check(ctx) === 'reader',
  access: ctx => check(ctx) === 'writer',
  onError: (_error, ctx) => { check(ctx); }
});
live.upload(ctx => { const user: User = ctx.user; return user; });
live.middleware(async (ctx, next) => { check(ctx); return next(); });
guard(ctx => { check(ctx); });
live.smooth({ topic: ctx => { check(ctx); return ctx.user.id; }, guard: ctx => check(ctx), initial: {}, apply: state => state });
for (const define of [live.doc, live.map, live.array]) define({ topic: ctx => { check(ctx); return ctx.user.id; }, guard: ctx => check(ctx) === 'reader' });
live.room({ topic: ctx => { check(ctx); return ctx.user.id; }, init: async ctx => check(ctx), guard: ctx => { check(ctx); }, presence: ctx => check(ctx), actions: { read: ctx => check(ctx) } });
live.multiplayer({ topic: ctx => { check(ctx); return ctx.user.id; }, guard: ctx => { check(ctx); }, presence: ctx => check(ctx) });
live.gate(ctx => check(ctx) === 'reader', rpc);
live.rateLimit({ points: 2, window: 1000, key: ctx => check(ctx) }, ctx => check(ctx));
live.lock(ctx => check(ctx), ctx => check(ctx));
live.idempotent({ keyFrom: ctx => check(ctx) }, ctx => check(ctx));
pipe.filter((ctx, item) => { check(ctx); return true; });
const socketCheck = <T extends User>(user: T & (0 extends (1 & T) ? never : unknown)) => user.id;
const hooks: CreateMessageOptions = {
  beforeExecute: ws => { socketCheck(ws.getUserData()); },
  onJsonMessage: ws => { socketCheck(ws.getUserData()); },
  onUnhandled: ws => { socketCheck(ws.getUserData()); }
};
realtime({ tenant: user => socketCheck(user) });
live.configurePush({ identify: ws => socketCheck(ws.getUserData()), sessionIdentify: ws => socketCheck(ws.getUserData()) });
const testContext = createTestContext({ user: { id: '1', role: 'reader' } });
if (testContext.user) socketCheck(testContext.user);
createTestEnv().connect({ id: '1', role: 'reader' });
// @ts-expect-error test connections require the registered shape
createTestEnv().connect({ role: 'reader' });
const options: HandleRpcOptions = { beforeExecute: ws => { socketCheck(ws.getUserData()); }, onError: (_path, _error, ctx) => { check(ctx); } };
const streamOptions: StreamOptions = { filter: ctx => ctx.user.role === 'reader' };
const explicit: LiveContext<{ other: number }> = {} as any;
const other: number = explicit.user.other;
void options; void streamOptions; void other;
`;

function diagnostics(registered) {
	const file = resolve(import.meta.dirname, 'registered-user-consumer.ts').replaceAll('\\', '/');
	const options = { noEmit: true, strict: true, skipLibCheck: true,
		target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler };
	const host = ts.createCompilerHost(options);
	const original = host.getSourceFile.bind(host);
	host.getSourceFile = (name, ...args) => name === file
		? ts.createSourceFile(name, consumer + (registered ? declaration : ''), options.target, true)
		: original(name, ...args);
	return ts.getPreEmitDiagnostics(ts.createProgram([file], options, host))
		.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '));
}

it('uses one app registration throughout handlers and rejects a missing registration', () => {
	expect(diagnostics(true)).toEqual([]);
	const missing = diagnostics(false);
	expect(missing.some(message => message.includes("does not satisfy the constraint 'true'"))).toBe(true);
	expect(missing.some(message => message.includes("Unused '@ts-expect-error' directive"))).toBe(true);
}, 30000);

const unregistered = `
import { live, type LiveContext, type UploadContext, type RegisteredUser, type CreateMessageOptions } from 'svelte-realtime/server';
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Assert<T extends true> = T;
type UserIsAny = Assert<IsAny<RegisteredUser>>;
type ContextIsAny = Assert<IsAny<LiveContext['user']>>;
type UploadIsAny = Assert<IsAny<UploadContext['user']>>;
live(ctx => ctx.user.anything.goes);
const hooks: CreateMessageOptions = { beforeExecute: ws => { ws.getUserData().whatever; } };
const explicit: LiveContext<{ other: number }> = {} as any;
const other: number = explicit.user.other;
// @ts-expect-error an explicit generic still constrains the user shape
explicit.user.missing;
const opaque: LiveContext<unknown> = {} as any;
// @ts-expect-error an explicit unknown generic keeps the user opaque
opaque.user.id;
void hooks; void other;
`;

it('keeps unregistered apps permissive and explicit generics strict', () => {
	const file = resolve(import.meta.dirname, 'unregistered-user-consumer.ts').replaceAll('\\', '/');
	const options = { noEmit: true, strict: true, skipLibCheck: true,
		target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler };
	const host = ts.createCompilerHost(options);
	const original = host.getSourceFile.bind(host);
	host.getSourceFile = (name, ...args) => name === file
		? ts.createSourceFile(name, unregistered, options.target, true)
		: original(name, ...args);
	const messages = ts.getPreEmitDiagnostics(ts.createProgram([file], options, host))
		.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '));
	expect(messages).toEqual([]);
}, 30000);
