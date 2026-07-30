// @ts-check
import { live } from '../server.js';
import { _getIdentityKey } from './identity.js';
import { _clusterPresenceMerge } from './presence.js';
import { _tenantTopic } from './tenant.js';
import { _IS_DEV } from './env.js';

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
		'  The field will not persist on the roster entry. This warning fires once per reason per process.\n' +
		'  See: https://svti.me/multiplayer'
	);
}

/** Test seam: forget which sticky-drop warnings have fired. */
export function _resetStickyDropWarnings() {
	_stickyDropWarned.clear();
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
		onOwnerChange: config.onOwnerChange,
		alarm: config.alarm
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
		// selections are enabled) and declared lock:<k> keys (when locks are
		// enabled) are sticky; typing and everything else stay ephemeral.
		// Reactions ride a separate path.
		const delta = args[_cursorArgCount];
		if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
			const sticky = {};
			let stickyCount = 0;
			for (const k of Object.keys(delta)) {
				if (stickyCount >= _STICKY_MAX_KEYS) {
					_warnStickyDrop('more than ' + _STICKY_MAX_KEYS + ' sticky keys in one delta', 'key ' + k);
					break;
				}
				if (k === 'selection') {
					if (!config.selections) continue;
					if (!_stickyValueFits(delta[k])) {
						_warnStickyDrop('value exceeds ' + _STICKY_VALUE_MAX_BYTES + ' bytes serialized', 'selection');
						continue;
					}
					sticky[k] = delta[k];
					stickyCount++;
				} else if (k.slice(0, 5) === 'lock:') {
					// Locks persist only when declared: an array declaration is
					// the allowlist of lockable keys (`locks: ['title']` allows
					// `lock:title` and nothing else), so undeclared keys can
					// never accumulate on the roster entry.
					if (!config.locks) continue;
					if (Array.isArray(config.locks) && !config.locks.includes(k.slice(5))) {
						_warnStickyDrop('lock key is not in the declared locks allowlist', k);
						continue;
					}
					if (!_stickyValueFits(delta[k])) {
						_warnStickyDrop('value exceeds ' + _STICKY_VALUE_MAX_BYTES + ' bytes serialized', k);
						continue;
					}
					sticky[k] = delta[k];
					stickyCount++;
				}
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
