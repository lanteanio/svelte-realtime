import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live, _resetCoalesceRegistry, _resetTransformRegistry, _resetRedactRegistry, _prepareHmr, _restoreHmr, unsubscribe } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { _setTenantResolver, _resetTenantResolver } from '../src/server/tenant.js';

let env;
beforeEach(() => { _resetCoalesceRegistry(); _resetTransformRegistry(); _resetRedactRegistry(); });
afterEach(() => { env?.cleanup(); _resetCoalesceRegistry(); _resetTransformRegistry(); _resetRedactRegistry(); _resetTenantResolver(); });
function setup(topic, options = {}) {
  env = createTestEnv();
  env.platform.relayCoalesced = vi.fn(() => true);
  env.platform.sendCoalesced = vi.fn(() => true);
  const stream = live.stream(topic, () => null, { merge: 'set', coalesceBy: value => value.id, transform: value => ({ price: value.price }), ...options });
  env.register('prices', { stream, write: live((ctx, destination, value) => ctx.publish(destination, 'set', value)) });
  return { stream, publisher: env.connect({ id: 'publisher', tenant: 'one' }) };
}

describe('declared coalescing', () => {
  it.each([false, true])('relays projected data and original keys before any local subscribe (tenant: %s)', async tenant => {
    if (tenant) _setTenantResolver(user => user.tenant);
    const { publisher } = setup('quotes');
    await expect(publisher.call('prices/write', 'quotes', { id: 'asset', price: 7 })).resolves.toBe(true);
    expect(env.platform.relayCoalesced).toHaveBeenCalledExactlyOnceWith(tenant ? '@t/one/quotes' : 'quotes', 'set', { price: 7 }, 'asset');
    expect(env.platform.sendCoalesced).not.toHaveBeenCalled();
  });

  it('publishes plainly without a local subscriber when the platform cannot relay coalesced envelopes', async () => {
    const { publisher } = setup('quotes');
    delete env.platform.relayCoalesced;
    const publish = vi.spyOn(env.platform, 'publish');
    await expect(publisher.call('prices/write', 'quotes', { id: 'asset', price: 5 })).resolves.toBe(true);
    expect(publish).toHaveBeenCalledWith('quotes', 'set', { id: 'asset', price: 5 }, undefined);
    expect(env.platform.sendCoalesced).not.toHaveBeenCalled();
  });

  it('publishes plainly without a local subscriber when the relay reaches no other worker', async () => {
    const { publisher } = setup('quotes');
    env.platform.relayCoalesced.mockReturnValue(false);
    const publish = vi.spyOn(env.platform, 'publish');
    await expect(publisher.call('prices/write', 'quotes', { id: 'asset', price: 5 })).resolves.toBe(true);
    expect(env.platform.relayCoalesced).toHaveBeenCalledExactlyOnceWith('quotes', 'set', { price: 5 }, 'asset');
    expect(publish).toHaveBeenCalledWith('quotes', 'set', { id: 'asset', price: 5 }, undefined);
    expect(env.platform.sendCoalesced).not.toHaveBeenCalled();
  });

  it.each([[true], [undefined]])('does not also publish plainly when the relay answers %s', async answer => {
    const { publisher } = setup('quotes');
    env.platform.relayCoalesced.mockReturnValue(answer);
    const publish = vi.spyOn(env.platform, 'publish');
    await expect(publisher.call('prices/write', 'quotes', { id: 'asset', price: 6 })).resolves.toBe(true);
    expect(env.platform.relayCoalesced).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalledWith('quotes', expect.anything(), expect.anything(), expect.anything());
  });

  it('keeps coalescing onto a local subscriber when the relay reaches no other worker', async () => {
    const { publisher } = setup('quotes');
    env.platform.relayCoalesced.mockReturnValue(false);
    const reader = env.connect({ id: 'reader' });
    await reader.subscribe('prices/stream').waitFor(value => value === null);
    const publish = vi.spyOn(env.platform, 'publish');
    await publisher.call('prices/write', 'quotes', { id: 'asset', price: 7 });
    expect(env.platform.sendCoalesced).toHaveBeenCalledTimes(1);
    expect(env.platform.sendCoalesced.mock.calls[0][1]).toMatchObject({ key: 'quotes\0asset', data: { price: 7 } });
    expect(publish).not.toHaveBeenCalledWith('quotes', expect.anything(), expect.anything(), expect.anything());
  });

  it.each(['disconnect', 'unsubscribe'])('keeps the declaration after the last %s and uses the new socket after reconnect', async ending => {
    const { publisher } = setup('quotes');
    const reader = env.connect({ id: 'reader' });
    await reader.subscribe('prices/stream').waitFor(value => value === null);
    await publisher.call('prices/write', 'quotes', { id: 'asset', price: 1 });
    expect(env.platform.sendCoalesced).toHaveBeenCalledTimes(1);
    if (ending === 'disconnect') reader.disconnect();
    else unsubscribe(env.platform.sendCoalesced.mock.calls[0][0], 'quotes', { platform: env.platform });
    await publisher.call('prices/write', 'quotes', { id: 'asset', price: 2 });
    expect(env.platform.sendCoalesced).toHaveBeenCalledTimes(1);
    expect(env.platform.relayCoalesced).toHaveBeenLastCalledWith('quotes', 'set', { price: 2 }, 'asset');
    const fresh = env.connect({ id: 'reader' });
    await fresh.subscribe('prices/stream').waitFor(value => value === null);
    await publisher.call('prices/write', 'quotes', { id: 'asset', price: 3 });
    expect(env.platform.sendCoalesced).toHaveBeenCalledTimes(2);
    expect(env.platform.sendCoalesced.mock.calls[1][0]).not.toBe(env.platform.sendCoalesced.mock.calls[0][0]);
    expect(env.platform.sendCoalesced.mock.calls[1][1]).toMatchObject({ key: 'quotes\0asset', data: { price: 3 } });
  });

  it('resolves literal-prefix factory topics without claiming another static declaration', async () => {
    const { publisher } = setup((_ctx, id) => `quotes:${id}`);
    env.register('other', { stream: live.stream('quotes:summary', () => null, { merge: 'set' }) });
    await publisher.call('prices/write', 'quotes:asset', { id: 'a', price: 4 });
    expect(env.platform.relayCoalesced).toHaveBeenCalledExactlyOnceWith('quotes:asset', 'set', { price: 4 }, 'a');
    await publisher.call('prices/write', 'quotes:summary', { total: 9 });
    expect(env.platform.relayCoalesced).toHaveBeenCalledTimes(1);
    await publisher.call('prices/write', 'quotes:asset:detail', { raw: true });
    expect(env.platform.relayCoalesced).toHaveBeenCalledTimes(1);
  });

  it.each(['coalesceBy', 'transform'])('routes a declared %s failure to its observer without a relay', async option => {
    const observer = vi.fn();
    const failure = new Error('invalid value');
    const { publisher } = setup('quotes', { [option]: () => { throw failure; }, onError: observer });
    await expect(publisher.call('prices/write', 'quotes', { id: 'a' })).resolves.toBe(false);
    expect(observer).toHaveBeenCalledExactlyOnceWith(failure, null, 'quotes');
    expect(env.platform.relayCoalesced).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'context property', factory: ctx => 'quotes:' + ctx.tenantId, probe: 'quotes:undefined', topic: 'quotes:one' },
    { name: 'optional context fallback', factory: (ctx, id) => `${ctx.user?.org ?? 'public'}:${id}`, probe: 'public:asset', topic: 'private:asset' },
    { name: 'context own keys', factory: (ctx, id) => `${Object.keys(ctx).length ? 'keys' : 'empty'}:${id}`, probe: 'keys:asset', topic: 'keys:asset' },
    { name: 'context prototype', factory: (ctx, id) => `${Object.getPrototypeOf(ctx) === Object.prototype ? 'plain' : 'other'}:${id}`, probe: 'other:asset', topic: 'plain:asset' },
    { name: 'caught context access', factory: (ctx, id) => { try { return `${ctx.user.org}:${id}`; } catch { return `fallback:${id}`; } }, probe: 'fallback:asset', topic: 'private:asset' },
    { name: 'object argument', factory: (_ctx, input) => 'quotes:' + input.id, probe: 'quotes:undefined', topic: 'quotes:asset', arg: { id: 'asset' } },
    { name: 'argument type fallback', factory: (_ctx, id) => typeof id === 'string' ? 'typed:' + id : 'fallback', probe: 'fallback', topic: 'typed:asset' },
    { name: 'conditional context access', factory: (ctx, id) => id === 'private' ? ctx.user.org + ':' + id : 'public:' + id, probe: 'public:private', topic: 'private:private', arg: 'private' }
  ])('rejects $name during declaration inference and resolves an actual subscription', async ({ factory, probe, topic, arg = 'asset' }) => {
    _setTenantResolver(user => user.tenant);
    const { publisher } = setup(factory);
    await publisher.call('prices/write', probe, { id: 'a', price: 1 });
    expect(env.platform.relayCoalesced).not.toHaveBeenCalled();
    const reader = env.connect({ id: 'reader', tenant: 'one', org: 'private' });
    await reader.subscribe('prices/stream', arg).waitFor(value => value === null);
    await publisher.call('prices/write', topic, { id: 'a', price: 2 });
    expect(env.platform.relayCoalesced).toHaveBeenCalledExactlyOnceWith('@t/one/' + topic, 'set', { price: 2 }, 'a');
    expect(env.platform.sendCoalesced).toHaveBeenCalledTimes(1);
  });

  it('round-trips conditional factories and repeated arguments before selecting a declaration', async () => {
    const { publisher } = setup((_ctx, id) => id === 'private' ? 'secret:' + id : 'public:' + id);
    await publisher.call('prices/write', 'public:private', { id: 'a', price: 1 });
    expect(env.platform.relayCoalesced).not.toHaveBeenCalled();
    await publisher.call('prices/write', 'public:asset', { id: 'a', price: 2 });
    expect(env.platform.relayCoalesced).toHaveBeenCalledExactlyOnceWith('public:asset', 'set', { price: 2 }, 'a');
    env.register('repeat', { stream: live.stream((_ctx, id) => 'repeat:' + id + '/' + id, () => null, { coalesceBy: data => data.id }) });
    await publisher.call('prices/write', 'repeat:one/two', { id: 'a' });
    expect(env.platform.relayCoalesced).toHaveBeenCalledTimes(1);
    await publisher.call('prices/write', 'repeat:one/one', { id: 'a' });
    expect(env.platform.relayCoalesced).toHaveBeenCalledTimes(2);
  });

  it('bounds remembered factory matches and verifies an evicted topic again', async () => {
    let calls = 0;
    const { publisher } = setup((_ctx, id) => { calls++; return 'cache:' + id; });
    await publisher.call('prices/write', 'cache:first', { id: 'a' });
    const first = calls;
    await publisher.call('prices/write', 'cache:first', { id: 'a' });
    expect(calls).toBe(first);
    for (let i = 0; i < 1000; i++) await publisher.call('prices/write', 'cache:' + i, { id: 'a' });
    const full = calls;
    await publisher.call('prices/write', 'cache:first', { id: 'a' });
    expect(calls).toBe(full + 1);
    expect(env.platform.relayCoalesced).toHaveBeenCalledTimes(1003);
  });

  it.each([
    ['rest', (...args) => 'quotes:' + args[1]],
    ['default', (_ctx, id = 'fallback') => 'quotes:' + id]
  ])('probes a topic argument declared through %s parameters', async (_name, factory) => {
    const { publisher } = setup(factory);
    await publisher.call('prices/write', 'quotes:asset', { id: 'asset', price: 3 });
    expect(env.platform.relayCoalesced).toHaveBeenCalledExactlyOnceWith('quotes:asset', 'set', { price: 3 }, 'asset');
  });

  it('caches non-matching topics and bounds their negative results', async () => {
    let calls = 0;
    const { publisher } = setup((_ctx, id) => { calls++; return id === 'private' ? 'secret:' + id : 'public:' + id; });
    await publisher.call('prices/write', 'public:private', { id: 'a' });
    const first = calls;
    await publisher.call('prices/write', 'public:private', { id: 'a' });
    expect(calls).toBe(first);
    for (let i = 0; i < 1000; i++) await publisher.call('prices/write', 'public:' + i, { id: 'a' });
    const full = calls;
    await publisher.call('prices/write', 'public:private', { id: 'a' });
    expect(calls).toBe(full + 1);
    await publisher.call('prices/write', 'public:1', { id: 'a' });
    expect(calls).toBe(full + 1);
    expect(env.platform.relayCoalesced).toHaveBeenCalledTimes(1001);
  });

  it('restores the original declaration after a failed reload replaces it', async () => {
    const { publisher } = setup('quotes');
    const snapshot = _prepareHmr();
    live.stream('quotes', () => null, { coalesceBy: () => 'wrong', transform: () => 'wrong' });
    _restoreHmr(snapshot);
    await publisher.call('prices/write', 'quotes', { id: 'asset', price: 8 });
    expect(env.platform.relayCoalesced).toHaveBeenCalledExactlyOnceWith('quotes', 'set', { price: 8 }, 'asset');
  });
});
