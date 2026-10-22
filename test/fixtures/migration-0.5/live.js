// A 0.5-era server module: tenant metadata with a quota field and an erasure
// call that names no tenant. The migration rehearsal edits both lines.
import { live, realtime, __register } from 'svelte-realtime/server';

export const handler = realtime({ tenant: (user) => user?.tenant ?? null });

export const acme = live.tenant('acme', { metadata: { entitlement: 'team' }, quota: { rpcPerSecond: 100 } });

export const whoami = live((ctx) => ({ id: ctx.user.id, plan: acme.config?.metadata?.entitlement ?? null }));
__register('account/whoami', whoami);

export function eraseUser(userId, tenantId) {
	return live.forget(userId);
}
