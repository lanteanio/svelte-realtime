import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';

let server;
beforeEach(async () => {
 vi.resetModules();
 server = await import('../src/server.js');
 vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function frame(kind, path, payloadSize = 0) {
 const request = { rpc: path, id: 'request', args: [] };
 if (kind === 'text' || kind === 'batch') return new TextEncoder().encode(JSON.stringify(kind === 'batch' ? { batch: [request] } : request)).buffer;
 const header = new TextEncoder().encode(JSON.stringify(request));
 const start = kind === 'upload' ? 12 : 3;
 const data = new Uint8Array(start + header.length + payloadSize);
 const view = new DataView(data.buffer);
 if (kind === 'upload') { data[0] = 1; data[1] = 3; view.setUint32(2, 1); view.setUint16(10, header.length); }
 else view.setUint16(1, header.length);
 data.set(header, start);
 return data.buffer;
}
async function reply(kind, path, user, payloadSize = 0) {
 const ws = mockWs(user ?? {}); if (user === null) ws.getUserData = () => null;
 const platform = mockPlatform();
 expect(server.handleRpc(ws, frame(kind, path, payloadSize), platform)).toBe(true);
 await vi.waitFor(() => expect(platform.sent.length).toBeGreaterThan(0));
 const data = kind === 'batch' ? platform.sent.at(-1).data.batch[0] : platform.sent.at(-1).data;
 return { ok: data.ok, code: data.code, error: data.error };
}
function deny() {
 server.__registerGuard('sealed', server.guard(() => { throw new Error('private details'); }));
 server.__register('sealed/plain', server.live(async () => 'never'));
 server.__register('sealed/binary', server.live.binary(async () => 'never', { maxSize: 1 }));
 server.__register('sealed/upload', server.live.upload(async () => 'never', { maxSize: 1 }));
}
for (const kind of ['text', 'batch', 'binary', 'upload']) {
 for (const [label, user, code, error] of [
  ['anonymous', null, 'UNAUTHENTICATED', 'Authentication required'],
  ['adapter metadata', {}, 'UNAUTHENTICATED', 'Authentication required'],
  ['authenticated', { id: 'member' }, 'FORBIDDEN', 'Access denied']
 ]) it(`${kind} defaults hide unknown paths from ${label}`, async () => {
  deny(); const expected = { ok: false, code, error };
  expect(await reply(kind, 'sealed/missing', user)).toEqual(expected);
  expect(await reply(kind, 'sealed/' + (kind === 'binary' || kind === 'upload' ? kind : 'plain'), user)).toEqual(expected);
 });
 it(`${kind} permits the explicit NOT_FOUND opt-out`, async () => {
  server.realtime({ maskNotFound: false });
  expect(await reply(kind, 'sealed/missing', { id: 'member' })).toEqual({ ok: false, code: 'NOT_FOUND', error: 'Not found' });
 });
}
for (const kind of ['binary', 'upload']) {
 it(`${kind} cannot reveal guarded handler type`, async () => {
  deny();
  expect(await reply(kind, 'sealed/plain', {})).toEqual(await reply(kind, 'sealed/missing', {}));
 });
 it(`${kind} authorizes before disclosing handler payload limits`, async () => {
  deny();
  expect(await reply(kind, 'sealed/' + kind, {}, 2)).toEqual(await reply(kind, 'sealed/missing', {}, 2));
 });
 it(`${kind} preserves type errors after a successful guard`, async () => {
  server.__registerGuard('sealed', server.guard(() => {}));
  server.__register('sealed/plain', server.live(async () => 'unused'));
  expect((await reply(kind, 'sealed/plain', { id: 'member' })).code).toBe('INVALID_REQUEST');
 });
}


it('closing during an upload guard releases pending byte capacity immediately', async () => {
 let entered, release;
 const started = new Promise(resolve => { entered = resolve; });
 const held = new Promise(resolve => { release = resolve; });
 const handler = vi.fn(async () => 'never');
 server.__registerGuard('sealed', server.guard(async () => { entered(); await held; }));
 server.__register('sealed/upload', server.live.upload(handler));
 const ws = mockWs({ id: 'member' }); const platform = mockPlatform();
 const { state } = await import('../src/server/state.js');
 server.handleRpc(ws, frame('upload', 'sealed/upload', 8), platform);
 await started;
 try {
  expect(state.pendingUploadBytes).toBe(8);
  await server.close(ws, { platform, subscriptions: [] });
  expect(state.pendingUploadBytes).toBe(0);
 } finally { release(); }
 await new Promise(resolve => setTimeout(resolve, 10));
 expect(handler).not.toHaveBeenCalled();
 expect(state.pendingUploadBytes).toBe(0);
});
