/**
 * Test utilities for svelte-realtime.
 * Provides mock WebSocket connections and helpers for testing live functions
 * without a real WebSocket server.
 */

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
export function createTestEnv(options?: { dev?: boolean }): TestEnv;

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
	binary(path: string, buffer: ArrayBuffer, ...args: any[]): Promise<any>;

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
}
