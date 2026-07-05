// @ts-check
import { live } from '../server.js';
import { _getIdentityKey } from './identity.js';
import { _clusterPresenceMerge } from './presence.js';
import { _tenantTopic } from './tenant.js';

// Seam: the shared topic-fn resolver (_callTopicFn) stays in server.js (used by
// several live.* families); multiplayer registration reaches it through this,
// set at init (mirrors installSmooth).
let _callTopicFn;
export function installMultiplayer(seams) {
	_callTopicFn = seams.callTopicFn;
}

export const _multiplayerRegister = function multiplayer(config) {
	const topicFn = config && config.topic;
	if (typeof topicFn !== 'function') {
		throw new Error(
			`[svelte-realtime] live.multiplayer() requires a topic function (ctx, ...args) => string\n  See: https://svti.me/multiplayer`
		);
	}

	// A presence field (typing / locks / selections) is stamped on a roster
	// entry, and a roster entry only exists once presence has been set. Without
	// a presence function there is no entry to carry the field, so the field
	// would publish but never persist for a late joiner. Reactions are exempt:
	// they ride their own ephemeral sub-topic and never touch the roster.
	if ((config.typing || config.locks || config.selections) && typeof config.presence !== 'function') {
		const declared = config.typing ? 'typing' : (config.locks ? 'locks' : 'selections');
		throw new Error(
			`[svelte-realtime] live.multiplayer() declares the '${declared}' presence field but has no presence function. Presence fields are stamped on a roster entry that only exists when presence is set, so add a presence function. Reactions do not require presence.\n  See: https://svti.me/multiplayer`
		);
	}

	// A multiplayer export is a room export with a marker stamped on top. It
	// reuses live.room's sub-stream construction verbatim so the data /
	// presence / cursor streams, the presence-ref auto-join, and the scoped
	// actions are byte-identical to a room. The codegen and the dev-direct
	// loader dispatch on __isRoom for the sub-streams; the __isMultiplayer
	// marker only adds the collaborative client surface.
	const roomExport = live.room({
		topic: topicFn,
		init: config.init ? config.init : async () => [],
		presence: config.presence,
		cursors: config.cursors,
		guard: config.guard,
		onJoin: config.onJoin,
		onLeave: config.onLeave,
		merge: config.merge,
		key: config.key,
		actions: config.actions,
		topicArgs: config.topicArgs,
		history: config.history,
		owner: config.owner,
		ownerOnly: config.ownerOnly,
		onOwnerChange: config.onOwnerChange
	});

	/** @type {any} */ (roomExport).__isMultiplayer = true;

	// Cursor send path. The client `move` / `reportViewport` methods are
	// volatile RPCs (fire-and-forget, lossy under disconnect is the contract)
	// that publish an `update` frame keyed by the caller's identity onto the
	// room's `:cursors` sub-topic - the same topic the cursor stream loads and
	// merges with `merge: 'cursor'`. The leading args identify the room (the
	// same count the topic function and room actions use); the trailing args
	// are the cursor payload, normalized to a flat object the cursor merge can
	// key by `.key`.
	const _cursorArgCount = config.topicArgs !== undefined
		? config.topicArgs
		: Math.max(0, topicFn.length - 1);

	/**
	 * @param {any} ctx
	 * @param {any[]} args
	 * @param {Record<string, any>} extra
	 */
	const _publishCursor = (ctx, args, extra) => {
		const roomArgs = args.slice(0, _cursorArgCount);
		const payload = args.slice(_cursorArgCount);
		const cursorTopic = _callTopicFn(topicFn, ctx, roomArgs) + ':cursors';
		const key = _getIdentityKey(ctx);
		const frame = { key, ...extra };
		const cur = payload[0];
		if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
			Object.assign(frame, cur);
		} else if (payload.length > 0) {
			frame.value = payload.length === 1 ? cur : payload;
		}
		ctx.publish(cursorTopic, 'update', frame);
	};

	const _cursorGuard = config.guard;
	/** @type {any} */ (roomExport).__cursorMove = live.volatile(async (ctx, ...args) => {
		if (_cursorGuard) await _cursorGuard(ctx, ...args.slice(0, _cursorArgCount));
		_publishCursor(ctx, args, {});
	});
	/** @type {any} */ (roomExport).__cursorReportViewport = live.volatile(async (ctx, ...args) => {
		if (_cursorGuard) await _cursorGuard(ctx, ...args.slice(0, _cursorArgCount));
		_publishCursor(ctx, args, { viewport: true });
	});

	// Presence-field send path. The typing / selection / lock surfaces are
	// presence fields: a caller publishes a delta keyed by its own identity onto
	// the room's `:presence` sub-topic, the same topic the presence stream loads
	// and merges with `merge: 'presence'`. The `update` event shallow-merges the
	// changed fields into the caller's roster entry, so every subscriber's roster
	// gains the new field value. The leading args identify the room (the same
	// count the topic function and cursor send path use); the trailing arg is a
	// flat `{ field: value }` delta object.
	//
	// Locks here are advisory presence locks: each caller stamps `lock:<key>` on
	// its own entry (the server keys the entry by the caller's identity, so the
	// holder is the entry owner), so a plain keyed publish is correct with no
	// arbitration - releasing clears the field, and a leave drops the entry so
	// derived holders recompute. This is awareness, not mutual exclusion.
	/**
	 * @param {any} ctx
	 * @param {any[]} args
	 */
	const _publishPresenceField = (ctx, args) => {
		const roomArgs = args.slice(0, _cursorArgCount);
		const delta = args[_cursorArgCount];
		const presenceTopic = _callTopicFn(topicFn, ctx, roomArgs) + ':presence';
		const key = _getIdentityKey(ctx);
		const frame = { key };
		if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
			Object.assign(frame, delta);
		}
		ctx.publish(presenceTopic, 'update', frame);
	};

	/** @type {any} */ (roomExport).__presenceUpdate = live.volatile(async (ctx, ...args) => {
		if (_cursorGuard) await _cursorGuard(ctx, ...args.slice(0, _cursorArgCount));
		_publishPresenceField(ctx, args);
		// Persist the sticky subset onto the roster after the forward publish so a
		// late joiner who loads the roster still sees it. selection (when
		// selections are enabled) and lock:<k> (when locks are enabled) are sticky;
		// typing and everything else stay ephemeral. Reactions ride a separate path.
		const delta = args[_cursorArgCount];
		if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
			const sticky = {};
			for (const k of Object.keys(delta)) {
				if (k === 'selection') { if (config.selections) sticky[k] = delta[k]; }
				else if (k.slice(0, 5) === 'lock:') { if (config.locks) sticky[k] = delta[k]; }
			}
			if (Object.keys(sticky).length > 0) {
				// The roster store is keyed by the WIRE data topic (the data-stream's
				// onSubscribe acquired it tenant-prefixed); prefix here too so the sticky
				// field lands on the same entry. The forward `:presence` publish above
				// uses ctx.publish (logical -> the scoped wrapper prefixes it once), so
				// only the roster key needs the explicit prefix. Null tenant -> unchanged.
				const dataTopic = _tenantTopic(ctx.tenantId, _callTopicFn(topicFn, ctx, args.slice(0, _cursorArgCount)));
				await _clusterPresenceMerge(ctx.platform, dataTopic, _getIdentityKey(ctx), sticky);
			}
		}
	});

	// Reactions are ephemeral events, not roster fields: a reaction is a one-off
	// emote (an emoji at a point), never a sticky value on a presence entry. It
	// rides a dedicated `:reactions` sub-topic as a bare `reaction` event so it
	// is consumed as a bounded, GC-after-render list rather than merged into the
	// roster. ctx.publish never coalesces, so a burst of taps all arrive.
	/**
	 * @param {any} ctx
	 * @param {any[]} args
	 */
	const _publishReaction = (ctx, args) => {
		const roomArgs = args.slice(0, _cursorArgCount);
		const payload = args.slice(_cursorArgCount);
		const reactionTopic = _callTopicFn(topicFn, ctx, roomArgs) + ':reactions';
		const key = _getIdentityKey(ctx);
		const frame = { key, token: payload[0] };
		const at = payload[1];
		if (at && typeof at === 'object' && !Array.isArray(at)) {
			Object.assign(frame, at);
		}
		ctx.publish(reactionTopic, 'reaction', frame);
	};

	/** @type {any} */ (roomExport).__reactionEmit = live.volatile(async (ctx, ...args) => {
		if (_cursorGuard) await _cursorGuard(ctx, ...args.slice(0, _cursorArgCount));
		_publishReaction(ctx, args);
	});

	// Reactions sub-stream: a bounded append-only ring (merge 'latest') on the
	// `:reactions` sub-topic. New subscribers start empty (a reaction is a live
	// event, never replayed from a roster), and the client GCs rendered taps so
	// a burst never grows unbounded.
	if (config.reactions) {
		/** @type {any} */ (roomExport).__reactionStream = live.stream(
			(ctx, ...args) => topicFn(ctx, ...args) + ':reactions',
			async (ctx, ...args) => {
				if (_cursorGuard) await _cursorGuard(ctx, ...args);
				return [];
			},
			{ merge: 'latest' }
		);
	}

	// Record the declared field surfaces so the generated namespace knows which
	// methods and reactive views to wire. typing / selections / locks publish
	// onto the room's `:presence` topic; reactions ride the `:reactions` topic.
	/** @type {any} */ (roomExport).__fields = {
		typing: !!config.typing,
		locks: Array.isArray(config.locks) ? config.locks.slice() : (config.locks ? [] : null),
		reactions: !!config.reactions,
		selections: config.selections === 'crdt' ? 'crdt' : (config.selections ? 'offset' : null)
	};

	return roomExport;
};
