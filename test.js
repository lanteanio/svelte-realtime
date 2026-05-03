// @ts-check
import { __register, __registerGuard, __registerCron, __registerDerived, __registerEffect, __registerAggregate, __registerRoomActions, handleRpc, LiveError, _clearCron, _activateDerived, close, unsubscribe } from './server.js';

/**
 * Assert that a promise rejects with a `LiveError` of the expected code.
 * Default expected code is `'FORBIDDEN'`, the code thrown by failing guards.
 * Returns the rejected error so further assertions can be made on it.
 *
 * @example
 * await expectGuardRejects(client.call('admin/destroyAll'));
 * await expectGuardRejects(client.call('admin/destroyAll'), 'UNAUTHENTICATED');
 * const err = await expectGuardRejects(client.call('foo'));
 * expect(err.message).toBe('Custom denial');
 *
 * @param {Promise<any>} promise
 * @param {string} [expectedCode]
 * @returns {Promise<LiveError>}
 */
export async function expectGuardRejects(promise, expectedCode = 'FORBIDDEN') {
	let err = /** @type {any} */ (null);
	let resolved = false;
	try {
		await promise;
		resolved = true;
	} catch (e) {
		err = e;
	}
	if (resolved) {
		throw new Error(`[svelte-realtime] expectGuardRejects: promise resolved (expected LiveError "${expectedCode}")`);
	}
	if (!(err instanceof LiveError)) {
		const got = err && err.constructor ? err.constructor.name : typeof err;
		const detail = err && err.message ? `: ${err.message}` : '';
		throw new Error(`[svelte-realtime] expectGuardRejects: expected LiveError "${expectedCode}", got ${got}${detail}`);
	}
	if (err.code !== expectedCode) {
		throw new Error(`[svelte-realtime] expectGuardRejects: expected code "${expectedCode}", got "${err.code}": ${err.message}`);
	}
	return err;
}

const textEncoder = new TextEncoder();

/**
 * Apply a single merge event to a value (mirrors client.js _applyMerge).
 * @param {any} current
 * @param {{ event: string, data: any }} envelope
 * @param {string} merge
 * @param {string} key
 * @returns {any}
 */
function _applyTestMerge(current, envelope, merge, key, opts) {
	const { event, data } = envelope;
	const prepend = opts?.prepend || false;
	const max = opts?.max || 50;

	if (merge === 'set') return data;

	if (merge === 'latest') {
		const arr = Array.isArray(current) ? [...current] : [];
		arr.push(data);
		if (arr.length > max) return arr.slice(-max);
		return arr;
	}

	if (merge === 'crud') {
		const arr = Array.isArray(current) ? [...current] : [];
		if (event === 'created') {
			const idx = arr.findIndex(item => item[key] === data[key]);
			if (idx >= 0) arr[idx] = data;
			else if (prepend) arr.unshift(data);
			else arr.push(data);
		} else if (event === 'updated') {
			const idx = arr.findIndex(item => item[key] === data[key]);
			if (idx >= 0) arr[idx] = data;
		} else if (event === 'deleted') {
			const idx = arr.findIndex(item => item[key] === data[key]);
			if (idx >= 0) arr.splice(idx, 1);
		}
		return arr;
	}

	if (merge === 'presence') {
		const arr = Array.isArray(current) ? [...current] : [];
		if (event === 'join') {
			const idx = arr.findIndex(item => item.key === data.key);
			if (idx >= 0) arr[idx] = data; else arr.push(data);
		} else if (event === 'leave') {
			const idx = arr.findIndex(item => item.key === data.key);
			if (idx >= 0) arr.splice(idx, 1);
		} else if (event === 'set') return data;
		return arr;
	}

	if (merge === 'cursor') {
		const arr = Array.isArray(current) ? [...current] : [];
		if (event === 'update') {
			const idx = arr.findIndex(item => item.key === data.key);
			if (idx >= 0) arr[idx] = data; else arr.push(data);
		} else if (event === 'remove') {
			const idx = arr.findIndex(item => item.key === data.key);
			if (idx >= 0) arr.splice(idx, 1);
		} else if (event === 'set') return data;
		return arr;
	}

	return data;
}

