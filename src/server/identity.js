// @ts-check

// Stable per-connection identity key (shared by rate-limit, presence, smooth,
// multiplayer, and RPC dispatch). No platform or state dependencies; the only
// import is the static dev flag, used for a one-shot diagnostic.

import { _IS_DEV } from './env.js';

/** @type {WeakMap<object, string>} Stable guest ID per connection for anonymous users */
const _guestIds = new WeakMap();
let _guestIdCounter = 0;

let _unusableIdWarnFired = false;

/**
 * One-shot dev warning for a session id that is PRESENT but unusable. Silent in
 * production and after the first fire, so the steady-state cost on this
 * per-message path is one boolean test.
 *
 * Only the unambiguous shape bugs reach here - never the empty-string sentinel
 * (`{ id: session?.userId ?? '' }`), which is a documented "no session" value,
 * and never an absent id. What makes these worth a console line is that the
 * failure is SILENT: the connection is demoted to a per-connection guest id,
 * which widens `live.rateLimit` quotas to per-socket and drops the per-user
 * scoping on idempotency keys - so two callers sharing a client-chosen key can
 * collide in one slot and the second receives the first's cached result.
 * @param {string} reason
 */
function _warnUnusableId(reason) {
	if (!_IS_DEV || _unusableIdWarnFired) return;
	_unusableIdWarnFired = true;
	console.warn(
		`[svelte-realtime] session id is present but unusable (${reason}) - this connection is being treated as ANONYMOUS.\n` +
		'  Rate limits fall back to a per-socket bucket and idempotency keys lose their per-user scope.\n' +
		'  Check what you put in ctx.user.id / user_id / userId.'
	);
}

/** Test hook: re-arm the one-shot warning above. */
export function _resetUnusableIdWarning() {
	_unusableIdWarnFired = false;
}

/**
 * Get the connection's AUTHENTICATED identity, or `null` when there is none.
 * Reads ctx.user.id (or the Postgres-convention `user_id` / camelCase `userId`
 * aliases) and stops there - it never falls back to a per-connection guest id.
 * Use this when "anonymous" must be distinguishable from "authenticated" (e.g.
 * a security boundary that should only apply to known users); use
 * `_getIdentityKey` when every connection needs SOME stable key. Single source
 * for the id-field probe order, shared by both.
 * @param {any} ctx
 * @returns {string | null}
 */
export function _getAuthenticatedId(ctx) {
	// Guarded as a WHOLE, not just around the one constructor that was observed to
	// throw. `ctx.user` is the app's session object, handed over verbatim from
	// `ws.getUserData()`, so reading `ctx.user` itself and each alias below may hit
	// a throwing getter or a Proxy trap. Nothing may escape here: this is called
	// from `_unknownPathReply` (dispatch.js:258), which sits OUTSIDE the dispatch
	// try/catch on a path `_executeRpc` fires with no `.catch`, so an escaping
	// throw is an unhandled rejection - process termination under Node's default,
	// a crash loop rather than one failed request.
	try {
		const u = ctx.user;
		if (!u) return null;
		// Each alias is probed INDEPENDENTLY rather than `u.id ?? u.user_id ?? ...`:
		// `''` is not nullish, so an empty `id` would swallow the probe and mask a
		// perfectly good `user_id` - locking a real user out instead of the anonymous
		// one this gate is for.
		return _scalarId(u.id) ?? _scalarId(u.user_id) ?? _scalarId(u.userId);
	} catch {
		return null;
	}
}

/**
 * The scalar-id rule, shared by every alias probe. Only a scalar is an identity:
 * a present-but-empty id is the common "no session" sentinel
 * (`{ id: session?.userId ?? '' }`) and a boolean or object is a shape bug -
 * neither may read as authenticated, or an anonymous connection walks through
 * every authenticated-only gate. `0` IS a legitimate id, so falsiness alone
 * decides nothing.
 * @param {any} id
 * @returns {string | null}
 */
