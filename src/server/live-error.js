// @ts-check
import { copyErrorMetadata } from '../shared/error-metadata.js';
import { LIVE_ERROR_BRAND } from '../shared/error-brand.js';

/**
 * Typed error that propagates code to the client.
 */
export class LiveError extends Error {
	/**
	 * @param {string} code
	 * @param {string} [message]
	 * @param {import('../shared/error-metadata.js').ErrorMetadata} [metadata]
	 */
	constructor(code, message, metadata) {
		super(message || code);
		this.code = code;
		if (metadata !== undefined) Object.assign(this, copyErrorMetadata(metadata));
	}

	/** @returns {true} */
	get [LIVE_ERROR_BRAND]() {
		return true;
	}
}