/**
 * Seeded pseudo-random number generator (mulberry32 variant). Returns a
 * function that produces deterministic [0, 1) sequences from a string seed.
 * Used by the chaos harness so a `seed: 'bug-1234'` config replays the same
 * drop pattern every test run.
 * @param {string} seed
 * @returns {() => number}
 */
function _seedRng(seed) {
	let h = 0;
	for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
	let t = h | 0;
	return function next() {
		t = (t + 0x6D2B79F5) | 0;
		let r = Math.imul(t ^ (t >>> 15), 1 | t);
		r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Create a test environment for testing live functions.
 * Provides mock WebSockets, platform, and helper methods for calling live functions
 * and subscribing to streams without a real WebSocket connection.
 *
 * @param {{ dev?: boolean, chaos?: { dropRate?: number, seed?: string } | null }} [options]
 * @returns {TestEnv}
 */
export function createTestEnv(options) {
	const isDev = options?.dev ?? false;

	/** @type {Map<string, Set<{ ws: any, cb: ((envelope: any) => void) | null }>>} */
	const topicSubscribers = new Map();

	/** @type {any[]} */
	const allConnections = [];

	/** @type {{ dropRate: number, seed: string | null } | null} Active chaos config; null disables. */
	let chaosConfig = null;
	/** @type {(() => number) | null} Seeded PRNG when seed is set; falls back to Math.random when null. */
	let chaosRng = null;
	/** @type {number} Running count of chaos-dropped publishes since last reset. */
	let chaosDropped = 0;

	function _applyChaos(config) {
		if (config == null) {
			chaosConfig = null;
			chaosRng = null;
			return;
		}
		if (typeof config !== 'object') {
			throw new Error('[svelte-realtime] chaos config must be an object or null');
		}
		const dropRate = config.dropRate ?? 0;
		if (typeof dropRate !== 'number' || !Number.isFinite(dropRate) || dropRate < 0 || dropRate > 1) {
			throw new Error('[svelte-realtime] chaos.dropRate must be a finite number in [0, 1]');
		}
		const seed = config.seed != null ? String(config.seed) : null;
		chaosConfig = { dropRate, seed };
		chaosRng = seed ? _seedRng(seed) : null;
	}

	function _shouldChaosDropPublish() {
		if (!chaosConfig || chaosConfig.dropRate === 0) return false;
		const r = chaosRng ? chaosRng() : Math.random();
		if (r < chaosConfig.dropRate) {
			chaosDropped++;
			return true;
		}
		return false;
	}

	if (options?.chaos != null) _applyChaos(options.chaos);

	const platform = {
		connections: 0,
		/**
		 * @param {string} topic
		 * @param {string} event
		 * @param {any} data
		 * @param {any} [opts]
		 */
		publish(topic, event, data, opts) {
			if (_shouldChaosDropPublish()) return false;
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
		batch(messages) {
			for (const msg of messages) {
				platform.publish(msg.topic, msg.event, msg.data, msg.options);
			}
		},
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
			} else if (fn?.__isRoom) {
				// Room export: register data stream + presence + cursors + actions
				const path = moduleName + '/' + name;
				if (fn.__dataStream) __register(path + '/__data', fn.__dataStream);
				if (fn.__presenceStream) __register(path + '/__presence', fn.__presenceStream);
				if (fn.__cursorStream) __register(path + '/__cursors', fn.__cursorStream);
				if (fn.__actions) {
					for (const [k, v] of Object.entries(fn.__actions)) {
						__register(path + '/__action/' + k, v);
					}
				}
			} else if (fn?.__isDerived) {
				__register(moduleName + '/' + name, fn);
				__registerDerived(moduleName + '/' + name, fn);
			} else if (fn?.__isEffect) {
				__registerEffect(moduleName + '/' + name, fn);
			} else if (fn?.__isAggregate) {
				__register(moduleName + '/' + name, fn);
				__registerAggregate(moduleName + '/' + name, fn);
			} else if (fn?.__isLive) {
				__register(moduleName + '/' + name, fn);
			} else if (fn?.__isCron) {
				__registerCron(moduleName + '/' + name, fn);
			}
		}
		// Activate derived/effect/aggregate reactive publish interception
		_activateDerived(platform);
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

		/** @type {Map<string, (topic: string, event: string, data: any) => void>} Keyed by request ID */
		const _sendHandlers = new Map();

		/** @type {Map<string, number>} Topic refcounts for the test ws */
		const _topicRefcounts = new Map();

		const ws = {
			getUserData: () => userData,
			subscribe: (topic) => {
				const rc = (_topicRefcounts.get(topic) || 0) + 1;
				_topicRefcounts.set(topic, rc);
				subscribedTopics.add(topic);
				if (!topicSubscribers.has(topic)) topicSubscribers.set(topic, new Set());
				const entry = { ws, cb: null };
				topicSubscribers.get(topic).add(entry);
				// Store entries as an array per topic to support multiple subscriptions
				if (!ws._topicEntries.has(topic)) ws._topicEntries.set(topic, []);
				ws._topicEntries.get(topic).push(entry);
				return true;
			},
			unsubscribe: (topic) => {
				const rc = (_topicRefcounts.get(topic) || 1) - 1;
				if (rc <= 0) {
					_topicRefcounts.delete(topic);
					subscribedTopics.delete(topic);
				} else {
					_topicRefcounts.set(topic, rc);
				}
				const entries = ws._topicEntries?.get(topic);
				if (entries && entries.length > 0) {
					const entry = entries.pop();
					topicSubscribers.get(topic)?.delete(entry);
					if (entries.length === 0) ws._topicEntries.delete(topic);
				}
				return true;
			},
			isSubscribed: (topic) => subscribedTopics.has(topic),
			getTopics: () => [...subscribedTopics],
			_topics: subscribedTopics,
			_topicEntries: new Map(),
			_onSend: null,
			_sendHandlers
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

				_sendHandlers.set(id, (topic, event, data) => {
					if (topic !== '__rpc' || event !== id) return;
					_sendHandlers.delete(id);
					const entry = pendingCalls.get(id);
					if (!entry) return;
					pendingCalls.delete(id);

					if (data && data.ok) {
						entry.resolve(data.data);
					} else if (data) {
						const err = new LiveError(data.code || 'UNKNOWN', data.error || 'Unknown error');
						if (data.issues) /** @type {any} */ (err).issues = data.issues;
						entry.reject(err);
					}
				});

				// Legacy single-slot for backward compat with tests that read ws._onSend
				ws._onSend = (topic, event, data) => {
					const handler = _sendHandlers.get(event);
					if (handler) handler(topic, event, data);
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

			_sendHandlers.set(streamId, (topic, event, data) => {
				if (topic !== '__rpc' || event !== streamId) return;
				_sendHandlers.delete(streamId);

				if (data && data.ok) {
					state.topic = data.topic || null;
					state.values.push(data.data);
					if (data.hasMore !== undefined) state.hasMore = data.hasMore;
					if (data.cursor !== undefined) state.cursor = data.cursor;

					state._merge = data.merge || 'crud';
					state._key = data.key || 'id';
					state._mergeOpts = { prepend: data.prepend, max: data.max };

					if (state.topic) {
						// Claim the first unclaimed entry for this topic (FIFO)
						const entries = ws._topicEntries?.get(state.topic);
						if (entries) {
							const entry = entries.find(e => !e.cb);
							if (entry) {
								entry.cb = (envelope) => {
									state.events.push(envelope);
									const current = state.values.length > 0 ? state.values[state.values.length - 1] : undefined;
									const merged = _applyTestMerge(current, envelope, state._merge, state._key, state._mergeOpts);
									state.values.push(merged);
								};
							}
						}
					}
				} else if (data) {
					state.error = new LiveError(data.code || 'UNKNOWN', data.error || 'Unknown error');
				}
			});

			ws._onSend = (topic, event, data) => {
				const handler = _sendHandlers.get(event);
				if (handler) handler(topic, event, data);
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
		 * @param {ArrayBuffer | ArrayBufferView} buffer
		 * @param {...any} args
		 * @returns {Promise<any>}
		 */
		function binary(path, buffer, ...args) {
			if (!connected) return Promise.reject(new Error('Disconnected'));

			return new Promise((resolve, reject) => {
				const id = 'test-' + (idCounter++).toString(36);
				pendingCalls.set(id, { resolve, reject });

				_sendHandlers.set(id, (topic, event, data) => {
					if (topic !== '__rpc' || event !== id) return;
					_sendHandlers.delete(id);
					const entry = pendingCalls.get(id);
					if (!entry) return;
					pendingCalls.delete(id);

					if (data && data.ok) {
						entry.resolve(data.data);
					} else if (data) {
						entry.reject(new LiveError(data.code || 'UNKNOWN', data.error || 'Unknown error'));
					}
				});

				ws._onSend = (topic, event, data) => {
					const handler = _sendHandlers.get(event);
					if (handler) handler(topic, event, data);
				};

				const header = JSON.stringify({ rpc: path, id, args: args.length > 0 ? args : undefined });
				const headerBytes = textEncoder.encode(header);
				if (headerBytes.length > 0xFFFF) {
					pendingCalls.delete(id);
					_sendHandlers.delete(id);
					reject(new LiveError('PAYLOAD_TOO_LARGE', 'Binary RPC header exceeds 65535 bytes'));
					return;
				}
				const bufBytes = ArrayBuffer.isView(buffer)
					? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
					: new Uint8Array(buffer);
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
			for (const [id, entry] of pendingCalls) {
				entry.reject(new LiveError('DISCONNECTED', 'WebSocket connection lost'));
			}
			pendingCalls.clear();
			// Set error on any in-flight stream opens still waiting for a response
			for (const [streamId, handler] of _sendHandlers) {
				// Trigger the handler with an error response so stream state gets set
				handler('__rpc', streamId, { ok: false, code: 'DISCONNECTED', error: 'WebSocket connection lost' });
			}
			_sendHandlers.clear();
			ws._onSend = null;
			close(ws, { platform, subscriptions: new Set(subscribedTopics) });
			for (const [topic, entries] of ws._topicEntries) {
				const subs = topicSubscribers.get(topic);
				if (subs) { for (const e of entries) subs.delete(e); }
			}
			ws._topicEntries.clear();
			subscribedTopics.clear();
			_topicRefcounts.clear();
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

	const chaos = {
		set(config) { _applyChaos(config); },
		disable() { _applyChaos(null); },
		get config() { return chaosConfig; },
		get dropped() { return chaosDropped; },
		resetCounter() { chaosDropped = 0; }
	};

	return { register, connect, tick, cleanup, platform, chaos };
}

/**
 * @typedef {object} TestEnv
 * @property {(moduleName: string, moduleExports: Record<string, any>) => void} register
 * @property {(userData: any) => TestClient} connect
 * @property {(ms?: number) => void} tick
 * @property {() => void} cleanup
 * @property {any} platform
 * @property {TestChaos} chaos
 */

/**
 * @typedef {object} TestChaos
 * @property {(config: { dropRate?: number, seed?: string } | null) => void} set
 * @property {() => void} disable
 * @property {{ dropRate: number, seed: string | null } | null} config
 * @property {number} dropped
 * @property {() => void} resetCounter
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
