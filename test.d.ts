/**
 * Test utilities for svelte-realtime.
 * Provides mock WebSocket connections and helpers for testing live functions
 * without a real WebSocket server.
 */

import { LiveError } from './server.js';

/**
 * Create a test environment for testing live functions.
 *
 * @param options - Optional configuration
 *
 * @example
 * ```js
 * import { createTestEnv } from 'svelte-realtime/test';
 * import * as chat from './src/live/chat.js';
 *
 * const env = createTestEnv();
 * env.register('chat', chat);
 *
 * const alice = env.connect({ id: 'alice', name: 'Alice' });
 * const result = await alice.call('chat/sendMessage', 'Hello!');
 * ```
 */
export function createTestEnv(options?: {
	dev?: boolean;
	chaos?: { dropRate?: number; seed?: string } | null;
}): TestEnv;

/**
 * Build a `ctx`-shaped object for direct unit tests of guards, predicates,
 * or any function that takes `ctx` and synchronously returns a value.
 * Mirrors the production `_buildCtx` shape; helper methods are no-ops.
 *
 * For full publish/subscribe round-trips, prefer `createTestEnv()`.
 *
 * @param options - Optional fields to override on the returned ctx
 *
 * @example
 * ```js
 * import { createTestContext } from 'svelte-realtime/test';
 *
 * const adminOnly = (ctx) => ctx.user?.role === 'admin';
 * expect(adminOnly(createTestContext({ user: { role: 'admin' } }))).toBe(true);
 * expect(adminOnly(createTestContext())).toBe(false);
 * ```
 */
export function createTestContext(options?: {
	user?: any;
	ws?: any;
	platform?: any;
	requestId?: string;
	cursor?: any;
}): {
	user: any;
	ws: any;
	platform: any;
	publish: (topic: string, event: string, data: any, opts?: any) => boolean;
	cursor: any;
	throttle: () => void;
	debounce: () => void;
	signal: () => boolean;
	batch: () => void;
	shed: () => boolean;
	requestId: string;
};

/**
 * Assert that a promise rejects with a `LiveError` of the expected code.
 * Default expected code is `'FORBIDDEN'` (the code thrown by failing guards).
 * Returns the rejected error so further assertions can be made on it.
 *
 * @param promise - A promise expected to reject (typically `client.call(...)` or a stream open).
 * @param expectedCode - The error code to assert. Defaults to `'FORBIDDEN'`.
 *
 * @example
 * ```js
 * await expectGuardRejects(client.call('admin/destroyAll'));
 * await expectGuardRejects(client.call('admin/destroyAll'), 'UNAUTHENTICATED');
 *
 * const err = await expectGuardRejects(client.call('foo'));
 * expect(err.message).toBe('Custom denial');
 * ```
 */
export function expectGuardRejects(
	promise: Promise<any>,
	expectedCode?: string
): Promise<LiveError>;

/**
 * Test environment returned by `createTestEnv()`.
 */
export interface TestEnv {
	/**
	 * Register a module's exports into the live function registry.
	 * @param moduleName - Module name (e.g. 'chat')
	 * @param moduleExports - The module's exports object
	 */
	register(moduleName: string, moduleExports: Record<string, any>): void;

	/**
	 * Create a fake connected user.
	 * @param userData - User data (like what upgrade() returns)
	 */
	connect(userData: any): TestClient;

	/**
	 * Advance fake timers (cron uses real timers; use vi.advanceTimersByTime instead).
	 */
	tick(ms?: number): void;

	/**
	 * Clean up all state: clear registries, disconnect all clients, stop cron timers.
	 */
	cleanup(): void;

	/** The mock platform object. */
	platform: any;

	/** Chaos harness for fault-injection testing. See `TestChaos`. */
	chaos: TestChaos;
}

/**
 * Chaos harness exposed on `env.chaos`. Lets tests inject `platform.publish`
 * drops at a configurable rate, optionally seeded for deterministic replay.
 *
 * Currently models the `drop-outbound` scenario only -- pub/sub events are
 * dropped at the platform layer so subscribers receive nothing for the
 * dropped frame. RPC replies (`platform.send`) are never dropped because
 * timing them out would just hang test code.
 *
 * @example
 * ```js
 * const env = createTestEnv({ chaos: { dropRate: 0.5, seed: 'rep-1234' } });
 *
 * // Or runtime control:
 * env.chaos.set({ dropRate: 1.0 });
 * env.platform.publish('items', 'created', { id: 1 });
 * expect(env.chaos.dropped).toBe(1);
 *
 * env.chaos.disable();
 * env.platform.publish('items', 'created', { id: 1 });
 * // ... subscribers receive this one.
 * ```
 */
export interface TestChaos {
	/**
	 * Apply (or replace) the chaos config. Pass `null` to disable.
	 * @param config - `{ dropRate?: number, seed?: string }` or `null`
	 */
	set(config: { dropRate?: number; seed?: string } | null): void;

	/** Equivalent to `set(null)`. */
	disable(): void;

	/** Current chaos config, or `null` if disabled. */
	readonly config: { dropRate: number; seed: string | null } | null;

	/** Count of `platform.publish` calls dropped by chaos since the last reset. */
	readonly dropped: number;

	/** Reset the `dropped` counter. Does not change the active config. */
	resetCounter(): void;
}

/**
 * A fake connected client for testing.
 */
export interface TestClient {
	/**
	 * Call a live() function.
	 * @param path - RPC path (e.g. 'chat/sendMessage')
	 * @param args - Arguments to pass
	 */
	call(path: string, ...args: any[]): Promise<any>;

	/**
	 * Subscribe to a live.stream().
	 * @param path - Stream path (e.g. 'chat/messages')
	 * @param args - Arguments to pass
	 */
	subscribe(path: string, ...args: any[]): TestStream;

	/**
	 * Call a live.binary() function.
	 * @param path - RPC path
	 * @param buffer - Binary data
	 * @param args - Additional JSON arguments
	 */
	binary(path: string, buffer: ArrayBuffer | ArrayBufferView, ...args: any[]): Promise<any>;

	/** Simulate disconnection. */
	disconnect(): void;

	/** Simulate reconnection. */
	reconnect(): void;
}

/**
 * A test stream subscription.
 */
export interface TestStream {
	/** The latest value from the stream. */
	readonly value: any;
	/** Error if the stream failed. */
	readonly error: any;
	/** The topic the stream is subscribed to. */
	readonly topic: string | null;
	/** All pub/sub events received. */
	readonly events: Array<{ event: string; data: any }>;
	/** Whether more pages are available (pagination). */
	readonly hasMore: boolean;
	/**
	 * Wait for a value matching a predicate.
	 * @param predicate - Function that returns true when the desired value is found
	 * @param timeout - Maximum wait time in ms (default: 5000)
	 */
	waitFor(predicate: (value: any) => boolean, timeout?: number): Promise<any>;
	/**
	 * Simulate a server-side publish on this stream's topic. Equivalent to
	 * calling `env.platform.publish(stream.topic, event, data)`, but
	 * discoverable on the stream return where the test is already focused.
	 * Throws if the stream's topic is not yet known (await the initial
	 * subscribe before calling).
	 *
	 * @param event - Pub/sub event name (e.g. 'created', 'updated')
	 * @param data - Event payload
	 */
	simulatePublish(event: string, data: any): void;
}
