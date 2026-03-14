// @ts-check
import { __register, __registerGuard, __registerCron, handleRpc, LiveError, _clearCron } from './server.js';

const textEncoder = new TextEncoder();

/**
 * Create a test environment for testing live functions.
 * Provides mock WebSockets, platform, and helper methods for calling live functions
 * and subscribing to streams without a real WebSocket connection.
 *
 * @param {{ dev?: boolean }} [options]
 * @returns {TestEnv}
 */
export function createTestEnv(options) {
	const isDev = options?.dev ?? false;

	/** @type {Map<string, Set<{ ws: any, cb: ((envelope: any) => void) | null }>>} */
	const topicSubscribers = new Map();

	/** @type {any[]} */
	const allConnections = [];

	const platform = {
		connections: 0,
		/**
		 * @param {string} topic
		 * @param {string} event
		 * @param {any} data
		 * @param {any} [opts]
		 */
		publish(topic, event, data, opts) {
			const subs = topicSubscribers.get(topic);
			if (!subs) return true;
			for (const sub of subs) {
				if (sub.cb) sub.cb({ event, data });
			}
			return true;
		},
		/**
		 * @param {any} ws
		 * @param {string} topic
		 * @param {string} event
		 * @param {any} data
		 */
		send(ws, topic, event, data) {
			if (ws._onSend) ws._onSend(topic, event, data);
			return 1;
		},
		sendTo() { return 0; },
		subscribers(topic) {
			return topicSubscribers.get(topic)?.size || 0;
		},
		topic(t) {
			return {
				publish: (event, data) => platform.publish(t, event, data),
				created: (data) => platform.publish(t, 'created', data),
				updated: (data) => platform.publish(t, 'updated', data),
				deleted: (data) => platform.publish(t, 'deleted', data),
				set: (value) => platform.publish(t, 'set', value),
				increment: (amount) => platform.publish(t, 'increment', amount),
				decrement: (amount) => platform.publish(t, 'decrement', amount)
			};
		}
	};

	/**
	 * Register a module's exports into the live function registry.
	 * @param {string} moduleName - e.g. 'chat'
	 * @param {Record<string, any>} moduleExports - The module's exports
	 */
	function register(moduleName, moduleExports) {
		for (const [name, fn] of Object.entries(moduleExports)) {
			if (name === '_guard' && fn?.__isGuard) {
				__registerGuard(moduleName, fn);
			} else if (fn?.__isLive) {
				__register(moduleName + '/' + name, fn);
			} else if (fn?.__isCron) {
				__registerCron(moduleName + '/' + name, fn);
			}
		}
	}

	/**
	 * Create a fake connected user.
	 * @param {any} userData - User data (like what upgrade() returns)
	 * @returns {TestClient}
	 */
	function connect(userData) {
		const subscribedTopics = new Set();
		/** @type {Map<string, { resolve: Function, reject: Function }>} */
		const pendingCalls = new Map();
		/** @type {Map<string, { values: any[], events: any[], topic: string | null, error: any }>} */
		const activeStreams = new Map();

		let connected = true;
		let idCounter = 0;

		const ws = {
			getUserData: () => userData,
			subscribe: (topic) => {
				subscribedTopics.add(topic);
				// Register for pub/sub on this topic
				if (!topicSubscribers.has(topic)) topicSubscribers.set(topic, new Set());
				const entry = { ws, cb: null };
				topicSubscribers.get(topic).add(entry);
				ws._topicEntries = ws._topicEntries || new Map();
				ws._topicEntries.set(topic, entry);
				return true;
			},
			unsubscribe: (topic) => {
				subscribedTopics.delete(topic);
				const entry = ws._topicEntries?.get(topic);
				if (entry) {
					topicSubscribers.get(topic)?.delete(entry);
					ws._topicEntries.delete(topic);
				}
				return true;
			},
			isSubscribed: (topic) => subscribedTopics.has(topic),
			_topics: subscribedTopics,
			_topicEntries: new Map(),
			_onSend: null
		};

		platform.connections++;
		allConnections.push(ws);

		/**
		 * Call a live() function.
		 * @param {string} path - e.g. 'chat/sendMessage'
		 * @param {...any} args
		 * @returns {Promise<any>}
		 */
		function call(path, ...args) {
			if (!connected) return Promise.reject(new Error('Disconnected'));

			return new Promise((resolve, reject) => {
				const id = 'test-' + (idCounter++).toString(36);
				pendingCalls.set(id, { resolve, reject });

				ws._onSend = (topic, event, data) => {
					if (topic !== '__rpc') return;
					const entry = pendingCalls.get(event);
					if (!entry) return;
					pendingCalls.delete(event);

					if (data && data.ok) {
						entry.resolve(data.data);
					} else if (data) {
						const err = new LiveError(data.code || 'UNKNOWN', data.error || 'Unknown error');
						if (data.issues) /** @type {any} */ (err).issues = data.issues;
						entry.reject(err);
					}
				};

				const msg = { rpc: path, id, args };
				const buf = textEncoder.encode(JSON.stringify(msg)).buffer;
				handleRpc(ws, buf, platform);
			});
		}

		/**
		 * Subscribe to a live.stream().
		 * @param {string} path - e.g. 'chat/messages'
		 * @param {...any} args
		 * @returns {TestStream}
		 */
		function subscribe(path, ...args) {
			if (!connected) throw new Error('Disconnected');

			/** @type {{ values: any[], events: any[], topic: string | null, error: any, hasMore: boolean, cursor: any }} */
			const state = { values: [], events: [], topic: null, error: null, hasMore: false, cursor: null };
			const streamId = 'test-' + (idCounter++).toString(36);

			ws._onSend = (topic, event, data) => {
				if (topic !== '__rpc' || event !== streamId) return;

				if (data && data.ok) {
					state.topic = data.topic || null;
					state.values.push(data.data);
					if (data.hasMore !== undefined) state.hasMore = data.hasMore;
					if (data.cursor !== undefined) state.cursor = data.cursor;

					// Set up pub/sub listener for live updates
					if (state.topic) {
						const entry = ws._topicEntries?.get(state.topic);
						if (entry) {
							entry.cb = (envelope) => {
								state.events.push(envelope);
							};
						}
					}
				} else if (data) {
					state.error = new LiveError(data.code || 'UNKNOWN', data.error || 'Unknown error');
				}
			};

			const msg = { rpc: path, id: streamId, args, stream: true };
			const buf = textEncoder.encode(JSON.stringify(msg)).buffer;
			handleRpc(ws, buf, platform);

			return {
				get value() { return state.values.length > 0 ? state.values[state.values.length - 1] : undefined; },
				get error() { return state.error; },
				get topic() { return state.topic; },
				get events() { return state.events; },
				get hasMore() { return state.hasMore; },
				/**
				 * Wait for a value matching a predicate.
				 * @param {(value: any) => boolean} predicate
				 * @param {number} [timeout]
				 * @returns {Promise<any>}
				 */
				async waitFor(predicate, timeout = 5000) {
					const start = Date.now();
					while (Date.now() - start < timeout) {
						const val = state.values.length > 0 ? state.values[state.values.length - 1] : undefined;
						if (val !== undefined && predicate(val)) return val;
						await new Promise(r => setTimeout(r, 10));
					}
					throw new Error(`waitFor timed out after ${timeout}ms`);
				}
			};
		}

		/**
		 * Call a live.binary() function.
		 * @param {string} path
		 * @param {ArrayBuffer} buffer
		 * @param {...any} args
		 * @returns {Promise<any>}
		 */
		function binary(path, buffer, ...args) {
			if (!connected) return Promise.reject(new Error('Disconnected'));

			return new Promise((resolve, reject) => {
				const id = 'test-' + (idCounter++).toString(36);
				pendingCalls.set(id, { resolve, reject });

				ws._onSend = (topic, event, data) => {
					if (topic !== '__rpc') return;
					const entry = pendingCalls.get(event);
					if (!entry) return;
					pendingCalls.delete(event);

					if (data && data.ok) {
						entry.resolve(data.data);
					} else if (data) {
						entry.reject(new LiveError(data.code || 'UNKNOWN', data.error || 'Unknown error'));
					}
				};

				// Build binary frame: byte[0] = 0x00, byte[1-2] = header length, then header JSON, then payload
				const header = JSON.stringify({ rpc: path, id, args: args.length > 0 ? args : undefined });
				const headerBytes = textEncoder.encode(header);
				const bufBytes = new Uint8Array(buffer);
				const frame = new Uint8Array(3 + headerBytes.length + bufBytes.length);
				frame[0] = 0x00;
				frame[1] = (headerBytes.length >> 8) & 0xFF;
				frame[2] = headerBytes.length & 0xFF;
				frame.set(headerBytes, 3);
				frame.set(bufBytes, 3 + headerBytes.length);

				handleRpc(ws, frame.buffer, platform);
			});
		}

		function disconnect() {
			connected = false;
			platform.connections--;
			for (const [topic, entry] of ws._topicEntries) {
				topicSubscribers.get(topic)?.delete(entry);
			}
			ws._topicEntries.clear();
			subscribedTopics.clear();
		}

		function reconnect() {
			connected = true;
			platform.connections++;
		}

		return { call, subscribe, binary, disconnect, reconnect };
	}

	/**
	 * Advance fake cron timers (not implemented -- cron uses real timers).
	 * @param {number} [_ms]
	 */
	function tick(_ms) {
		// Cron uses real setInterval; for testing, users should use vi.advanceTimersByTime()
	}

	function cleanup() {
		_clearCron();
		topicSubscribers.clear();
		allConnections.length = 0;
		platform.connections = 0;
	}

	return { register, connect, tick, cleanup, platform };
}

/**
 * @typedef {object} TestEnv
 * @property {(moduleName: string, moduleExports: Record<string, any>) => void} register
 * @property {(userData: any) => TestClient} connect
 * @property {(ms?: number) => void} tick
 * @property {() => void} cleanup
 * @property {any} platform
 */

/**
 * @typedef {object} TestClient
 * @property {(path: string, ...args: any[]) => Promise<any>} call
 * @property {(path: string, ...args: any[]) => TestStream} subscribe
 * @property {(path: string, buffer: ArrayBuffer, ...args: any[]) => Promise<any>} binary
 * @property {() => void} disconnect
 * @property {() => void} reconnect
 */

/**
 * @typedef {object} TestStream
 * @property {any} value
 * @property {any} error
 * @property {string | null} topic
 * @property {Array<{ event: string, data: any }>} events
 * @property {boolean} hasMore
 * @property {(predicate: (value: any) => boolean, timeout?: number) => Promise<any>} waitFor
 */
