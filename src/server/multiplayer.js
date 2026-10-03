// @ts-check
import { live } from '../server.js';
import { _getIdentityKey } from './identity.js';
import { _clusterPresenceMerge } from './presence.js';
import { _tenantTopic } from './tenant.js';
import { _IS_DEV } from './env.js';
import { randomU32 } from '../shared/runtime.js';
import { safeAssign } from '../shared/safe-assign.js';
import { _MULTIPLAYER_NAMESPACE_MEMBERS as _NAMESPACE_MEMBERS } from '../shared/multiplayer-members.js';

// Seam: the shared topic-fn resolver (_callTopicFn) stays in server.js (used by
// several live.* families); multiplayer registration reaches it through this,
// set at init (mirrors installSmooth).
let _callTopicFn;
export function installMultiplayer(seams) {
	_callTopicFn = seams.callTopicFn;
}

// Sticky presence-field bounds: a roster entry is rewritten in full
// per merge and served verbatim to every late joiner, so a client must not
// grow it without limit. A sticky value is a boolean lock flag or a small
// selection range, so anything larger than this is dropped, and a single
// delta stamps at most this many sticky fields. The roster merge
// (_clusterPresenceMerge) additionally caps the accumulated entry size.
const _STICKY_MAX_KEYS = 64;
const _STICKY_VALUE_MAX_BYTES = 1024;

/**
 * A sticky value persists only when its serialized form fits the bound; null
 * (the release path) always fits. Unserializable values are dropped.
 * @param {any} v
 */
function _stickyValueFits(v) {
	if (v == null) return true;
	// Bytes, not UTF-16 code units - same unit the roster entry cap uses.
	try { return Buffer.byteLength(JSON.stringify(v), 'utf8') <= _STICKY_VALUE_MAX_BYTES; } catch { return false; }
}

/**
 * One-time dev warning per reason. Sticky drops are individually silent by
 * design (a hostile client must not get a per-frame error channel), but an app
 * that misconfigures `locks` or overshoots the value bound would otherwise see
 * its locks simply never persist, with nothing to point at.
 * @type {Set<string>}
 */
const _stickyDropWarned = new Set();

/**
 * `detail` carries a client-supplied key, so it is stripped of control bytes and
 * truncated before it reaches the log. A raw key could otherwise inject newlines
 * to forge log lines, or emit a megabyte per warning.
 * @param {string} s
 */
function _logSafe(s) {
	let out = '';
	for (let i = 0; i < s.length && out.length < 64; i++) {
		const c = s.charCodeAt(i);
		out += c < 0x20 || c === 0x7f ? '.' : s[i];
	}
	return out.length < s.length ? out + '...' : out;
}

function _warnStickyDrop(reason, detail) {
	// Dedup is keyed on `reason`, which is always a program constant, so the set
	// stays bounded no matter what a client sends.
	if (!_IS_DEV || _stickyDropWarned.has(reason)) return;
	_stickyDropWarned.add(reason);
	console.warn(
		'[svelte-realtime] live.multiplayer(): dropping a sticky presence field - ' + reason + ' (' + _logSafe(String(detail)) + ').\n' +
		'  The field is neither persisted on the roster entry nor broadcast. This warning fires once per reason per process.\n' +
		'  See: https://svti.me/multiplayer'
	);
}

/** Test seam: forget which sticky-drop and non-member warnings have fired. */
export function _resetStickyDropWarnings() {
	_stickyDropWarned.clear();
	_notMemberWarned = false;
}

let _notMemberWarned = false;

function _warnNotMember() {
	if (!_IS_DEV || _notMemberWarned) return;
	_notMemberWarned = true;
	console.warn(
		'[svelte-realtime] live.multiplayer(): dropping a cursor sample, presence field or reaction from a connection that is not a member of the room.\n' +
		'  A connection joins by holding the room data stream: board.room(...) does, board.watch(...) does not, and a member is gone once the presence grace window after its last view has passed. This warning fires once per process.\n' +
		'  See: https://svti.me/multiplayer'
	);
}

// Cursor samples and presence-field deltas cross a relay with no ordering
// promise of their own (a pipelined bus, a multi-worker fan-out, a cluster of
// Redis nodes), and both merges are last-write-wins, so each frame carries an
// ordering token: `_p` names the publishing connection and `_n` counts that
// connection's publishes. A receiver orders two frames only when they share a
// publisher. Not a clock on purpose: replicas' wall clocks disagree, and a peer
// that reconnects to a replica running behind would have every new frame read
// as older than the ones it sent before, so a lock it releases would stay held
// on every other client.
/** @type {WeakMap<object, { p: string, n: number }>} */
const _publishers = new WeakMap();
let _publisherCounter = 0;
/** @type {string | null} Per-process salt for publisher ids, drawn on first use */
let _publisherSalt = null;

