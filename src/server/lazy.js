// @ts-check
import { _lazyQueue } from './state.js';
import { _validSegmentRe } from './validate.js';
import { REALTIME_ERROR_IDS, realtimeErrorMessage } from '../error-registry.js';

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
let _lazyGeneration = 0;
/** @type {{ queue: any[], index: number, promise: Promise<any> | null } | null} */
let _activeQueue = null;

/**
 * Resolve all deferred (lazy) cron/derived/effect/aggregate/room-action registrations.
 * Safe to call multiple times - only the first call does work, concurrent callers
 * await the same promise.
 */
export async function _resolveAllLazy() {
	if (_lazyResolved) return;
	if (_lazyInitPromise) {
		const generation = _lazyGeneration;
		await _lazyInitPromise;
		if (generation !== _lazyGeneration) return _resolveAllLazy();
		return;
	}
	if (_lazyQueue.length === 0) { _lazyResolved = true; return; }
	const generation = _lazyGeneration;
	const loading = Promise.resolve().then(async () => {
		if (generation !== _lazyGeneration) return;
		const queue = _lazyQueue.splice(0);
		/** @type {{ queue: any[], index: number, promise: Promise<any> | null }} */
		const active = { queue, index: 0, promise: null };
		_activeQueue = active;
		for (; active.index < queue.length || _lazyQueue.length > 0; active.index++) {
			if (generation !== _lazyGeneration) return;
			if (active.index === queue.length) queue.push(..._lazyQueue.splice(0));
			const { type, path, loader } = queue[active.index];
			try {
				active.promise = Promise.resolve(loader());
				const fn = await active.promise;
				if (generation !== _lazyGeneration) return;
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
						// Bind the room's enumeration identity to its stable module
						// path so cluster replicas of one export agree on the
						// roster key and pub/sub topic. `path` is `rel/name`.
						if (typeof (/** @type {any} */ (fn).__setEnumId) === 'function') {
							/** @type {any} */ (fn).__setEnumId(path);
						}
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
				if (generation !== _lazyGeneration) return;
				console.error(realtimeErrorMessage(REALTIME_ERROR_IDS.LAZY_REGISTRATION, " '" + path + "'"), err);
			} finally { active.promise = null; }
		}
		if (generation !== _lazyGeneration) return;
		if (_activeQueue === active) _activeQueue = null;
		_lazyResolved = true;
		// Config assertions that need the FULL registration set have to re-run
		// here: the Vite codegen registers every aggregate lazily, so at
		// `_activateDerived` time the registry is still empty and an init-time
		// check would pass vacuously on exactly the apps it protects.
		//
		// Reported, never thrown. This runs inside the shared `_lazyInitPromise`,
		// which the RPC/cron/alarm paths await OUTSIDE their own try blocks and
		// fire-and-forget, so a throw here becomes an unhandled rejection - process
		// termination under Node's default, i.e. a crash loop under a supervisor,
		// with the triggering call never answered. A loud, repeated console error
		// is the right volume for a config mistake; the publish-time throw in the
		// privacy gate remains the actual enforcement.
		if (_afterResolve) {
			try {
				_afterResolve();
			} catch (err) {
				if (generation !== _lazyGeneration) return;
				console.error('[svelte-realtime] configuration error found after lazy registration:\n', err);
			}
		}
	});
	_lazyInitPromise = loading;
	await loading;
	if (generation !== _lazyGeneration) return _resolveAllLazy();
}

/** @type {(() => void) | null} Hook run once the lazy queue has fully drained. */
let _afterResolve = null;

/**
 * Register a callback to run after the lazy queue drains (see `_resolveAllLazy`).
 * @param {() => void} fn
 */
export function _setAfterLazyResolve(fn) {
	_afterResolve = fn;
}

/** Live read of the lazy-resolved flag - the staying RPC / cron paths gate on it. */
export function _isLazyResolved() { return _lazyResolved; }

/** Capture queued declarations and the uncommitted tail of an active drain. */
export function _snapshotLazyQueue() {
	const active = _activeQueue;
	const pending = active ? active.queue.slice(active.index) : [];
	if (active?.promise && pending.length) {
		const promise = active.promise;
		pending[0] = { ...pending[0], loader: () => promise };
	}
	return [...pending, ..._lazyQueue];
}

/** Reset lazy init state for HMR teardown (staying _prepareHmr cannot assign imported bindings). */
export function _resetLazy() {
	_lazyGeneration++;
	_activeQueue = null;
	_lazyResolved = false;
	_lazyInitPromise = null;
}
