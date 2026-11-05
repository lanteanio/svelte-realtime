// @ts-check
import { copyErrorMetadata } from '../shared/error-metadata.js';
import { RPC_ERROR_BRAND } from '../shared/error-brand.js';

const _OVERLOAD_REASONS = new Set(['concurrency_limit', 'queue_full']);
const _OVERLOAD_SCOPES = new Set(['connection', 'route', 'global']);

/**
 * Typed error for RPC failures.
 */
export class RpcError extends Error {
	/**
	 * @param {string} code
	 * @param {string} [message]
	 * @param {import('../shared/error-metadata.js').ErrorMetadata} [metadata]
	 */
	constructor(code, message, metadata) {
		super(message || code);
		this.code = code;
		if (metadata !== undefined) {
			Object.assign(this, copyErrorMetadata(metadata));
			// Which admission limit refused an OVERLOADED call, as the server named it.
			if (code === 'OVERLOADED' && metadata !== null && typeof metadata === 'object') {
				const { reason, scope } = /** @type {any} */ (metadata);
				if (_OVERLOAD_REASONS.has(reason) && _OVERLOAD_SCOPES.has(scope)) {
					/** @type {any} */ (this).reason = reason;
					/** @type {any} */ (this).scope = scope;
				}
			}
		}
	}

	/** @returns {true} */
	get [RPC_ERROR_BRAND]() {
		return true;
	}
}