function _scalarId(id) {
	if (typeof id === 'number') return Number.isFinite(id) ? String(id) : null;
	if (typeof id === 'bigint') return String(id);
	if (typeof id === 'string') return id.length > 0 ? id : null;
	// Object ids are the norm outside plain SQL - a Mongo ObjectId, a Buffer or
	// Uint8Array uuid, a Prisma Decimal - and they stringify to a real identity.
	// Rejecting them would not merely fail the auth guard: it would silently
	// DEMOTE a logged-in user to a per-connection guest id, which widens
	// `live.rateLimit` quotas to per-socket and drops the per-user scoping on
	// idempotency keys. Accept only a MEANINGFUL stringification - the default
	// `Object.prototype.toString` result means there is no id in there.
	if (id !== null && typeof id === 'object' && !Array.isArray(id)) {
		// Binary ids (a Buffer / Uint8Array uuid) must be read as BYTES. `String(buf)`
		// is a UTF-8 DECODE, so two distinct binary ids both containing invalid
		// sequences collapse to the same run of replacement characters - and a 0x00
		// byte would inject a raw NUL into an identity that is later joined with NUL
		// delimiters.
		if (ArrayBuffer.isView(id)) {
			const b = /** @type {any} */ (id);
			// A DETACHED buffer (the id was transferred to a worker) throws on
			// construction. Every other unusable shape here returns null, and this one
			// must too - and the throw did NOT merely fail one call. `_unknownPathReply`
			// reads the identity at dispatch.js:258, which sits OUTSIDE the dispatch
			// try/catch on a path `_executeRpc` fires with no `.catch`, so the throw
			// surfaced as an unhandled promise rejection: process termination under
			// Node's default, i.e. a crash loop rather than a failed request.
			let bytes;
			try { bytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength); } catch { _warnUnusableId('binary id is detached - it was transferred to a worker'); return null; }
			if (bytes.length === 0) return null;
			// Bounded, because this runs per MESSAGE - rate limiting, smooth and
			// multiplayer all key off it - and the result becomes a Map key and is
			// concatenated into topic strings. An uncapped id would rebuild a
			// megabyte-scale string on every frame. 64 bytes clears every real id
			// shape (a uuid is 16, an ObjectId 12, a SHA-512 digest 64).
			if (bytes.length > 64) { _warnUnusableId(`binary id is ${bytes.length} bytes, over the 64-byte cap`); return null; }
			let hex = '';
			for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
			return hex;
		}
		let s;
		try { s = String(id); } catch { _warnUnusableId('toString() on the id threw'); return null; }
		// Reject the DEFAULT stringification of any builtin. `[object Promise]`,
		// `[object Map]` and friends are identical for every instance, so accepting
		// one would collapse every connection onto a single identity - a forgotten
		// `await` on `{ id: db.getUserId() }` is the canonical way to produce it, and
		// it would hand every user the same rate-limit bucket, idempotency slot and
		// room ownership. Only a genuine custom toString (Mongo ObjectId, Prisma
		// Decimal) survives.
		if (s.length === 0 || /^\[object .*\]$/.test(s)) { _warnUnusableId(`id stringifies to ${s.length === 0 ? 'an empty string' : s} - a forgotten await is the usual cause`); return null; }
		return s;
	}
	return null;
}

/**
 * Does this value identify somebody? One shared answer for every authorization
 * surface, so the access predicates cannot drift from the authenticated-identity
 * gate the way a bare `!= null` check did: `''` (the `{ id: session?.userId ?? '' }`
 * no-session sentinel) and a boolean or plain object are all `!= null` and so read
 * as present, while identifying nobody. Validates only - the caller keeps its own
 * raw value, so a strict `===` comparison against a numeric id is unaffected.
 * @param {any} id
 * @returns {boolean}
 */
export function _isIdentityValue(id) {
	return _scalarId(id) !== null;
}

/**
 * Get a stable identity key for a connection. Uses the authenticated id when
 * present (see `_getAuthenticatedId`), otherwise assigns a unique guest ID that
 * persists for the connection lifetime. The id-key probe order mirrors
 * `_defaultPushIdentify` so apps that expose `user_id` in their session shape
 * rate-limit per-user instead of falling back to the per-connection bucket.
 * @param {any} ctx
 * @returns {string}
 */
export function _getIdentityKey(ctx) {
	const authed = _getAuthenticatedId(ctx);
	if (authed !== null) return authed;
	if (!ctx.ws) return 'anon';
	let guestId = _guestIds.get(ctx.ws);
	if (!guestId) {
		guestId = '__guest_' + (++_guestIdCounter).toString(36);
		_guestIds.set(ctx.ws, guestId);
	}
	return guestId;
}
