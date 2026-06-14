// @ts-check

/**
 * Defense-in-depth helpers for sanitizing user-supplied object data
 * before it lands in framework-owned reactive state.
 *
 * Why: any property assignment `target.__proto__ = X` mutates the
 * target's [[Prototype]], and `Object.assign(target, src)` with
 * `src.__proto__` present moves the value onto `Object.prototype`,
 * polluting every plain object in the realm. The wire format
 * (`JSON.parse`) does NOT prototype-pollute on its own (it sets
 * `__proto__` as an own property), but any downstream code that does
 * `Object.assign({}, item)` or `for..in` over the items inherits the
 * pollution path.
 *
 * The framework's CRUD / presence / cursor merge paths store
 * user-supplied envelopes verbatim in reactive arrays. Today's code
 * neither spreads nor `Object.assign`s those items - the stored shape
 * goes back out on the wire and into user code. We strip danger keys
 * at envelope ingress so a future refactor that introduces a spread
 * or assign cannot accidentally pollute the host process.
 *
 * @module svelte-realtime/shared/safe-assign
 */

/**
 * Keys that mutate `Object.prototype` (or shadow built-ins) when
 * assigned to a plain object. Frozen so a contributor cannot add a
 * "safe" key here later without thinking about the implication.
 */
export const PROTO_POLLUTION_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/**
 * Copy own enumerable properties from `src` into `dst`, skipping
 * `__proto__`, `constructor`, and `prototype`. Used to hydrate
 * snapshot state from an external source (Redis cache, JSON payload,
 * etc.) without giving the snapshot a path to set Object.prototype
 * properties via `Object.assign`. Returns `dst`.
 *
 * @template T
 * @param {T} dst
 * @param {Record<string, any>} src
 * @returns {T}
 */
export function safeAssign(dst, src) {
	for (const k of Object.keys(src)) {
		if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
		/** @type {any} */ (dst)[k] = /** @type {any} */ (src)[k];
	}
	return dst;
}

/**
 * Return `data` with `__proto__` / `constructor` / `prototype` stripped
 * as own properties, when present. When `data` has none of the danger
 * keys, returns `data` unchanged (no allocation, reference identity
 * preserved). When at least one is present, returns a fresh shallow
 * clone with those keys removed. Date, Map, Set and other non-plain
 * objects pass through unchanged.
 *
 * Arrays are processed element-by-element. The returned array is the
 * same reference when every element is danger-key-free, or a fresh
 * array containing sanitized clones for the elements that needed it.
 *
 * Performance contract: the no-danger-key path is `hasOwnProperty` x3
 * (~30ns) for plain objects, one iteration for arrays. No allocation
 * in the common case. Negligible against the surrounding merge cost.
 *
 * @template T
 * @param {T} data
 * @returns {T}
 */
export function sanitizeRowData(data) {
	if (!data || typeof data !== 'object') return data;
	if (Array.isArray(data)) {
		let cloned = null;
		for (let i = 0; i < data.length; i++) {
			const sanitized = sanitizeRowData(data[i]);
			if (sanitized !== data[i]) {
				if (cloned === null) cloned = data.slice();
				cloned[i] = sanitized;
			}
		}
		return /** @type {any} */ (cloned ?? data);
	}
	// Non-plain object (Date, Map, Set, etc.) - leave alone.
	if (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null) {
		return data;
	}
	const has = Object.prototype.hasOwnProperty;
	if (
		!has.call(data, '__proto__') &&
		!has.call(data, 'constructor') &&
		!has.call(data, 'prototype')
	) {
		return data;
	}
	const clone = /** @type {any} */ ({});
	for (const k of Object.keys(/** @type {any} */ (data))) {
		if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
		clone[k] = /** @type {any} */ (data)[k];
	}
	return clone;
}

/**
 * Throws when the supplied key value (the resolved `data[keyField]`
 * used as a Map / index slot) equals one of the prototype-pollution
 * strings. Map keys themselves are not exploitable - the Map stores
 * `'__proto__'` as a string key without mutating any prototype - but
 * a downstream `obj[mapKey] = value` assignment would, so callers that
 * use this value in BOTH a Map AND a plain-object assignment should
 * gate it through this assert.
 *
 * @param {unknown} keyValue
 */
export function assertSafeMergeKey(keyValue) {
	if (keyValue === '__proto__' || keyValue === 'constructor' || keyValue === 'prototype') {
		throw new Error(`unsafe merge key "${String(keyValue)}" - prototype-pollution shapes are filtered at envelope ingress`);
	}
}
