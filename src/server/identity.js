// @ts-check

// Stable per-connection identity key (shared by rate-limit, presence, smooth,
// multiplayer, and RPC dispatch). Pure: no platform/state dependencies.

/** @type {WeakMap<object, string>} Stable guest ID per connection for anonymous users */
const _guestIds = new WeakMap();
let _guestIdCounter = 0;

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
	const u = ctx.user;
	if (u) {
		const id = u.id ?? u.user_id ?? u.userId;
		if (id !== undefined && id !== null) return String(id);
	}
	return null;
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
