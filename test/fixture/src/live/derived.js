// Live module backing the derived-stream e2e tests.
//
// Activation: the test fixture's hooks.ws.js does not call
// `_activateDerived(platform)` in `open` (we are not allowed to
// modify hooks.ws.js for this slice). Instead, every RPC that
// publishes to a source topic ensures activation idempotently via
// `ctx.platform`. The first RPC call wraps platform.publish; later
// calls are no-ops thanks to the WeakSet guard inside the helper.

import { live, _activateDerived } from 'svelte-realtime/server';

let _activated = false;
function _ensureActivated(ctx) {
	if (_activated) return;
	_activated = true;
	_activateDerived(ctx.platform);
}

let counts = { orders: 0, users: 0 };
let _dashboardRecomputes = 0;
let _debouncedRecomputes = 0;
const _orgRecomputes = new Map();

const ORDERS_TOPIC = 'orders-topic';
const USERS_TOPIC = 'users-topic';

export const dashboardStats = live.derived(
	[ORDERS_TOPIC, USERS_TOPIC],
	async () => {
		_dashboardRecomputes++;
		return { id: 'dashboard', orders: counts.orders, users: counts.users, recomputeCount: _dashboardRecomputes };
	}
);

export const debouncedStats = live.derived(
	[ORDERS_TOPIC, USERS_TOPIC],
	async () => {
		_debouncedRecomputes++;
		return { id: 'debounced', orders: counts.orders, users: counts.users, recomputeCount: _debouncedRecomputes };
	},
	{ debounce: 200 }
);

export const orgStats = live.derived(
	(orgId) => ['memberships:' + orgId, 'audit:' + orgId],
	async (ctx, orgId) => {
		const next = (_orgRecomputes.get(orgId) || 0) + 1;
		_orgRecomputes.set(orgId, next);
		return { id: 'org:' + orgId, orgId, recomputed: next };
	}
);

export const incOrders = live(async (ctx) => {
	_ensureActivated(ctx);
	counts.orders++;
	ctx.publish(ORDERS_TOPIC, 'inc', counts.orders);
	return { orders: counts.orders };
});

export const incUsers = live(async (ctx) => {
	_ensureActivated(ctx);
	counts.users++;
	ctx.publish(USERS_TOPIC, 'inc', counts.users);
	return { users: counts.users };
});

export const incOrdersBurst = live(async (ctx, body) => {
	_ensureActivated(ctx);
	const n = (body && body.n) || 1;
	for (let i = 0; i < n; i++) {
		counts.orders++;
		ctx.publish(ORDERS_TOPIC, 'inc', counts.orders);
	}
	return { orders: counts.orders, fired: n };
});

export const publishOrgSource = live(async (ctx, body) => {
	_ensureActivated(ctx);
	const orgId = body && body.orgId;
	const kind = (body && body.kind) || 'memberships';
	ctx.publish(kind + ':' + orgId, 'changed', { orgId });
	return { ok: true };
});

export const getRecomputeCounts = live(async () => {
	const orgs = {};
	for (const [k, v] of _orgRecomputes) orgs[k] = v;
	return { dashboard: _dashboardRecomputes, debounced: _debouncedRecomputes, orgs };
});

export const resetDerived = live(async (ctx) => {
	_ensureActivated(ctx);
	counts = { orders: 0, users: 0 };
	_dashboardRecomputes = 0;
	_debouncedRecomputes = 0;
	_orgRecomputes.clear();
	ctx.publish(ORDERS_TOPIC, 'reset', 0);
	ctx.publish(USERS_TOPIC, 'reset', 0);
	return { ok: true };
});
