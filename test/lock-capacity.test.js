import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { live, _resetLock } from '../src/server.js';
import { state } from '../src/server/state.js';
import { createTestEnv } from '../src/testing.js';
import { _setTenantResolver, _resetTenantResolver } from '../src/server/tenant.js';
import { installFakeRuntimeClock, releaseRuntimeClock } from './helpers/runtime-clock.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let env;
beforeEach(() => { _resetLock(); state.metricsInstruments = null; });
afterEach(() => { _resetLock(); env?.cleanup(); env = null; state.metricsInstruments = null; _resetTenantResolver(); vi.useRealTimers(); releaseRuntimeClock(); });
const fakeTime = () => { vi.useFakeTimers(); installFakeRuntimeClock(); };

describe('bounded lock queues', () => {
  it('admits 1000 waiting calls by default and rejects overflow without running it', async () => {
    const gate = deferred();
    const entered = [];
    const run = live.lock('bounded', async (_ctx, id) => { entered.push(id); if (id === 'holder') await gate.promise; return id; });
    const holder = run({}, 'holder');
    const waiting = Array.from({ length: 1000 }, (_, i) => run({}, i));
    await expect(run({}, 'overflow')).rejects.toMatchObject({ code: 'LOCK_QUEUE_FULL' });
    expect(entered).toEqual(['holder']);
    gate.resolve();
    await holder;
    expect(await Promise.all(waiting)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    expect(entered).not.toContain('overflow');
    expect(state.lockWaiterCount).toBe(0);
  });

  it('delivers typed overflow through RPC while a different tenant remains independent', async () => {
    _setTenantResolver(user => user.tenant);
    const gate = deferred(), started = deferred();
    env = createTestEnv();
    env.register('locks', { run: live.lock({ key: 'shared', maxWaitersPerKey: 1 }, async (_ctx, wait) => { if (wait) { started.resolve(); await gate.promise; } return 'ok'; }) });
    const one = env.connect({ id: 'one', tenant: 'one' });
    const two = env.connect({ id: 'two', tenant: 'two' });
    const holder = one.call('locks/run', true);
    await started.promise;
    const waiter = one.call('locks/run', false);
    await vi.waitFor(() => expect(state.lockWaiterCount).toBe(1));
    await expect(one.call('locks/run', false)).rejects.toMatchObject({ code: 'LOCK_QUEUE_FULL' });
    await expect(two.call('locks/run', false)).resolves.toBe('ok');
    gate.resolve();
    await Promise.all([holder, waiter]);
  });

  it.each([0, 1, 2])('unlinks expired position %s, reuses capacity immediately and preserves FIFO', async expired => {
    fakeTime();
    const gate = deferred(), entered = [];
    const handler = async (_ctx, id) => { entered.push(id); if (id === 'holder') await gate.promise; return id; };
    const ordinary = live.lock({ key: 'queue', maxWaitersPerKey: 3 }, handler);
    const expiring = live.lock({ key: 'queue', maxWaitersPerKey: 3, maxWaitMs: 10 }, handler);
    const holder = ordinary({}, 'holder');
    const waiting = Array.from({ length: 3 }, (_, i) => (i === expired ? expiring : ordinary)({}, i).catch(error => error.code));
    await vi.advanceTimersByTimeAsync(10);
    expect(await waiting[expired]).toBe('LOCK_TIMEOUT');
    const replacement = ordinary({}, 'replacement');
    expect(entered).toEqual(['holder']);
    gate.resolve();
    await Promise.all([holder, ...waiting, replacement]);
    expect(entered).toEqual(['holder', ...[0, 1, 2].filter(i => i !== expired), 'replacement']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('makes timed-out caller payloads collectable while their holder remains pending', () => {
    const module = new URL('../src/server.js', import.meta.url).href;
    const script = `import { live, _resetLock } from ${JSON.stringify(module)};
      import assert from 'node:assert/strict';
      let release, reference;
      const gate = new Promise(resolve => { release = resolve; });
      const run = live.lock({ key:'retention', maxWaitMs:5 }, async (ctx, hold) => { if (hold) await gate; return ctx.payload; });
      const holder = run({}, true);
      async function enqueue() {
        let payload = { privateData: new Array(1024).fill('payload') };
        reference = new WeakRef(payload);
        await run({payload}, false).catch(error => assert.equal(error.code, 'LOCK_TIMEOUT'));
        payload = null;
      }
      await enqueue();
      for (let i=0;i<8;i++) { await new Promise(setImmediate); global.gc(); }
      assert.equal(reference.deref(), undefined, 'expired caller is still retained by the active queue');
      release(); await holder; _resetLock();`;
    expect(() => execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { encoding:'utf8', timeout:20000, windowsHide:true })).not.toThrow();
  }, 25000);

  it('exports queue counts and bounded status labels without lock keys', async () => {
    fakeTime();
    const events = [], gauges = [];
    live.metrics({
      counter: ({name}) => ({ inc: labels => { if (name === 'svelte_realtime_lock_events_total') events.push(labels); } }),
      histogram: () => ({ observe() {} }),
      gauge: ({name}) => ({ inc() {}, dec() {}, set: value => { if (name === 'svelte_realtime_lock_waiters') gauges.push(value); } })
    });
    const gate = deferred();
    const run = live.lock({ key:'private-user-key', maxWaitersPerKey:1, maxWaitMs:10 }, async (_ctx, hold) => { if (hold) await gate.promise; });
    const holder = run({}, true);
    const waiter = run({}, false).catch(error => error.code);
    await expect(run({}, false)).rejects.toMatchObject({ code:'LOCK_QUEUE_FULL' });
    await vi.advanceTimersByTimeAsync(10);
    expect(await waiter).toBe('LOCK_TIMEOUT');
    expect(gauges).toEqual([0,1,0]);
    expect(events).toEqual([{status:'queued'},{status:'queue_full'},{status:'wait_timeout'}]);
    gate.resolve(); await holder;
  });

  it('aborts on execution timeout but keeps exclusion until the handler actually settles', async () => {
    fakeTime();
    const firstGate = deferred(), secondGate = deferred(), entered = [], signals = [];
    const peerSignal = vi.fn();
    const run = live.lock({ key:'deadline', maxWaitersPerKey:1, maxExecutionMs:10 }, async (ctx, id) => {
      entered.push(id); signals.push(ctx.lockSignal); expect(ctx.signal).toBe(peerSignal);
      await (id === 'first' ? firstGate.promise : secondGate.promise);
      return id;
    });
    const first = run({signal:peerSignal}, 'first').catch(error => error.code);
    const second = run({signal:peerSignal}, 'second').catch(error => error.code);
    await vi.advanceTimersByTimeAsync(10);
    expect(await first).toBe('LOCK_EXECUTION_TIMEOUT');
    expect(signals[0].aborted).toBe(true);
    expect(entered).toEqual(['first']);
    await expect(run({signal:peerSignal}, 'overflow')).rejects.toMatchObject({code:'LOCK_QUEUE_FULL'});
    firstGate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(entered).toEqual(['first','second']);
    await vi.advanceTimersByTimeAsync(9);
    expect(signals[1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toBe('LOCK_EXECUTION_TIMEOUT');
    expect(signals[1].aborted).toBe(true);
    secondGate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans deadline timers on success, failure and custom-lock use', async () => {
    fakeTime();
    const custom = { withLock: vi.fn(async (_key, fn) => fn()) };
    const run = live.lock({key:'custom', lock:custom, maxWaitMs:9, maxExecutionMs:10}, async ctx => { expect(ctx.lockSignal.aborted).toBe(false); return 'ok'; });
    await expect(run({})).resolves.toBe('ok');
    expect(custom.withLock.mock.calls[0][2]).toEqual({maxWaitMs:9});
    const error = new Error('handler failed');
    await expect(live.lock({key:'throws', maxExecutionMs:10}, () => { throw error; })({})).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects unsupported capacities and deadlines at declaration, including inert custom capacity', async () => {
    const fn = () => 1;
    for (const maxWaitersPerKey of [-1,0.1,NaN,Infinity,'1']) expect(() => live.lock({key:'x',maxWaitersPerKey},fn)).toThrow(/maxWaitersPerKey/);
    for (const maxExecutionMs of [-1,NaN,Infinity,2147483648,'1']) expect(() => live.lock({key:'x',maxExecutionMs},fn)).toThrow(/maxExecutionMs/);
    expect(() => live.lock({key:'x',maxWaitMs:2147483648},fn)).toThrow(/maxWaitMs/);
    expect(() => live.lock({key:'x',maxWaitersPerKey:1,lock:{withLock(){}}},fn)).toThrow(/custom lock instance/);
    const gate = deferred();
    const run = live.lock({key:'zero',maxWaitersPerKey:0}, () => gate.promise);
    const holder = run({});
    await expect(run({})).rejects.toMatchObject({code:'LOCK_QUEUE_FULL'});
    gate.resolve(); await holder;
  });
});
