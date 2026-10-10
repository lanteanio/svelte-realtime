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

/** @param {string} base @param {any} scope @param {any[]} args */
export function _derivedTopic(base, scope, args) {
	return base + '~' + createHash('sha256').update(JSON.stringify([scope, args])).digest('hex');
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