/**
 * Stamp the calling connection's ordering token onto an outgoing frame. The
 * sequence is taken here, at publish, after every await in the send path, so
 * it is the order this process publishes in - and the order a presence delta's
 * sticky fields reach the roster right after it. A live client and a late
 * joiner loading the roster therefore settle on the same value however the
 * guards of two concurrent calls happened to settle. The names are reserved: a
 * payload field called `_p` or `_n` is overwritten, or removed when the call
 * has no connection to order by, so a client can never supply its own.
 * @param {Record<string, any>} frame
 * @param {any} ctx
 */
function _stampOrder(frame, ctx) {
	const ws = ctx.ws;
	if (!ws) {
		delete frame._p;
		delete frame._n;
		return;
	}
	let pub = _publishers.get(ws);
	if (!pub) {
		// Salted per process: the counter alone restarts on every replica, and
		// a peer that moved from one replica to another could land on the same
		// id there and have its new frames ordered against its old ones.
		// Drawn from the runtime seam like the guest-id salt; 32 bits are
		// enough here, since a collision also needs the same counter value and
		// the same identity to matter, and every frame carries the id.
		if (_publisherSalt === null) _publisherSalt = randomU32().toString(36);
		pub = { p: _publisherSalt + '.' + (++_publisherCounter).toString(36), n: 0 };
		_publishers.set(ws, pub);
	}
	frame._p = pub.p;
	frame._n = ++pub.n;
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

	// The generated client namespace puts the actions beside its own members,
	// so an action named like one of them shadows it or is shadowed by it -
	// silently, and only on the client (an action called `data` would even
	// replace the stream room() joins through). Refuse it where it is written.
	if (config.actions && typeof config.actions === 'object') {
		for (const action of Object.keys(config.actions)) {
			if (_NAMESPACE_MEMBERS.has(action)) {
				throw new Error(
					`[svelte-realtime] live.multiplayer() action '${action}' has the name of a member the generated client namespace already provides. Rename the action.\n  See: https://svti.me/multiplayer`
				);
			}
		}
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
		onOwnerChange: config.onOwnerChange,
		alarm: config.alarm
	});

	/** @type {any} */ (roomExport).__isMultiplayer = true;

	// The fields a presence delta persists on the roster: `selection` when
	// selections are enabled, a `lock:<k>` key when locks are enabled (an array
	// declaration is the allowlist of lockable keys, so undeclared keys can never
	// accumulate on the roster entry). They are stored inside the member's
	// payload, and the room's presence snapshot lifts exactly these back out
	// beside it, so what persists and what is served cannot disagree. A room
	// with neither keeps its payloads untouched.
	/** @param {string} k */
	const _isStickyKey = (k) => {
		if (k === 'selection') return !!config.selections;
		if (k.slice(0, 5) !== 'lock:' || !config.locks) return false;
		return !Array.isArray(config.locks) || config.locks.includes(k.slice(5));
	};
	if (config.selections || config.locks) /** @type {any} */ (roomExport).__isStickyKey = _isStickyKey;

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
	 * @param {string} topic the room's topic
	 * @param {string} key the caller's identity key
	 * @param {any[]} args
	 * @param {Record<string, any>} extra
	 */
	const _publishCursor = (ctx, topic, key, args, extra) => {
		const payload = args.slice(_cursorArgCount);
		const cursorTopic = topic + ':cursors';
		const frame = { key, ...extra };
		const cur = payload[0];
		if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
			safeAssign(frame, cur);
		} else if (payload.length > 0) {
			frame.value = payload.length === 1 ? cur : payload;
		}
		// The payload is the caller's own sample, never its identity: a `key` in
		// it would put the frame on another user's entry for every receiver.
		frame.key = key;
		// Without the token an out-of-order sample lands as the newest and the
		// peer's cursor sits on a mid-gesture point until the next move.
		_stampOrder(frame, ctx);
		ctx.publish(cursorTopic, 'update', frame);
	};

	// A cursor sample, a field update or a reaction is published under the
	// caller's roster key, so in a room that tracks membership (a presence
	// function or an owner) only a member may send one. Anyone else's frame -
	// from a connection that never joined, a watch() view, a view sending
	// after its user left - would put a key on every client that no leave ever
	// removes. Dropped silently, like a refused sticky field. Sync unless the
	// caller's own join is still being published.
	const _isMember = /** @type {any} */ (roomExport).__isMember || null;
	/**
	 * @param {any} ctx
	 * @param {string} topic the room's topic
	 * @param {string} key the caller's identity key
	 * @returns {boolean | Promise<boolean>}
	 */
	const _mayPublish = (ctx, topic, key) => {
		if (_isMember === null) return true;
		const member = _isMember(ctx.tenantId ?? null, topic, key, ctx.ws);
		if (member === true) return true;
		if (member === false) { _warnNotMember(); return false; }
		return member.then((ok) => { if (!ok) _warnNotMember(); return ok; });
	};

	const _cursorGuard = config.guard;
	/** @type {any} */ (roomExport).__cursorMove = live.volatile(async (ctx, ...args) => {
		if (_cursorGuard) await _cursorGuard(ctx, ...args.slice(0, _cursorArgCount));
		const topic = _callTopicFn(topicFn, ctx, args.slice(0, _cursorArgCount));
		const key = _getIdentityKey(ctx);
		const ok = _mayPublish(ctx, topic, key);
		if (ok !== true && !(await ok)) return;
		_publishCursor(ctx, topic, key, args, {});
	});
	/** @type {any} */ (roomExport).__cursorReportViewport = live.volatile(async (ctx, ...args) => {
		if (_cursorGuard) await _cursorGuard(ctx, ...args.slice(0, _cursorArgCount));
		const topic = _callTopicFn(topicFn, ctx, args.slice(0, _cursorArgCount));
		const key = _getIdentityKey(ctx);
		const ok = _mayPublish(ctx, topic, key);
		if (ok !== true && !(await ok)) return;
		_publishCursor(ctx, topic, key, args, { viewport: true });
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
	 * @param {string} topic the room's topic
	 * @param {string} key the caller's identity key
	 * @param {any[]} args
	 * @param {Set<string> | null} withheld selection / lock fields the roster
	 *   refused; they are not sent either (see `__presenceUpdate`)
	 */
	const _publishPresenceField = (ctx, topic, key, args, withheld) => {
		const delta = args[_cursorArgCount];
		const presenceTopic = topic + ':presence';
		const frame = { key };
		if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
			safeAssign(frame, delta);
		}
		// A delta names fields on the caller's own entry, never the entry itself:
		// `key` would move it onto another user's entry, and `data` would replace
		// the presence payload the server computed for it (the name members
		// render) on every live client while the roster kept the real one.
		frame.key = key;
		delete frame.data;
		if (withheld !== null) {
			for (const k of withheld) delete frame[k];
			let fields = 0;
			for (const k in frame) if (k !== 'key' && k !== '_p' && k !== '_n') fields++;
			if (fields === 0) return;
		}
		// Ordered per field on the receiving side: the same reorder hazard as
		// cursor frames, with a stale flag (typing, a lock) as the visible
		// damage.
		_stampOrder(frame, ctx);
		ctx.publish(presenceTopic, 'update', frame);
	};

	/** @type {any} */ (roomExport).__presenceUpdate = live.volatile(async (ctx, ...args) => {
		if (_cursorGuard) await _cursorGuard(ctx, ...args.slice(0, _cursorArgCount));
		const topic = _callTopicFn(topicFn, ctx, args.slice(0, _cursorArgCount));
		const key = _getIdentityKey(ctx);
		const ok = _mayPublish(ctx, topic, key);
		if (ok !== true && !(await ok)) return;
		// Decide once per field what the roster keeps. selection (when selections
		// are enabled) and declared lock:<k> keys (when locks are enabled) are
		// sticky; typing and everything else stay ephemeral and always go out. A
		// selection or lock the roster refuses - undeclared, over the value bound,
		// past the per-delta key limit - is not sent either, or live members would
		// show a lock or range no late joiner ever sees. A release (null) always
		// goes out, since it can only clear a field (an undeclared one may be left
		// behind on live clients by a narrower declaration), and a declared one is
		// always merged. Reactions ride a separate path.
		const delta = args[_cursorArgCount];
		/** @type {Record<string, any>} */
		const sticky = {};
		let persist = false;
		let stickyCount = 0;
		/** @type {Set<string> | null} */
		let withheld = null;
		if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
			for (const k of Object.keys(delta)) {
				if (k !== 'selection' && k.slice(0, 5) !== 'lock:') continue;
				const release = delta[k] === null;
				if (!_isStickyKey(k)) {
					if (release) continue;
					// `locks: ['title']` allows `lock:title` and nothing else.
					if (Array.isArray(config.locks) && k.slice(0, 5) === 'lock:') {
						_warnStickyDrop('lock key is not in the declared locks allowlist', k);
					}
					(withheld ??= new Set()).add(k);
					continue;
				}
				// A release stamps nothing, so the per-delta limit (which bounds
				// what a delta adds to the entry) never holds one back.
				if (release) {
					sticky[k] = null;
					persist = true;
					continue;
				}
				if (stickyCount >= _STICKY_MAX_KEYS) {
					_warnStickyDrop('more than ' + _STICKY_MAX_KEYS + ' sticky keys in one delta', 'key ' + k);
					(withheld ??= new Set()).add(k);
					continue;
				}
				if (!_stickyValueFits(delta[k])) {
					_warnStickyDrop('value exceeds ' + _STICKY_VALUE_MAX_BYTES + ' bytes serialized', k);
					(withheld ??= new Set()).add(k);
					continue;
				}
				sticky[k] = delta[k];
				stickyCount++;
				persist = true;
			}
		}
		// Persist after the forward publish, so the live frame and the roster
		// write keep the order the ordering token gives them.
		_publishPresenceField(ctx, topic, key, args, withheld);
		if (persist) {
			// The roster store is keyed by the WIRE data topic (the data-stream's
			// onSubscribe acquired it tenant-prefixed); prefix here too so the sticky
			// field lands on the same entry. The forward `:presence` publish above
			// uses ctx.publish (logical -> the scoped wrapper prefixes it once), so
			// only the roster key needs the explicit prefix. Null tenant -> unchanged.
			const dataTopic = _tenantTopic(ctx.tenantId, topic);
			await _clusterPresenceMerge(ctx.platform, dataTopic, key, sticky);
		}
	});

	// Reactions are ephemeral events, not roster fields: a reaction is a one-off
	// emote (an emoji at a point), never a sticky value on a presence entry. It
	// rides a dedicated `:reactions` sub-topic as a bare `reaction` event so it
	// is consumed as a bounded, GC-after-render list rather than merged into the
	// roster. ctx.publish never coalesces, so a burst of taps all arrive.
	/**
	 * @param {any} ctx
	 * @param {string} topic the room's topic
	 * @param {string} key the caller's identity key
	 * @param {any[]} args
	 */
	const _publishReaction = (ctx, topic, key, args) => {
		const payload = args.slice(_cursorArgCount);
		const reactionTopic = topic + ':reactions';
		const frame = { key, token: payload[0] };
		const at = payload[1];
		if (at && typeof at === 'object' && !Array.isArray(at)) {
			safeAssign(frame, at);
		}
		// The point is the caller's, and so is the reaction (see the cursor path).
		frame.key = key;
		ctx.publish(reactionTopic, 'reaction', frame);
	};

	/** @type {any} */ (roomExport).__reactionEmit = live.volatile(async (ctx, ...args) => {
		if (_cursorGuard) await _cursorGuard(ctx, ...args.slice(0, _cursorArgCount));
		const topic = _callTopicFn(topicFn, ctx, args.slice(0, _cursorArgCount));
		const key = _getIdentityKey(ctx);
		const ok = _mayPublish(ctx, topic, key);
		if (ok !== true && !(await ok)) return;
		_publishReaction(ctx, topic, key, args);
	});

	// Reactions sub-stream: a bounded append-only ring (merge 'latest') on the
	// `:reactions` sub-topic. New subscribers start empty (a reaction is a live
	// event, never replayed from a roster), and the client GCs rendered taps so
	// a burst never grows unbounded.
	if (config.reactions) {
		const reactionStream = live.stream(
			(ctx, ...args) => topicFn(ctx, ...args) + ':reactions',
			async (ctx, ...args) => {
				if (/** @type {any} */ (ctx)._roomGuardRan !== true && _cursorGuard) await _cursorGuard(ctx, ...args);
				return [];
			},
			{ merge: 'latest' }
		);
		// The guard has to run before the wire subscribe, like every other
		// sub-stream: a loader-only guard leaves a denied joiner subscribed to
		// the reactions topic (and told its resolved name) for as long as the
		// guard awaits, and every reaction published in that window reaches it.
		const subFilter = /** @type {any} */ (roomExport).__subStreamFilter;
		if (subFilter) /** @type {any} */ (reactionStream).__streamFilter = subFilter;
		/** @type {any} */ (roomExport).__reactionStream = reactionStream;
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
