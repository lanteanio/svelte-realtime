import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mockWs } from './helpers/mock-ws.js';
import { mockPlatform } from './helpers/mock-platform.js';
let server, state;
beforeEach(async () => {
 vi.resetModules(); server = await import('../src/server.js');
 ({ state } = await import('../src/server/state.js'));
});
afterEach(() => vi.restoreAllMocks());
function deferred() { let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve}; }
function chunk(seq, bytes, isLast=false, streamId=1, rpc='upload/file') {
 const header=seq===0?new TextEncoder().encode(JSON.stringify({rpc,args:[]})):null;
 const start=header?12+header.length:10;
 const data=new Uint8Array(start+bytes); const view=new DataView(data.buffer);
 data[0]=1;data[1]=(header?1:0)|(isLast?2:0);view.setUint32(2,streamId);view.setUint32(6,seq);
 if(header){view.setUint16(10,header.length);data.set(header,12);}
 return data.buffer;
}
function cancel() {const data=new Uint8Array(6);data[0]=2;data[1]=16;new DataView(data.buffer).setUint32(2,1);return data.buffer;}
for(const running of [false,true]) it(`old cancelled upload cannot remove its ${running?'running':'pending'} replacement`,async()=>{
 const oldEntered=deferred(), oldGuard=deferred(), newEntered=deferred(), newGuard=deferred(), handlerEntered=deferred();
 let guards=0;
 server.__registerGuard('upload',server.guard(async()=>{ if(guards++===0){oldEntered.resolve();await oldGuard.promise;}else{newEntered.resolve();await newGuard.promise;} }));
 const handler=vi.fn(async ctx=>{handlerEntered.resolve();let bytes=0;for await(const data of ctx.stream)bytes+=data.byteLength;return bytes;});
 server.__register('upload/file',server.live.upload(handler,{maxConcurrentPerSession:2,maxConcurrentTotal:2}));
 const ws=mockWs({id:'member'}),platform=mockPlatform();
 const companionEntered=deferred();
 server.__register('other/file',server.live.upload(async ctx=>{companionEntered.resolve();for await(const data of ctx.stream){};return 0;}));
 try {
  // Keep the socket's map alive when the first upload is removed.
  server.handleRpc(ws,chunk(0,0,false,2,'other/file'),platform);await companionEntered.promise;
  server.handleRpc(ws,chunk(0,3),platform);await oldEntered.promise;
  server.handleRpc(ws,cancel(),platform);
  expect(platform.sent.at(-1).data.code).toBe('CANCELLED');
  expect(state.pendingUploadBytes).toBe(0);
  server.handleRpc(ws,chunk(0,8),platform);await newEntered.promise;
  if(running){newGuard.resolve();await handlerEntered.promise;}
  oldGuard.resolve();await new Promise(resolve=>setTimeout(resolve,10));
  expect(state.pendingUploadBytes).toBe(running?0:8);
  if(!running){newGuard.resolve();await handlerEntered.promise;}
  server.handleRpc(ws,chunk(1,6,true),platform);
  await vi.waitFor(()=>expect(platform.sent.some(reply=>reply.data.ok&&reply.data.data===14)).toBe(true));
  expect(handler).toHaveBeenCalledOnce();
  expect(state.pendingUploadBytes).toBe(0);
  // The replacement releases the concurrency slot exactly once.
  server.handleRpc(ws,chunk(0,2,true),platform);
  await vi.waitFor(()=>expect(platform.sent.some(reply=>reply.data.ok&&reply.data.data===2)).toBe(true));
  expect(handler).toHaveBeenCalledTimes(2);
 } finally { oldGuard.resolve();newGuard.resolve();await server.close(ws,{platform,subscriptions:[]}); }
});
