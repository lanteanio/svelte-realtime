import { afterEach, expect, it } from 'vitest';
import { createTestServer } from 'svelte-adapter-uws/testing';
import { live, setBus, handleRpc, __register, __registerEffect, _activateDerived, _prepareHmr } from '../src/server.js';

let server, socket;
afterEach(async () => {
  setBus(null);
  if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
  await server?.close();
  _prepareHmr();
});
const wait = async predicate => {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for batch delivery');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

it.each([false, true])('relays each real adapter batch item once and preserves watchers (batch capability: %s)', async capable => {
  server = await createTestServer({ handler: { message(ws, ctx) {
    if (!ctx.isBinary && ctx.msg === undefined) handleRpc(ws, ctx.data, server.platform);
  } } });
  const relays = [], effects = [], options = [];
  let failBatch = false;
  const localBatch = server.platform.publishBatched;
  server.platform.publishBatched = (batch, opts) => { if (failBatch) throw new Error('batch failure'); options.push(opts); return localBatch(batch, opts); };
  setBus({ wrap(platform) { return {
    publish(topic, event, data, opts) {
      const result = platform.publish(topic, event, data, opts);
      if (opts?.relay !== false) relays.push({ topic, data });
      return result;
    },
    publishBatched(batch, opts) {
      const result = platform.publishBatched(batch, opts);
      for (const item of batch) if (item.options?.relay !== false) relays.push({ topic: item.topic, data: item.data });
      return result;
    }
  }; } });
  __register('batch/feed', live.stream('batch:feed', () => []));
  __registerEffect('batch/effect', live.effect(['batch:feed'], (event, data, platform) => {
    effects.push(data);
    platform.publish('batch:derived', 'set', data);
  }));
  _activateDerived(server.platform);
  const frames = [];
  socket = new WebSocket(server.wsUrl);
  socket.addEventListener('message', ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.type === 'batch' && Array.isArray(frame.events)) frames.push(...frame.events); else frames.push(frame);
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  if (capable) socket.send(JSON.stringify({ type: 'hello', caps: ['batch'] }));
  socket.send(JSON.stringify({ rpc: 'batch/feed', id: 'subscribe', args: [], stream: true }));
  await wait(() => frames.some(frame => frame.event === 'subscribe'));
  server.platform.publishBatched([1, 2, 3].map(data => ({ topic: 'batch:feed', event: 'set', data })), { compress: true });
  await wait(() => frames.filter(frame => frame.topic === 'batch:feed').length === 3 && effects.length >= 3);
  expect(frames.filter(frame => frame.topic === 'batch:feed').map(frame => frame.data)).toEqual([1, 2, 3]);
  expect(relays.filter(item => item.topic === 'batch:feed').map(item => item.data)).toEqual([1, 2, 3]);
  expect(relays.filter(item => item.topic === 'batch:derived').map(item => item.data)).toEqual([1, 2, 3]);
  expect(options).toEqual([{ compress: true }]);
  expect(effects).toEqual([1, 2, 3]);
  failBatch = true;
  expect(() => server.platform.publishBatched([{ topic: 'batch:feed', event: 'set', data: 99 }])).toThrow('batch failure');
  server.platform.publish('batch:feed', 'set', 4);
  await wait(() => effects.length >= 4);
  expect(relays.filter(item => item.topic === 'batch:feed').map(item => item.data)).toEqual([1, 2, 3, 4]);
  expect(effects).toEqual([1, 2, 3, 4]);
});
