import type { Readable } from 'svelte/store';

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
 * `subscribe { schemaVersion: N }` envelope goes out, the server runs
 * its registered migrate chain forward to the current server version,
 * and returns the migrated payload.
 *
 * **Faithful production semantics:** as in production, migration is
 * applied ONCE on the initial subscribe response. Subsequent live
 * publishes arrive as raw v2 events and merge into the migrated v1
 * base just as a real reconnected v1 client would experience.
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
 *   import { counter } from '$live/streams';
 *   import { subscribeAt } from 'svelte-realtime/test-client';
 *   const counterAsV1 = subscribeAt(counter, { schemaVersion: 1 });
 * </script>
 *
 * <div>Live (v2):                {JSON.stringify($counter)}</div>
 * <div>What a v1 client would see: {JSON.stringify($counterAsV1)}</div>
 * ```
 */
export function subscribeAt<T = unknown>(
	stream: Readable<T> | ((...args: any[]) => Readable<T>),
	options: { schemaVersion: number }
): Readable<T>;
