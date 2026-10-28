// @ts-check

const MAX_BYTES = 4096;
const MAX_NODES = 128;
const MAX_DEPTH = 8;
const encoder = new TextEncoder();
const EMPTY = Object.freeze({});

/**
 * Snapshot explicitly supplied public metadata without invoking getters or
 * toJSON. Invalid metadata is omitted so the original error still reaches peers.
 * @param {unknown} value
 * @returns {import('./error-metadata.js').ErrorMetadata}
 */
export function copyErrorMetadata(value) {
	if (!value || typeof value !== 'object') return EMPTY;
	try {
		const params = Object.getOwnPropertyDescriptor(value, 'params');
		const details = Object.getOwnPropertyDescriptor(value, 'details');
		const retryAfter = Object.getOwnPropertyDescriptor(value, 'retryAfter');
		if (!params && !details && !retryAfter) return EMPTY;
		let nodes = 0;
		const seen = new Set();
		const clone = (item, depth) => {
			if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw 0;
			if (item === null || typeof item === 'boolean') return item;
			if (typeof item === 'number' && Number.isFinite(item)) return item;
			if (typeof item === 'string' && item.length <= MAX_BYTES) return item;
			if (!item || typeof item !== 'object' || seen.has(item)) throw 0;
			const array = Array.isArray(item);
			const prototype = Object.getPrototypeOf(item);
			if (!array && prototype !== Object.prototype && prototype !== null) throw 0;
			if (array && item.length > MAX_NODES) throw 0;
			if (Object.getOwnPropertySymbols(item).length) throw 0;
			seen.add(item);
			const result = array ? [] : {};
			for (const key of Object.keys(item)) {
				if (key.length > MAX_BYTES) throw 0;
				if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) throw 0;
				if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw 0;
				const descriptor = Object.getOwnPropertyDescriptor(item, key);
				if (!descriptor || !('value' in descriptor)) throw 0;
				result[key] = clone(descriptor.value, depth + 1);
			}
			if (array && Object.keys(result).length !== item.length) throw 0;
			seen.delete(item);
			return Object.freeze(result);
		};
		const result = {};
		for (const key of ['params', 'details']) {
			const descriptor = key === 'params' ? params : details;
			if (!descriptor) continue;
			if (!('value' in descriptor)) throw 0;
			if (descriptor.value !== undefined) result[key] = clone(descriptor.value, 0);
		}
		if ('params' in result && (!result.params || typeof result.params !== 'object' || Array.isArray(result.params))) return EMPTY;
		if (retryAfter && retryAfter.value !== undefined) {
			if (!('value' in retryAfter) || typeof retryAfter.value !== 'number' || !Number.isFinite(retryAfter.value) || retryAfter.value < 0) return EMPTY;
			result.retryAfter = retryAfter.value;
		}
		if (encoder.encode(JSON.stringify(result)).byteLength > MAX_BYTES) return EMPTY;
		return result;
	} catch {
		return EMPTY;
	}
}
