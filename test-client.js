// @ts-check
import { _createStreamAtSchemaVersion } from './client.js';

/**
 * Test/demo affordance: subscribe to a stream at a chosen client-side
 * `schemaVersion`, exercising the server's registered `migrate` chain
 * end-to-end on the wire. Returns a parallel Svelte store, separate
 * from the production store, that you can `$`-prefix in templates or
 * read with `subscribe(...)` like any other store.
 *
 * **Use cases:**
 *
 * - **Demo pages** that want to show "what would a stale v1 client see
 *   on reconnect right now?" - render two side-by-side panels, one
 *   with the live store and one with `subscribeAt(stream, { schemaVersion: 1 })`.
 * - **e2e tests** that need to assert the migrate chain produces the
 *   expected v2-shape from a v1-cached subscribe, walking the real
 *   wire path (not a unit-tested helper).
 *
 * The wire path is identical to a real reconnecting stale client: a
 * `subscribe { schemaVersion: N }` envelope goes out, the server's
 * `_executeStreamRpc` ([server.js:6085-6088](https://github.com/lanteanio/svelte-realtime/blob/main/server.js#L6085))
 * sees `clientSchemaVersion < serverVersion`, runs `_migrateData`
 * forward through the registered migrate chain, and returns the
 * migrated payload.
 *
 * **Faithful production semantics:** as in production, migration is
 * applied ONCE on the initial subscribe response. Subsequent live
 * publishes arrive as raw v2 events and merge into the migrated v1
 * base just as a real reconnected v1 client would experience - the
 * panel shows the migrated initial state, then forward-merges new
 * events at the server's current shape.
 *
 * **Why this lives in `/test-client` and not the main client surface:**
 * a public client-side API for "pin my schema version" would let
 * production code chain through migrations on every fetch, which is
 * wasteful and confusing. Schema migration is fundamentally about
 * long-disconnected clients catching up, not opt-in version pinning.
 * The `/test-client` import path makes the test/demo intent loud.
 *
 * @example
 * ```svelte
 * <script>
 *   import { counter } from '$live/streams';                  // production v2 store
 *   import { subscribeAt } from 'svelte-realtime/test-client';
 *   const counterAsV1 = subscribeAt(counter, { schemaVersion: 1 });
 * </script>
 *
 * <div>Live (v2):                {JSON.stringify($counter)}</div>
 * <div>What a v1 client would see: {JSON.stringify($counterAsV1)}</div>
 * ```
 *
 * @example
 * ```js
 * // Dynamic stream: pass the cached store from the factory call.
 * import { messages } from '$live/streams';
 * import { subscribeAt } from 'svelte-realtime/test-client';
 *
 * const v1Messages = subscribeAt(messages('room-1'), { schemaVersion: 1 });
 * ```
 *
 * @template T
 * @param {import('svelte/store').Readable<T> | ((...args: any[]) => import('svelte/store').Readable<T>)} stream
 *   A stream returned by a generated `$live/...` import (or by
 *   calling a dynamic-stream factory). Throws if you pass a regular
 *   writable / readable that doesn't carry the stamped metadata.
 * @param {{ schemaVersion: number }} options
 * @returns {import('svelte/store').Readable<T>}
 */
export function subscribeAt(stream, options) {
	if (!stream || (typeof stream !== 'object' && typeof stream !== 'function')) {
		throw new Error(
			'[svelte-realtime] subscribeAt: first argument must be a stream from a generated `$live/...` import (or a dynamic-stream factory call), got ' + typeof stream
		);
	}
	const path = /** @type {any} */ (stream).__streamPath;
	if (typeof path !== 'string' || path.length === 0) {
		throw new Error(
			'[svelte-realtime] subscribeAt: argument is not a stream - it carries no `__streamPath`. Pass an export from `$live/...` (e.g. `subscribeAt(counter, { schemaVersion: 1 })`), not a hand-rolled writable. If `counter` is a dynamic factory, call it first: `subscribeAt(messages("room-1"), { schemaVersion: 1 })`.'
		);
	}
	if (!options || typeof options !== 'object') {
		throw new Error('[svelte-realtime] subscribeAt: second argument must be { schemaVersion }');
	}
	const schemaVersion = options.schemaVersion;
	if (typeof schemaVersion !== 'number' || !Number.isFinite(schemaVersion) || schemaVersion < 0 || !Number.isInteger(schemaVersion)) {
		throw new Error(
			'[svelte-realtime] subscribeAt: options.schemaVersion must be a non-negative integer (got ' + JSON.stringify(schemaVersion) + ')'
		);
	}
	const streamOptions = /** @type {any} */ (stream).__streamOptions;
	const streamArgs = /** @type {any} */ (stream).__streamArgs;
	return _createStreamAtSchemaVersion(path, streamOptions, streamArgs, schemaVersion);
}
