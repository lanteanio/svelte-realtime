// @ts-check
import { LiveError } from './live-error.js';
import { emitOperationalEvent } from '../shared/diagnostic.js';
import { wallEpoch } from '../shared/runtime.js';

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
 * @param {{ breaker: any, name?: string, fallback?: any }} options
 * @param {Function} fn - The stream initFn
 * @returns {Function}
 */
export const _breakerRegister = function breaker(options, fn) {
	const { breaker: cb, fallback } = options;
	const name = typeof options.name === 'string' ? options.name.trim().slice(0, 120) || 'unnamed' : 'unnamed';
	const usesGuard = typeof cb.guard === 'function';
	let openReported = false;
	const refused = () => {
		if (!openReported) {
			openReported = true;
			try {
				emitOperationalEvent({
					source: 'svelte-realtime', component: 'server.breaker', event: 'breaker.open',
					severity: 'warn', dataClass: 'operational',
					message: 'A circuit breaker refused an operation.',
					attributes: { name, state: 'open', openObservedAt: wallEpoch() }
				});
			} catch { /* Observability must not prevent the availability response. */ }
		}
		if (fallback !== undefined) return typeof fallback === 'function' ? fallback() : fallback;
		throw new LiveError('SERVICE_UNAVAILABLE', 'Service is temporarily unavailable, try again shortly');
	};
	// Select the stable breaker API once, outside the operation hot path.
	const wrapper = usesGuard ? async function breakerWrapper(ctx, ...args) {
		try { cb.guard(); }
		catch (err) {
			if (err?.name !== 'CircuitBrokenError') throw err;
			return refused();
		}
		openReported = false;
		try {
			const result = await (args.length === 0 ? fn(ctx) : fn(ctx, ...args));
			if (cb.success) cb.success();
			return result;
		} catch (err) {
			if (cb.failure) cb.failure(err);
			throw err;
		}
	} : async function legacyBreakerWrapper(ctx, ...args) {
		if (cb.isOpen && cb.isOpen()) return refused();
		openReported = false;
		try {
			const result = await (args.length === 0 ? fn(ctx) : fn(ctx, ...args));
			if (cb.success) cb.success();
			return result;
		} catch (err) {
			if (cb.failure) cb.failure(err);
			throw err;
		}
	};
	_copyStreamMeta(wrapper, fn);
	return wrapper;
};
