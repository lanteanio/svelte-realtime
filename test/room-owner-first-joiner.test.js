// Regression for the owner-badge race: a room `owner: true`'s first-and-only
// joiner must actually RECEIVE the claimed owner. The claim runs on the DATA
// stream subscribe while the client's owner value comes from the paired :owner
// sub-stream subscribe RESPONSE - two subscribes in one batch on one socket. A
// value emitted off the data-join (a live publish, or an earlier deferred
// unicast) can reach the socket BEFORE the client registered the :owner store
// from that response, and is dropped; the pre-claim null snapshot then wins.
//
// The fix SEQUENCES the claimed owner INTO the :owner subscribe response: a
// per-(socket, wire-topic) barrier is opened synchronously when the data-stream
// subscribe resolves its topic (dispatch, before any loader body in the batch),
// the data-join resolves it with the claimed owner, and the :owner loader awaits
// it and returns that value as its snapshot. These tests assert the value the
// loader RETURNS - i.e. the value the subscribe response carries and the client
// applies to its store - not the server-side-readable _ownerGet.

import { describe, it, expect, beforeEach } from 'vitest';
import { live, _presenceRefForTest } from '../src/server.js';
import { _resetOwnerForTests, _ownerGet, _ownerClaimBegin, _ownerClaimResolve } from '../src/server/room-owner.js';

const flush = () => new Promise((r) => setTimeout(r, 5));

function mkRoom(extra = {}) {
	return live.room({ topic: (ctx, id) => 'game:' + id, topicArgs: 1, init: async () => [], owner: true, ...extra });
}

function mkCtx(id, platform) {
	const noop = () => {};
	return { user: { id }, platform: platform || {}, publish: noop, _publishWire: noop, ws: { id: 'ws-' + id } };
}

// The dispatch batch for a room subscribe: open the claim barrier synchronously
// (what dispatch does at topic-resolution, before any loader body), then run the
// data-join and the :owner loader concurrently. Returns the loader's snapshot.
async function subscribeBatch(game, ctx, id, { delayJoin = 0, loaderFirst = true } = {}) {
	const wireTopic = 'game:' + id;
	_ownerClaimBegin(ctx.ws, wireTopic);

	const runJoin = async () => {
		if (delayJoin) await new Promise((r) => setTimeout(r, delayJoin));
		await game.__dataStream.__onSubscribe(ctx, wireTopic, [id]);
	};
	const runLoader = () => game.__ownerStream(ctx, id);

	// loaderFirst models the real hazard: the :owner loader reaches its read
	// BEFORE the data-join has claimed. It must await the claim, not read null.
	if (loaderFirst) {
		const snapshotP = runLoader();
		await runJoin();
		return snapshotP;
	}
	await runJoin();
	return runLoader();
}

describe('live.room owner - first-joiner delivery (sequenced snapshot)', () => {
	beforeEach(() => {
		_resetOwnerForTests();
		_presenceRefForTest().clear();
	});

	it('returns the CLAIMED owner as the :owner snapshot for the first-and-only joiner', async () => {
		const game = mkRoom();
		const ctx = mkCtx('alice');
		const snapshot = await subscribeBatch(game, ctx, 7);
		// The value the subscribe response carries - what the client applies. Never
		// the pre-claim null.
		expect(snapshot).toEqual({ key: 'alice', reason: 'claimed' });
	});

	it('holds the snapshot for the claim no matter how late the data-join lands (no trailing null)', async () => {
		// Models the subscribe response lagging behind its replay round-trips: the
		// loader starts, several ticks pass, THEN the claim resolves. A timer-based
		// delivery could not order after this; the sequenced barrier does.
		const game = mkRoom();
		const ctx = mkCtx('alice');
		const snapshot = await subscribeBatch(game, ctx, 7, { delayJoin: 15 });
		expect(snapshot).toEqual({ key: 'alice', reason: 'claimed' });
	});

	it('reads the claimed owner from the resolved barrier when the loader runs after the join', async () => {
		const game = mkRoom();
		const ctx = mkCtx('alice');
		const snapshot = await subscribeBatch(game, ctx, 7, { loaderFirst: false });
		expect(snapshot).toEqual({ key: 'alice', reason: 'claimed' });
	});

	it('a later non-claiming joiner reads the CURRENT owner from the shared store, not null', async () => {
		const game = mkRoom();
		await subscribeBatch(game, mkCtx('alice'), 7);      // alice claims
		const bobSnapshot = await subscribeBatch(game, mkCtx('bob'), 7); // no ownership change
		expect(bobSnapshot).toEqual({ key: 'alice', reason: null });
		await flush();
	});

	it('a lone :owner subscribe (no data-join in the batch) reads the shared store without hanging', async () => {
		const game = mkRoom();
		// Establish an owner first.
		await subscribeBatch(game, mkCtx('alice'), 7);
		// Now a bare :owner loader with NO barrier opened (no paired data-join this
		// batch): it must fall straight through to _ownerGet, never wait.
		const ctx = mkCtx('carol');
		const snapshot = await Promise.race([
			game.__ownerStream(ctx, 7),
			new Promise((_, rej) => setTimeout(() => rej(new Error('owner loader hung with no in-flight claim')), 50))
		]);
		expect(snapshot).toEqual({ key: 'alice', reason: null });
	});

	it('the dispatch settle unblocks the loader when the data-join takes an early path (never claims)', async () => {
		// A reconnect / full-map early return in the room hook resolves no claim; the
		// dispatch settle resolves the barrier to null so the loader falls back to
		// the shared store instead of waiting forever.
		const game = mkRoom();
		await subscribeBatch(game, mkCtx('alice'), 7); // alice is owner
		const ctx = mkCtx('dave');
		_ownerClaimBegin(ctx.ws, 'game:7');
		const snapshotP = game.__ownerStream(ctx, 7);
		// Simulate the dispatch settle firing after the room hook's early return.
		_ownerClaimResolve(ctx.ws, 'game:7', null);
		const snapshot = await Promise.race([
			snapshotP,
			new Promise((_, rej) => setTimeout(() => rej(new Error('owner loader hung after settle')), 50))
		]);
		expect(snapshot).toEqual({ key: 'alice', reason: null });
	});

	it('exposes the current owner via _ownerGet after the sequenced claim (server-side invariant)', async () => {
		const game = mkRoom();
		const ctx = mkCtx('alice');
		await subscribeBatch(game, ctx, 7);
		expect(await _ownerGet(ctx.platform, 'game:7')).toBe('alice');
	});
});
