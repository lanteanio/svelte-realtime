// A tenant session reading another organization's audit log, end to end on the
// adapter's test server. The application guards the audit topics only with its
// own subscribe gate, written against logical topic names. A stream subscribe
// resolves the tenant-scoped wire topic on the server, and a raw wire subscribe
// names it on the client; in both, the gate must see the logical topic, and a
// topic of another tenant must never reach it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer } from 'svelte-adapter-uws/testing';
import { live, realtime, __register, _prepareHmr, _resetLifecycle } from '../src/server.js';
import { _resetTenantResolver } from '../src/server/tenant.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what) {
	const end = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= end) throw new Error('Timed out waiting for ' + what);
		await sleep(5);
	}
}

const AUDIT = [
	{ id: 'a1', org: 'acme', action: 'login' },
	{ id: 'g1', org: 'globex', action: 'wire transfer' }
];

let server;
let sockets;
let users;

/** The application gate: an audit topic only for members of its organization. */
function auditGate(ws, topic) {
	const match = /^audit:(acme|globex)$/.exec(topic);
	return match ? match[1] === ws.getUserData().org : true;
}

async function start(options = {}) {
	__register('auditlog/feed', live.stream(
		(ctx, org) => 'audit:' + org,
		async (ctx, org) => AUDIT.filter((row) => row.org === org),
		{ merge: 'crud', key: 'id' }
	));
	__register('auditlog/count', live.stream(
		(ctx, org) => 'audit:' + org,
		async (ctx, org) => ({ count: AUDIT.filter((row) => row.org === org).length }),
		{ merge: 'set' }
	));
	const hooks = realtime({ tenant: (user) => user.tenant ?? null, subscribe: auditGate, ...options });
	server = await createTestServer({ handler: { ...hooks, upgrade() { return users.shift(); } } });
}

async function connect(user) {
	users.push(user);
	const socket = new WebSocket(server.wsUrl);
	const frames = [];
	socket.addEventListener('message', ({ data }) => {
		if (typeof data !== 'string') return;
		const frame = JSON.parse(data);
		if (frame.type === 'batch' && Array.isArray(frame.events)) frames.push(...frame.events);
		else frames.push(frame);
	});
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', reject, { once: true });
	});
	sockets.push(socket);
	let next = 0;
	const reply = (id) => frames.find((f) => f.topic === '__rpc' && f.event === id && typeof f.data?.ok === 'boolean')?.data;
	return {
		frames,
		async stream(path, ...args) {
			const id = 's' + (++next);
			socket.send(JSON.stringify({ rpc: path, id, args, stream: true, attach: true }));
			await until(() => reply(id), 'the subscribe reply');
			return reply(id);
		},
		async wire(topic) {
			const ref = ++next;
			socket.send(JSON.stringify({ type: 'subscribe', topic, ref }));
			await until(() => frames.some((f) => f.ref === ref && (f.type === 'subscribed' || f.type === 'subscribe-denied')), 'the wire subscribe ack');
			return frames.find((f) => f.ref === ref);
		}
	};
}

beforeEach(() => {
	sockets = [];
	users = [];
	_resetLifecycle();
});

afterEach(async () => {
	for (const socket of sockets) socket.close();
	await server?.close();
	server = null;
	_resetTenantResolver();
	_prepareHmr();
});

describe('an application subscribe gate under tenancy, on the real adapter', () => {
	it('refuses another organization\'s audit log through a stream subscribe', async () => {
		await start();
		const alice = await connect({ id: 'alice', org: 'acme', tenant: 'acme' });
		const denied = await alice.stream('auditlog/feed', 'globex');
		expect(denied).toMatchObject({ ok: false, code: 'FORBIDDEN' });
		expect(JSON.stringify(alice.frames)).not.toContain('wire transfer');
		const own = await alice.stream('auditlog/feed', 'acme');
		expect(own).toMatchObject({ ok: true, topic: '@t/acme/audit:acme', data: [{ id: 'a1', org: 'acme', action: 'login' }] });
	});

	it('admits a second stream on the topic a connection already holds and keeps delivering to both', async () => {
		await start();
		const alice = await connect({ id: 'alice', org: 'acme', tenant: 'acme' });
		expect(await alice.stream('auditlog/feed', 'acme')).toMatchObject({ ok: true, topic: '@t/acme/audit:acme' });
		expect(await alice.stream('auditlog/count', 'acme')).toMatchObject({ ok: true, topic: '@t/acme/audit:acme', data: { count: 1 } });
		server.platform.publish('@t/acme/audit:acme', 'created', { id: 'a2', org: 'acme', action: 'export' });
		await until(() => alice.frames.some((f) => f.topic === '@t/acme/audit:acme' && f.event === 'created'), 'the live audit row');
	});

	it('refuses a raw wire subscribe to another tenant and gates the own one by its logical topic', async () => {
		await start({ authorizeWireSubscribe: false });
		const alice = await connect({ id: 'alice', org: 'acme', tenant: 'acme' });
		expect(await alice.wire('@t/globex/audit:globex')).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });
		expect(await alice.wire('@t/acme/audit:globex')).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });
		expect(await alice.wire('@t/acme/audit:acme')).toMatchObject({ type: 'subscribed' });
		const anonymous = await connect({ id: 'anon' });
		expect(await anonymous.wire('@t/acme/audit:acme')).toMatchObject({ type: 'subscribe-denied', reason: 'FORBIDDEN' });
	});
});
