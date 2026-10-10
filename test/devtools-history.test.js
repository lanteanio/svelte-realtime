import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __devtools, _devtoolsStream, _devtoolsStreamEvent, _devtoolsStart, _devtoolsEnd, _devtoolsVolatileSent, _devtoolsConnectionStatus } from '../src/client/devtools-instrument.js';

beforeEach(() => {
 vi.useFakeTimers();
 __devtools.unsafeCapturePayloads = false;
 __devtools.streams.clear();
 __devtools.paused = false;
 _devtoolsStream('chat', 'chat', 1);
});
afterEach(() => { __devtools.unsafeCapturePayloads = false; vi.useRealTimers(); });

describe('DevTools clear undo', () => {
 it('restores earlier events without discarding newer arrivals or exceeding the ring cap', () => {
  for (let i = 0; i < 20; i++) _devtoolsStreamEvent('chat', 'before-' + i);
  __devtools.clearEvents();
  expect(__devtools.undoClearCount).toBe(20);
  _devtoolsStreamEvent('chat', 'after');
  __devtools.undoClearEvents();
  const events = __devtools.streams.get('chat').recentEvents;
  expect(events).toHaveLength(20);
  expect(events[0].event).toBe('before-1');
  expect(events.at(-1).event).toBe('after');
  expect(__devtools.undoClearCount).toBe(0);
 });
 it('expires the snapshot, replaces it on another clear, and purges it on unsafe opt-out', () => {
  _devtoolsStreamEvent('chat', 'old');
  __devtools.clearEvents();
  _devtoolsStreamEvent('chat', 'new');
  __devtools.clearEvents();
  __devtools.undoClearEvents();
  expect(__devtools.streams.get('chat').recentEvents.map(event => event.event)).toEqual(['new']);
  __devtools.clearEvents();
  vi.advanceTimersByTime(30000);
  expect(__devtools.undoClearCount).toBe(0);
  __devtools.undoClearEvents();
  expect(__devtools.streams.get('chat').recentEvents).toEqual([]);
  _devtoolsStreamEvent('chat', 'private');
  __devtools.clearEvents();
  __devtools.unsafeCapturePayloads = false;
  expect(__devtools.undoClearCount).toBe(0);
 });
 it('does not restore events into a replacement stream with the same path', () => {
  _devtoolsStreamEvent('chat', 'old');
  __devtools.clearEvents();
  _devtoolsStream('chat', 'chat', 0);
  _devtoolsStream('chat', 'chat', 1);
  __devtools.undoClearEvents();
  expect(__devtools.streams.get('chat').recentEvents).toEqual([]);
 });
});

it('purges all retained payloads and undo snapshots on disconnect', () => {
 __devtools.unsafeCapturePayloads = true;
 _devtoolsStart('call', 'one', ['secret']);
 _devtoolsEnd('one', true, 'secret');
 _devtoolsStart('call', 'pending', ['secret']);
 _devtoolsVolatileSent('send', ['secret']);
 _devtoolsStream('chat', 'secret', 1);
 _devtoolsStreamEvent('chat', 'update', 'secret');
 __devtools.clearEvents();
 expect(__devtools.undoClearCount).toBe(1);
 _devtoolsConnectionStatus('disconnected');
 expect(__devtools.history.filter(Boolean)).toEqual([]);
 expect(__devtools.pending.get('pending')).toEqual({ path: 'call', args: [], startTime: expect.any(Number), payloadsCleared: true });
 _devtoolsEnd('pending', false, { code: 'DISCONNECTED' });
 expect(__devtools.volatile.filter(Boolean)).toEqual([]);
 expect(__devtools.streams.get('chat').topic).toBe('[topic omitted]');
 expect(__devtools.undoClearCount).toBe(0);
 expect(__devtools.unsafeCapturePayloads).toBe(false);
 expect(__devtools.paused).toBe(true);
});
