// @ts-check
import { _lazyQueue } from './state.js';
import { _validSegmentRe } from './validate.js';

// Seam: the register fns _resolveAllLazy dispatches to live in server.js (and
// cron-engine for registerCron); injected at init.
let __registerCron, __register, __registerDerived, __registerEffect, __registerWebhookOut, __registerAggregate;
export function installLazy(seams) {
	__registerCron = seams.registerCron;
	__register = seams.register;
	__registerDerived = seams.registerDerived;
	__registerEffect = seams.registerEffect;
	__registerWebhookOut = seams.registerWebhookOut;
	__registerAggregate = seams.registerAggregate;
}

/** @type {Promise<void> | null} */
let _lazyInitPromise = null;

/** @type {boolean} Set to true once all lazy entries have been resolved */
let _lazyResolved = false;

/**
 * Resolve all deferred (lazy) cron/derived/effect/aggregate/room-action registrations.
 * Safe to call multiple times - only the first call does work, concurrent callers
 * await the same promise.
 */
export async function _resolveAllLazy() {
	if (_lazyResolved) return;
	if (_lazyInitPromise) return _lazyInitPromise;
	if (_lazyQueue.length === 0) { _lazyResolved = true; return; }
	_lazyInitPromise = (async () => {
		const queue = _lazyQueue.splice(0);
		for (const { type, path, loader } of queue) {
			try {
				const fn = await loader();
				if (!fn) continue;
				switch (type) {
					case 'cron':
						__registerCron(path, fn);
						break;
					case 'derived':
						__register(path, fn);
						__registerDerived(path, fn);
						break;
					case 'effect':
						__registerEffect(path, fn);
						break;
					case 'webhookOut':
						__registerWebhookOut(path, fn);
						break;
					case 'aggregate':
						__register(path, fn);
						__registerAggregate(path, fn);
						break;
					case 'room-actions': {
						const modulePath = path.substring(0, path.lastIndexOf('/'));
						if (/** @type {any} */ (fn).__actions) {
							for (const [k, v] of Object.entries(/** @type {any} */ (fn).__actions)) {
								if (_validSegmentRe.test(k)) {
									__register(path + '/__action/' + k, v, modulePath);
								}
							}
						}
						break;
					}
				}
			} catch (err) {
				console.error(`[svelte-realtime] Failed to resolve lazy registration for '${path}':`, err);
			}
		}
		_lazyResolved = true;
	})();
	return _lazyInitPromise;
}

/** Live read of the lazy-resolved flag - the staying RPC / cron paths gate on it. */
export function _isLazyResolved() { return _lazyResolved; }

/** Reset lazy init state for HMR teardown (staying _prepareHmr cannot assign imported bindings). */
export function _resetLazy() {
	_lazyResolved = false;
	_lazyInitPromise = null;
}
