// @ts-check

// Registry symbols mark RpcError and LiveError on their prototypes, so a
// check recognizes an instance created by another evaluation of the same
// class. Vite development can evaluate this package twice in one process:
// the server entry runs in Node while modules that reach it through a
// relative import run in the SSR module graph.

export const RPC_ERROR_BRAND = /* @__PURE__ */ Symbol.for('svelte-realtime.rpc-error');
export const LIVE_ERROR_BRAND = /* @__PURE__ */ Symbol.for('svelte-realtime.live-error');

/**
 * Whether `value` carries `brand`, from any copy of its class.
 * @param {unknown} value
 * @param {symbol} brand
 * @returns {boolean}
 */
export function hasErrorBrand(value, brand) {
	return value !== null && typeof value === 'object' && /** @type {any} */ (value)[brand] === true;
}
