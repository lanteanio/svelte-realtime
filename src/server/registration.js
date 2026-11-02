// @ts-check
import { state } from './state.js';
import { LiveError } from './live-error.js';

/**
 * Refuse a handler whose registration or guard changed while its call waited.
 * @param {number} revision
 */
export function _assertRegistrationRevision(revision) {
	if (state.registrationRevision !== revision) {
		throw new LiveError('UNAVAILABLE', 'Live handlers changed; retry the request');
	}
}
