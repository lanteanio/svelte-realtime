// Regression for the owner-badge race, driven through the REAL dispatch path -
// no hand-simulated barrier. The real client batches a room's data-stream and
// :owner sub-stream subscribes into ONE wire frame; the first-and-only joiner
// claims ownership on the data-join while the :owner loader reads its snapshot
// concurrently. The value the client applies to its owner store is the :owner
// subscribe RESPONSE. This test feeds that exact batch frame to `handleRpc` and
// asserts the delivered response - so it exercises fn.__hasOwner -> the claim
// barrier -> the data-join -> the :owner loader end to end, and fails if any
// link is broken (including the __hasOwner flag being set on the wrong object,
// which silently no-ops the barrier and is exactly what a hand-simulated test
// could not catch).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { live } from '../src/server.js';
import { createTestEnv } from '../src/testing.js';
import { handleRpc } from '../src/server/dispatch.js';

const textEncoder = new TextEncoder();
const settle = () => new Promise((r) => setTimeout(r, 20));

function ownerRoomModule() {
	return { room: live.room({ topic: (ctx, id) => 'game:' + id, topicArgs: 1, init: async () => [], owner: true }) };
}

// A real ws wired to env.platform: subscribe registers the topic (so the wire
// gate passes) and _onSend captures every server response by correlation id.
function openConn(env, userData) {
	const responses = new Map();
	const topics = new Set();
	const ws = {
		getUserData: () => userData,
		subscribe: (t) => { topics.add(t); return true; },
		unsubscribe: (t) => { topics.delete(t); return true; },
		isSubscribed: (t) => topics.has(t),
		getTopics: () => [...topics],
		_onSend: (topic, event, data) => { if (topic === '__rpc') responses.set(event, data); }
	};
	env.platform.connections++;
	return { ws, responses };
}

// Send one wire batch frame (data + :owner subscribes together, as the client
// does) through real dispatch and return the per-id results.
async function subscribeRoomBatch(env, conn, id) {
	const frame = {
		batch: [
			{ rpc: 'game/room/__data', id: 'd', args: [id], stream: true },
			{ rpc: 'game/room/__owner', id: 'o', args: [id], stream: true }
		]
	};
	handleRpc(conn.ws, textEncoder.encode(JSON.stringify(frame)).buffer, env.platform);
	await settle();
	const batchResp = conn.responses.get('__batch');
	const byId = {};
	if (batchResp && Array.isArray(batchResp.batch)) {
		for (const r of batchResp.batch) byId[r.id] = r;
	}
	return byId;
}

describe('live.room owner - first-joiner delivery (real dispatch, batched subscribe)', () => {
	let env;

	beforeEach(() => {
		env = createTestEnv();
		env.register('game', ownerRoomModule());
	});

	afterEach(() => {
		env.cleanup();
	});

	it('delivers the claimed owner in the :owner subscribe response to the first-and-only joiner', async () => {
		const alice = openConn(env, { id: 'alice' });
		const res = await subscribeRoomBatch(env, alice, 7);

		expect(res.o).toBeDefined();
		expect(res.o.ok).toBe(true);
		// The value the client applies to its :owner store. Must be the claimed
		// owner, never the pre-claim null snapshot.
		expect(res.o.data).toEqual({ key: 'alice', reason: 'claimed' });
	});

	it('a later non-claiming joiner reads the current owner (not null) in its :owner response', async () => {
		const alice = openConn(env, { id: 'alice' });
		await subscribeRoomBatch(env, alice, 7); // alice claims

		const bob = openConn(env, { id: 'bob' });
		const res = await subscribeRoomBatch(env, bob, 7); // no ownership change
		expect(res.o.ok).toBe(true);
		expect(res.o.data).toEqual({ key: 'alice', reason: null });
	});

	it('wires __hasOwner onto the resolved data-stream handler dispatch reads, not only the export', () => {
		// Direct backstop for the exact object-mixup class: dispatch opens the
		// barrier off fn.__hasOwner where fn is the data-stream handler registered
		// at <room>/__data. If the flag lands only on the public room export, the
		// barrier never opens and the e2e delivery above silently regresses.
		const { room } = ownerRoomModule();
		expect(room.__dataStream.__hasOwner).toBe(true);
		expect(room.__hasOwner).toBe(true);
	});
});
