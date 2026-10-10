import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __devtools, _devtoolsStream, _devtoolsStreamEvent } from '../src/client/devtools-instrument.js';

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
