// @ts-check
import * as stores from 'svelte/store';
import { microtask } from '../client-runtime.js';

/** Snapshots do not subscribe, including when another projection reads them. */
const snapshots = new WeakMap();
const ssrSnapshot = Symbol.for('svelte-realtime.ssr-snapshot');

/** @param {any} store */
export function _hasCurrent(store) { return snapshots.has(store); }

/** SSR stores expose snapshots without a browser subscription bridge. */
export function _canPeek(store) { return snapshots.has(store) || store?.[ssrSnapshot] === true; }

/** @param {any} store */
export function _peekCurrent(store) { return snapshots.has(store) ? snapshots.get(store).read() : store.current; }

/** A stream's token changes even when its data is updated in place. */
export function _currentVersion(store) { return snapshots.has(store) ? snapshots.get(store).version() : store.current; }

/** Read a private, in-memory store, never a transport-backed public store. */
export function _localValue(store) {
	let value;
	store.subscribe(v => { value = v; })();
	return value;
}

/**
 * Add a cached read without changing the store subscription contract. Svelte's
 * fromStore subscribes briefly even outside a reaction; those reads receive a
 * snapshot and cancel before the deferred upstream subscription can start.
 * A lasting reaction owns the upstream until Svelte releases its last reader.
 * The namespace import keeps the same stores usable with Svelte 4.
 * @template {{ subscribe: Function }} T
 * @param {T} store
 * @param {() => any} read
 * @param {() => any} [version]
 * @returns {T & { readonly current: any }}
 */
export function _withCurrent(store, read, version = read) {
	let bridge;
	snapshots.set(store, { read, version });
	Object.defineProperty(store, 'current', {
		enumerable: true,
		get() {
			if (typeof stores.fromStore === 'function') {
				bridge ??= stores.fromStore({
					subscribe(run) {
						let active = true;
						let stop;
						run(read());
						microtask(() => {
							if (!active) return;
							stop = store.subscribe(run);
							if (!active) stop();
						});
						return () => { active = false; stop?.(); };
					}
				});
				void bridge.current;
			}
			return read();
		}
	});
	return /** @type {T & { readonly current: any }} */ (store);
}
