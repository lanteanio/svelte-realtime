// @ts-check

/**
 * Helpers shared by client.js (`_applyMergeFn`) and test.js (`_applyTestMerge`)
 * that touch the merge-strategy taxonomy. The full apply-merge logic itself
 * is intentionally NOT shared:
 *
 *  - client.js mutates a caller-supplied value/index pair in place for the
 *    reactive store hot path (O(1) Map lookups, no per-event allocation).
 *  - test.js returns fresh arrays via findIndex so user-written tests can
 *    eyeball the result without an index Map leaking into their fixtures.
 *
 * Forcing both paths through one implementation would either regress the
 * hot path or leak indexing internals into the test harness DX. Instead,
 * the small primitives that DO recur literally (key-field selection,
 * index rebuild) live here.
 *
 * @module svelte-realtime/shared/merge
 */

/**
 * Resolve the field on each item that identifies its slot in the indexed
 * value. `presence` and `cursor` strategies always use `'key'` (their data
 * shape is `{ key, ... }`); `crud` uses the user-supplied key.
 *
 * @param {string} merge - merge strategy
 * @param {string} defaultKey - the user-configured key (used for `crud`)
 * @returns {string}
 */
export function mergeKeyField(merge, defaultKey) {
	return (merge === 'presence' || merge === 'cursor') ? 'key' : defaultKey;
}

/**
 * Whether a crud row is older than the row held at its key, by the stream's
 * `rowVersion` field. Versions compare when both are numbers or both are
 * strings; a row without a comparable version is never stale. A write
 * (`created` / `updated`) must be newer than the held row; a delete is
 * stale only below the held version.
 *
 * @param {string | null | undefined} field - the stream's `rowVersion`
 * @param {any} incoming - the event's row
 * @param {any} held - the row currently held at its key
 * @param {boolean} [isDelete]
 * @returns {boolean}
 */
export function isStaleRow(field, incoming, held, isDelete = false) {
	if (!field || incoming == null || held == null) return false;
	const next = incoming[field];
	const prev = held[field];
	if (typeof next !== typeof prev) return false;
	if (typeof next === 'number') {
		if (Number.isNaN(next) || Number.isNaN(prev)) return false;
	} else if (typeof next !== 'string') return false;
	return isDelete ? next < prev : next <= prev;
}

/**
 * Rebuild a key->index lookup Map from the given array. No-op for merge
 * strategies that do not maintain an index (`set`, `latest`).
 *
 * @param {any} value - the array to index (or non-array, in which case we just clear)
 * @param {Map<any, number>} index - the Map to rebuild in place
 * @param {string} merge - merge strategy
 * @param {string} defaultKey - the user-configured key
 */
export function rebuildIndex(value, index, merge, defaultKey) {
	index.clear();
	if (!Array.isArray(value)) return;
	if (merge === 'set' || merge === 'latest') return;
	const k = mergeKeyField(merge, defaultKey);
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (item != null && item[k] !== undefined) {
			index.set(item[k], i);
		}
	}
}
