import { afterEach, describe, expect, it } from 'vitest';
import { live } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { _setTenantResolver, _resetTenantResolver } from '../src/server/tenant.js';

let env;
afterEach(() => { env?.cleanup(); env = null; _resetTenantResolver(); });

function setup() {
	_setTenantResolver((user) => user.tenant ?? null);
	env = createTestEnv();
	env.register('gate', { hit: live((ctx, key) => ctx.skip(key, 60_000)) });
}

describe('ctx.skip with tenancy', () => {
	it('keeps one tenant from gating another tenant that picked the same key', async () => {
		setup();
		const a = env.connect({ id: 'a', tenant: 'alpha' });
		const b = env.connect({ id: 'b', tenant: 'beta' });
		const key = 'move:' + Math.random();
		expect(await a.call('gate/hit', key)).toBe(false);
		expect(await b.call('gate/hit', key)).toBe(false);
		expect(await a.call('gate/hit', key)).toBe(true);
		expect(await b.call('gate/hit', key)).toBe(true);
	});

	it('keeps unscoped callers and tenants apart, including keys spelled like a tenant prefix', async () => {
		setup();
		const tenant = env.connect({ id: 't', tenant: 'alpha' });
		const unscoped = env.connect({ id: 'u' });
		const key = 'k' + Math.random();
		expect(await unscoped.call('gate/hit', '\0alpha\0' + key)).toBe(false);
		expect(await unscoped.call('gate/hit', 'alpha\0' + key)).toBe(false);
		expect(await tenant.call('gate/hit', key)).toBe(false);
		expect(await unscoped.call('gate/hit', key)).toBe(false);
		expect(await unscoped.call('gate/hit', key)).toBe(true);
	});

	it('still rejects a non-string key', async () => {
		setup();
		const a = env.connect({ id: 'a', tenant: 'alpha' });
		await expect(a.call('gate/hit', 42)).rejects.toMatchObject({ code: 'INVALID_ARG' });
	});
});
