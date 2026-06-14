// @ts-check
import { LiveError } from './live-error.js';

// Seam: _copyStreamMeta (copies stream registration metadata onto a wrapper)
// stays in server.js, where several live.* families share it; breaker reaches
// it through this, set at init (mirrors installSmooth).
let _copyStreamMeta;
export function installBreaker(seams) {
	_copyStreamMeta = seams.copyStreamMeta;
}

/**
 * Wrap a stream initFn call with a circuit breaker.
 * When the breaker is open, returns the fallback value or throws SERVICE_UNAVAILABLE.
 *
 * @param {{ breaker: any, fallback?: any }} options
 * @param {Function} fn - The stream initFn
 * @returns {Function}
 */
export const _breakerRegister = function breaker(options, fn) {
	const { breaker: cb, fallback } = options;
	const wrapper = async function breakerWrapper(ctx, ...args) {
		if (cb.isOpen && cb.isOpen()) {
			if (fallback !== undefined) return typeof fallback === 'function' ? fallback() : fallback;
			throw new LiveError('SERVICE_UNAVAILABLE', 'Service temporarily unavailable (circuit open)');
		}
		try {
			const result = await fn(ctx, ...args);
			if (cb.success) cb.success();
			return result;
		} catch (err) {
			if (cb.failure) cb.failure();
			throw err;
		}
	};
	_copyStreamMeta(wrapper, fn);
	return wrapper;
};
