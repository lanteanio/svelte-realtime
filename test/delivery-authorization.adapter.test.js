import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestServer } from 'svelte-adapter-uws/testing';

// The adapter capability decides which half of this file runs: an adapter
// with platform.authorizeDelivery enforces the policy natively, an adapter
// without it must refuse to start an app that opted in.
const probe = await createTestServer();
const NATIVE = typeof probe.platform.authorizeDelivery === 'function';
await probe.close();

const REFUSED = 1013;
let api, server;
const clients = [];
/** Authoritative state the policy reads on every delivery. */
let assigned;
let seen;

beforeEach(async () => {
	vi.resetModules();
	api = await import('../src/server.js');
	api.__register('scan/log', api.live.stream((_ctx, eventId) => 'scans:' + eventId, async (_ctx, eventId) => [{ id: 'seed-' + eventId }], { merge: 'crud', key: 'id' }));
	assigned = new Map();
	seen = [];
	// Refusals and shutdown log diagnostics by design.
	for (const method of ['warn', 'info', 'log']) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	await server?.close();
	server = null;
	vi.restoreAllMocks();
});

/** @param {(ctx: any, delivery: any) => any} [authorize] @param {any} [options] */
async function start(authorize = policy, options) {
	const hooks = api.realtime({ authorizeDelivery: authorize, ...(options ? { deliveryAuthorizationOptions: options } : {}) });
	const ids = [];
	const sockets = new Map();
	server = await createTestServer({ handler: {
		...hooks,
		open(ws, ctx) {
			const id = ids.shift();
			ws.getUserData().id = id;
			sockets.set(id, ws);
			return hooks.open?.(ws, ctx);
		}
	} });
	return {
		sockets,
		/** @param {string} id */
		async connect(id) {
			ids.push(id);
			const ws = new WebSocket(server.wsUrl);
			const client = { ws, frames: [], closeCode: null };
			clients.push(ws);
			ws.addEventListener('message', (event) => { if (typeof event.data === 'string') client.frames.push(JSON.parse(event.data)); });
			ws.addEventListener('close', (event) => { client.closeCode = event.code; });
			await vi.waitFor(() => expect(sockets.has(id)).toBe(true));
			return client;
		}
	};
}

/** Stream access is current only while the scanner is assigned to the event. */
function policy(ctx, delivery) {
	seen.push({ user: ctx.user.id, ...delivery });
	if (delivery.kind === 'request') return assigned.has(ctx.user.id);
	if (delivery.rpc === 'scan/log') return assigned.get(ctx.user.id)?.has(delivery.args[0]) === true;
	return false;
}
const grant = (user, eventId) => { if (!assigned.has(user)) assigned.set(user, new Set()); assigned.get(user).add(eventId); };
const revoke = (user) => assigned.delete(user);
const has = (client, nonce) => client.frames.some((frame) => JSON.stringify(frame).includes(nonce));
/** @param {any} client @param {string} eventId */
async function subscribe(client, eventId) {
	const id = 's-' + eventId + '-' + clients.length;
	client.ws.send(JSON.stringify({ rpc: 'scan/log', id, args: [eventId], stream: true }));
	await vi.waitFor(() => expect(client.frames.some((frame) => frame.topic === '__rpc' && frame.event === id && frame.data?.ok === true)).toBe(true));
}

describe.skipIf(NATIVE)('delivery authorization with an adapter that lacks platform.authorizeDelivery', () => {
	it('refuses to start an app that configured a delivery policy', async () => {
		const hooks = api.realtime({ authorizeDelivery: () => true });
		await expect(createTestServer({ handler: hooks })).rejects.toThrow('has no platform.authorizeDelivery');
	});
	it('starts an app without a delivery policy unchanged', async () => {
		server = await createTestServer({ handler: api.realtime({}) });
		expect(server.platform.authorizeDelivery).toBeUndefined();
	});
});

describe.skipIf(!NATIVE)('delivery authorization on the adapter policy (requires platform.authorizeDelivery)', () => {
	it('stops live frames to a revoked scanner and keeps an assigned scanner', async () => {
		const { connect } = await start();
		grant('victim', 'e1'); grant('control', 'e1');
		const victim = await connect('victim');
		const control = await connect('control');
		await subscribe(victim, 'e1');
		await subscribe(control, 'e1');
		server.platform.publish('scans:e1', 'created', { id: 'before' });
		await vi.waitFor(() => { expect(has(victim, 'before')).toBe(true); expect(has(control, 'before')).toBe(true); });
		expect(seen.find((d) => d.user === 'victim' && d.kind === 'message' && d.topic === 'scans:e1'))
			.toMatchObject({ rpc: 'scan/log', args: ['e1'], event: 'created', binary: false });
		revoke('victim');
		server.platform.publish('scans:e1', 'created', { id: 'after' });
		await vi.waitFor(() => expect(has(control, 'after')).toBe(true));
		await vi.waitFor(() => expect(victim.closeCode).toBe(REFUSED));
		expect(has(victim, 'after')).toBe(false);
	});

	it('checks the initial stream snapshot against current access', async () => {
		const { connect } = await start();
		const victim = await connect('victim');
		victim.ws.send(JSON.stringify({ rpc: 'scan/log', id: 'snap', args: ['e2'], stream: true }));
		await vi.waitFor(() => expect(victim.closeCode).toBe(REFUSED));
		expect(has(victim, 'seed-e2')).toBe(false);
		expect(seen.find((d) => d.kind === 'snapshot')).toMatchObject({ topic: 'scans:e2', rpc: 'scan/log', args: ['e2'], event: null });
	});
});
