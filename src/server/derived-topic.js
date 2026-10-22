// @ts-check
import { createHash } from 'node:crypto';
import { LiveError } from './live-error.js';
import { _getAuthenticatedId, _getIdentityKey } from './identity.js';

/** @param {any} ctx @param {any[]} args @param {Function | undefined} scopeKey */
export function _derivedScope(ctx, args, scopeKey) {
	if (scopeKey) {
		const key = scopeKey(ctx, ...args);
		if (typeof key !== 'string' && !(typeof key === 'number' && Number.isFinite(key))) {
			if (key && typeof key.then === 'function') Promise.resolve(key).catch(() => {});
			throw new LiveError('INVALID_REQUEST', 'live.derived() scopeKey must return a string or finite number synchronously');
		}
		return ['custom', key];
	}
	const authenticated = _getAuthenticatedId(ctx);
	return authenticated === null ? ['guest', _getIdentityKey(ctx)] : ['user', authenticated];
}

// Longest module path kept verbatim in a derived output topic. With the
// '~' + 64-hex suffix and the longest tenant prefix ('@t/' + 64 + '/') the
// wire topic stays within the adapter's 256-character topic cap.
const _MAX_DERIVED_BASE = 120;

/**
 * The output topic of one dynamic derived instance: the module path and a
 * SHA-256 digest of the scope and arguments, so any JSON arguments (quotes,
 * backslashes, tildes, any length) yield a bounded, printable-ASCII wire
 * topic. A path longer than `_MAX_DERIVED_BASE` is cut and hashed into the
 * digest as well, so two long paths sharing a prefix still differ.
 * @param {string} base @param {any} scope @param {any[]} args
 */
export function _derivedTopic(base, scope, args) {
	if (base.length <= _MAX_DERIVED_BASE) {
		return base + '~' + createHash('sha256').update(JSON.stringify([scope, args])).digest('hex');
	}
	return base.slice(0, _MAX_DERIVED_BASE) + '~' + createHash('sha256').update(JSON.stringify([scope, args, base])).digest('hex');
}

/** Compare an existing scope without allocating a tuple on the default hot path. */
export function _matchesDerivedScope(ctx, args, scopeKey, scope) {
	if (scopeKey) {
		const current = _derivedScope(ctx, args, scopeKey);
		return current[0] === scope[0] && current[1] === scope[1];
	}
	const authenticated = _getAuthenticatedId(ctx);
	return authenticated === null
		? scope[0] === 'guest' && _getIdentityKey(ctx) === scope[1]
		: scope[0] === 'user' && authenticated === scope[1];
}
