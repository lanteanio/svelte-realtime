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
