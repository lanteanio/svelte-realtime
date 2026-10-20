import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { live, configureForget, configureWebhooks, pushHooks, _resetForget, _resetPushRegistry } from '../src/server.js';
import { _pushRegistry } from '../src/server/push.js';
import { _resetTenantResolver } from '../src/server/tenant.js';
import { state } from '../src/server/state.js';

function reset() {
	_resetForget();
	_resetPushRegistry();
	_resetTenantResolver();
	configureWebhooks({ deadLetter: false });
}
beforeEach(reset);
afterEach(reset);

function register() {
	pushHooks.open({ getUserData: () => ({ userId: 'member' }) }, { platform: {} });
}

function configure(kind) {
	if (kind === 'built-in dead-letter') {
		configureWebhooks({ deadLetter: true });
		return vi.spyOn(state.webhookDeadLetter, 'purgeUser');
	}
	const purgeUser = vi.fn(async () => 0);
	if (kind === 'durable') configureForget({ store: { purgeUser } });
	else configureWebhooks({ deadLetter: { purgeUser } });
	return purgeUser;
}

describe('forget scope with configured tenant-qualified stores', () => {
	it.each(['durable', 'custom dead-letter', 'built-in dead-letter'])('rejects omitted scope before any purge with a %s store', async kind => {
		const purge = configure(kind);
		register();
		for (const options of [undefined, {}, { tenantId: undefined }]) {
			await expect(live.forget('member', options)).rejects.toMatchObject({
				code: 'INVALID_REQUEST', message: expect.stringContaining('tenantId')
			});
			expect(_pushRegistry.has('member')).toBe(true);
			expect(purge).not.toHaveBeenCalled();
		}
	});

	it.each(['durable', 'custom dead-letter', 'built-in dead-letter'])('accepts explicit null scope with a %s store', async kind => {
		const purge = configure(kind);
		register();
		await expect(live.forget('member', { tenantId: null })).resolves.toMatchObject({
			ok: true, surfaces: { push: 1 }
		});
		expect(_pushRegistry.has('member')).toBe(false);
		expect(purge.mock.calls).toEqual([kind === 'durable' ? [null, 'member', true] : [null, 'member']]);
	});

	it('retains the durable scope requirement through partial configuration and removes it when cleared', async () => {
		const purge = configure('durable');
		configureForget({ hashKey: 'a'.repeat(32), platform: {} });
		await expect(live.forget('member')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		expect(purge).not.toHaveBeenCalled();
		configureForget({ store: null });
		register();
		await expect(live.forget('member')).resolves.toMatchObject({ surfaces: { push: 1 } });
	});

	it('keeps requiring scope until every configured erasure store is cleared', async () => {
		configure('durable');
		configure('custom dead-letter');
		configureForget(null);
		configureWebhooks({ budget: false });
		await expect(live.forget('member')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		configureWebhooks({ deadLetter: false });
		register();
		await expect(live.forget('member')).resolves.toMatchObject({ surfaces: { push: 1 } });
	});

	it('preserves omitted scope with no stores, including platform and audit-key configuration', async () => {
		register();
		await expect(live.forget('member')).resolves.toMatchObject({ surfaces: { push: 1 } });
		configureForget({ platform: {}, hashKey: 'a'.repeat(32) });
		register();
		await expect(live.forget('member', {})).resolves.toMatchObject({ surfaces: { push: 1 } });
	});
});
