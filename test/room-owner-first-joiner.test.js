// Regression for the owner-badge race: a room `owner: true`'s first-and-only
// joiner must actually RECEIVE the claimed owner, not merely have it readable
// server-side via _ownerGet. The claim's live emit races the joiner's own
// owner-stream subscribe response (the client attaches its on(:owner) listener
// only when that response lands, behind its Redis round-trips), so the emit can
// be dropped before the topic store exists. The fix delivers the owner as a
// deferred, targeted unicast to the joining socket - this asserts that delivery.

import { describe, it, expect, beforeEach } from 'vitest';
import { live, _presenceRefForTest } from '../src/server.js';
import { _resetOwnerForTests } from '../src/server/room-owner.js';

const flush = () => new Promise((r) => setTimeout(r, 5));

function mkRoom(extra = {}) {
	return live.room({ topic: (ctx, id) => 'game:' + id, topicArgs: 1, init: async () => [], owner: true, ...extra });
}

function mkCtx(id, platform) {
	const noop = () => {};
	return { user: { id }, platform, publish: noop, _publishWire: noop, ws: { id: 'ws-' + id } };
}

describe('live.room owner - first-joiner delivery (targeted unicast)', () => {
	beforeEach(() => {
		_resetOwnerForTests();
		_presenceRefForTest().clear();
	});

	it('unicasts the claimed owner to the first joiner socket, deferred past its subscribe response', async () => {
		const game = mkRoom();
		const ds = game.__dataStream;
		const sends = [];
		const platform = { send: (w, topic, event, data) => { sends.push({ w, topic, event, data }); } };
		const ctx = mkCtx('alice', platform);

		await ds.__onSubscribe(ctx, 'game:7', [7]);
		// Nothing delivered synchronously: the unicast must land AFTER this join's
		// own subscribe response so the client has attached its on(:owner) listener.
		expect(sends).toHaveLength(0);
		await flush();

		const ownerSend = sends.find((s) => s.topic === 'game:7:owner');
		expect(ownerSend, 'the first joiner must receive a targeted owner set').toBeTruthy();
		expect(ownerSend.w).toBe(ctx.ws);          // targeted at the joining socket, not a broadcast
		expect(ownerSend.event).toBe('set');
		expect(ownerSend.data.key).toBe('alice');  // the DELIVERED owner value (not _ownerGet)
	});

	it('unicasts only for the claiming join, not for a later non-claiming joiner', async () => {
		const game = mkRoom();
		const ds = game.__dataStream;
		const sends = [];
		const platform = { send: (w, topic, event, data) => { sends.push({ w, topic, event, data }); } };

		await ds.__onSubscribe(mkCtx('alice', platform), 'game:7', [7]); // claims
		await ds.__onSubscribe(mkCtx('bob', platform), 'game:7', [7]);   // no ownership change
		await flush();

		const ownerSends = sends.filter((s) => s.topic === 'game:7:owner');
		expect(ownerSends).toHaveLength(1);
		expect(ownerSends[0].data.key).toBe('alice');
		expect(ownerSends[0].w.id).toBe('ws-alice');
	});

	it('is best-effort: an adapter without send() must not break the join', async () => {
		const game = mkRoom();
		const ds = game.__dataStream;
		// platform with no send method (older adapter) - join still succeeds.
		await expect(ds.__onSubscribe(mkCtx('alice', {}), 'game:7', [7])).resolves.not.toThrow;
		await flush();
	});
});
