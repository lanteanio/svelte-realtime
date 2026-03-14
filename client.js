// @ts-check
import { connect as _connect, on, status } from 'svelte-adapter-uws/client';
import { writable } from 'svelte/store';

const _textEncoder = new TextEncoder();

/**
 * Typed error for RPC failures.
 */
export class RpcError extends Error {
	/**
	 * @param {string} code
	 * @param {string} [message]
	 */
	constructor(code, message) {
		super(message || code);
		this.code = code;
	}
}

/** Incrementing counter for short correlation IDs, prefixed to avoid cross-tab collision */
const _idPrefix = Math.random().toString(36).slice(2, 6);
let idCounter = 0;

/** @type {Array<{ rpc: string, id: string, args: any[] }> | null} */
let _batchCollector = null;

/** @type {Map<string, Promise<any>>} */
const _dedupMap = new Map();

/** @type {Map<string, { resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout> | null }>} */
const pending = new Map();

/** @type {boolean} */
let listenerAttached = false;

/** @type {boolean} */
let disconnectListenerAttached = false;

/**
 * Attach the __rpc topic listener once.
 * Listens for RPC responses and resolves/rejects the matching pending promise.
 */
function ensureListener() {
	if (listenerAttached) return;
	listenerAttached = true;

	const store = on('__rpc');
	store.subscribe((envelope) => {
		if (!envelope) return;
		const { event: correlationId, data } = envelope;
		const entry = pending.get(correlationId);
		if (!entry) return;
		pending.delete(correlationId);
		if (entry.timer) clearTimeout(entry.timer);

		if (data && data.ok) {
			entry.resolve(entry.stream ? data : data.data);
		} else if (data) {
			const err = new RpcError(data.code || 'UNKNOWN', data.error || 'Unknown error');
			if (data.issues) /** @type {any} */ (err).issues = data.issues;
			entry.reject(err);
		}
	});
}

/**
 * Attach a disconnect listener once.
 * Rejects all in-flight RPCs (already sent) with DISCONNECTED.
 */
function ensureDisconnectListener() {
	if (disconnectListenerAttached) return;
	disconnectListenerAttached = true;

	status.subscribe((s) => {
		if (s === 'closed') {
			for (const [id, entry] of pending) {
				pending.delete(id);
				if (entry.timer) clearTimeout(entry.timer);
				entry.reject(new RpcError('DISCONNECTED', 'WebSocket connection lost'));
			}
		}
	});
}

/**
 * Build a dedup key from path and args, avoiding JSON.stringify for common cases.
 * @param {string} path
 * @param {any[]} args
 * @returns {string}
 */
function _buildDedupKey(path, args) {
	if (args.length === 0) return path;
	if (args.length === 1) {
		const a = args[0];
		if (a === null) return path + '\0null';
		const t = typeof a;
		if (t === 'string' || t === 'number' || t === 'boolean') {
			return path + '\0' + a;
		}
	}
	return path + '\0' + JSON.stringify(args);
}

/**
 * Create a callable RPC function for a given path.
 * Used by generated client stubs.
 *
 * @param {string} path - e.g. 'chat/sendMessage'
 * @returns {((...args: any[]) => Promise<any>) & { fresh: (...args: any[]) => Promise<any> }}
 */
export function __rpc(path) {
	function rpcCall(...args) {
		// Dedup: coalesce identical calls within the same microtask
		if (!_batchCollector) {
			const dedupKey = _buildDedupKey(path, args);
			const existing = _dedupMap.get(dedupKey);
			if (existing) return existing;

			const promise = _sendRpc(path, args);
			_dedupMap.set(dedupKey, promise);
			queueMicrotask(() => _dedupMap.delete(dedupKey));
			return promise;
		}
		return _sendRpc(path, args);
	}

	/** Bypass deduplication -- always send a fresh request. */
	rpcCall.fresh = function freshCall(...args) {
		return _sendRpc(path, args);
	};

	return rpcCall;
}

/**
 * Internal: send an RPC request over the WebSocket.
 * @param {string} path
 * @param {any[]} args
 * @returns {Promise<any>}
 */
function _sendRpc(path, args) {
	ensureListener();
	ensureDisconnectListener();

	if (typeof process === 'undefined' || (typeof import.meta !== 'undefined' && import.meta.env?.DEV)) {
		_checkArgs(path, args);
	}

	// Offline queue: if disconnected and queue is enabled, defer the call
	if (_isOffline && _clientConfig.offline?.queue && !_batchCollector) {
		const maxQueue = _clientConfig.offline.maxQueue || 100;
		return new Promise((resolve, reject) => {
			if (_offlineQueue.length >= maxQueue) {
				// Drop oldest
				const dropped = _offlineQueue.shift();
				if (dropped) dropped.reject(new RpcError('QUEUE_FULL', 'Offline queue overflow -- oldest mutation dropped'));
			}
			_offlineQueue.push({ path, args, queuedAt: Date.now(), resolve, reject });
		});
	}

	const id = _idPrefix + (idCounter++).toString(36);

	// If inside a batch() call, collect instead of sending
	if (_batchCollector) {
		_batchCollector.push({ rpc: path, id, args });
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject, timer: null });
		});
	}

	_devtoolsStart(path, id, args);
	const conn = _connect();

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			_devtoolsEnd(id, false, 'TIMEOUT');
			reject(new RpcError('TIMEOUT', `RPC '${path}' timed out after 30s`));
		}, 30000);

		pending.set(id, {
			resolve(v) { _devtoolsEnd(id, true, v); resolve(v); },
			reject(e) { _devtoolsEnd(id, false, e); reject(e); },
			timer
		});
		conn.sendQueued({ rpc: path, id, args });
	});
}

/**
 * Create a callable binary RPC function for a given path.
 * Sends the first argument as raw binary and remaining args as JSON in a header.
 *
 * @param {string} path - e.g. 'upload/avatar'
 * @returns {(buffer: ArrayBuffer, ...args: any[]) => Promise<any>}
 */
export function __binaryRpc(path) {
	return function binaryRpcCall(buffer, ...args) {
		ensureListener();
		ensureDisconnectListener();

		const id = _idPrefix + (idCounter++).toString(36);

		_devtoolsStart(path, id, args);
		const conn = _connect();

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				_devtoolsEnd(id, false, 'TIMEOUT');
				reject(new RpcError('TIMEOUT', `Binary RPC '${path}' timed out after 30s`));
			}, 30000);

			pending.set(id, {
				resolve(v) { _devtoolsEnd(id, true, v); resolve(v); },
				reject(e) { _devtoolsEnd(id, false, e); reject(e); },
				timer
			});

			// Wire format: byte[0] = 0x00, byte[1-2] = header length (uint16 BE), then JSON header, then binary payload
			const header = JSON.stringify({ rpc: path, id, args: args.length > 0 ? args : undefined });
			const headerBytes = _textEncoder.encode(header);
			const bufBytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer || buffer);
			const frame = new Uint8Array(3 + headerBytes.length + bufBytes.length);
			frame[0] = 0x00;
			frame[1] = (headerBytes.length >> 8) & 0xFF;
			frame[2] = headerBytes.length & 0xFF;
			frame.set(headerBytes, 3);
			frame.set(bufBytes, 3 + headerBytes.length);

			conn.sendQueued(frame.buffer);
		});
	};
}

/** @type {Map<string, { store: any, refCount: number }>} */
const _streamCache = new Map();

/**
 * Create a reactive stream store for a given path.
 * Used by generated client stubs.
 *
 * When `dynamicArgs` is provided, returns a factory function that creates
 * cached store instances keyed by serialized args.
 *
 * @param {string} path - e.g. 'chat/messages'
 * @param {{ merge?: 'crud' | 'latest' | 'set' | 'presence' | 'cursor', key?: string, prepend?: boolean, max?: number }} [options]
 * @param {boolean} [isDynamic] - If true, returns a function that accepts args
 * @returns {import('svelte/store').Readable<any> | ((...args: any[]) => import('svelte/store').Readable<any>)}
 */
export function __stream(path, options, isDynamic) {
	if (isDynamic) {
		return function dynamicStream(...args) {
			let cacheKey;
			if (args.length === 1) {
				const a = args[0];
				const t = typeof a;
				if (t === 'string' || t === 'number') cacheKey = path + ':' + a;
				else cacheKey = path + ':' + JSON.stringify(args);
			} else {
				cacheKey = path + ':' + JSON.stringify(args);
			}
			const cached = _streamCache.get(cacheKey);
			if (cached) return cached.store;

			const store = _createStream(path, options, args);
			// Capture the original subscribe once, before wrapping
			const rawSubscribe = store.subscribe.bind(store);
			_streamCache.set(cacheKey, { store, refCount: 0 });

			// Wrap subscribe to track ref count and clean up cache on last unsubscribe
			store.subscribe = function cachedSubscribe(fn) {
				const entry = _streamCache.get(cacheKey);
				if (entry) entry.refCount++;

				const unsub = rawSubscribe(fn);
				return () => {
					unsub();
					const entry = _streamCache.get(cacheKey);
					if (entry && --entry.refCount <= 0) {
						_streamCache.delete(cacheKey);
					}
				};
			};

			return store;
		};
	}
	return _createStream(path, options);
}

/**
 * @param {string} path
 * @param {{ merge?: 'crud' | 'latest' | 'set' | 'presence' | 'cursor', key?: string, prepend?: boolean, max?: number }} [options]
 * @param {any[]} [dynamicArgs]
 * @returns {any}
 */
function _createStream(path, options, dynamicArgs) {
	let merge = options?.merge || 'crud';
	let key = options?.key || 'id';
	let prepend = options?.prepend || false;
	let max = options?.max || 50;

	/** @type {any} */
	let currentValue;
	const store = writable(undefined);

	/** @type {string | null} */
	let topic = null;

	/** @type {Array<{ event: string, data: any }>} */
	let buffer = [];

	/** @type {boolean} */
	let initialLoaded = false;

	/** @type {boolean} */
	let fetching = false;

	/** @type {(() => void) | null} */
	let topicUnsub = null;

	/** @type {(() => void) | null} */
	let statusUnsub = null;

	let subCount = 0;
	let pendingId = null;

	/** @type {boolean} */
	let _hydrated = false;

	/** @type {number | null} Last known sequence number for replay */
	let _lastSeq = null;

	/** @type {any} Cursor for pagination (server-provided) */
	let _cursor = null;

	/** @type {boolean} Whether more pages are available */
	let _hasMore = false;

	/** @type {boolean} Whether a loadMore request is in flight */
	let _loadingMore = false;

	/** @type {number | undefined} Schema version from server */
	let _schemaVersion = undefined;

	/** @type {any} Last known version for delta sync */
	let _lastVersion = undefined;

	/** @type {Set<any>} Keys of optimistic entries pending server confirmation */
	const _optimisticKeys = new Set();

	/** @type {Map<any, number>} Key-to-index lookup for keyed merge strategies */
	const _index = new Map();

	/** @type {any[]} Undo/redo history stack */
	let _history = [];
	/** @type {number} Current position in history (-1 = no history) */
	let _historyIndex = -1;
	/** @type {boolean} Whether history tracking is enabled */
	let _historyEnabled = false;
	/** @type {boolean} Whether history recording is paused (events still apply, just no snapshots) */
	let _historyPaused = false;
	/** @type {number} Maximum history entries */
	let _historyMax = 50;

	/** @type {ReturnType<typeof setTimeout> | null} Reconnect debounce timer */
	let _reconnectTimer = null;

	/**
	 * Rebuild the key->index lookup map from currentValue.
	 * Only meaningful for keyed merge strategies (crud, presence, cursor).
	 */
	function _rebuildIndex() {
		_index.clear();
		if (!Array.isArray(currentValue)) return;
		if (merge === 'set' || merge === 'latest') return;
		const k = (merge === 'presence' || merge === 'cursor') ? 'key' : key;
		for (let i = 0; i < currentValue.length; i++) {
			const item = currentValue[i];
			if (item != null && item[k] !== undefined) {
				_index.set(item[k], i);
			}
		}
	}

	/**
	 * Record current state in history after a mutation (if history enabled).
	 * Called after currentValue has been updated and a new reference created.
	 */
	function _recordHistory() {
		if (!_historyEnabled || _historyPaused) return;
		// Discard any redo entries after the current position
		if (_historyIndex < _history.length - 1) {
			_history.length = _historyIndex + 1;
		}
		// Snapshot must be a copy since _applyMerge mutates currentValue in place
		const snapshot = Array.isArray(currentValue) ? currentValue.slice() : currentValue;
		_history.push(snapshot);
		if (_history.length > _historyMax) {
			_history.shift();
		}
		_historyIndex = _history.length - 1;
	}

	/**
	 * Apply a merge event in place (mutates currentValue, updates _index).
	 * Does NOT call store.set or _recordHistory.
	 * Returns true if currentValue was replaced with a new reference (no copy needed).
	 * @param {{ event: string, data: any, seq?: number }} envelope
	 * @returns {boolean}
	 */
	function _applyMerge(envelope) {
		const { event, data } = envelope;

		if (envelope.seq !== undefined) _lastSeq = envelope.seq;

		if (merge === 'crud') {
			if (!Array.isArray(currentValue)) { currentValue = []; _index.clear(); }

			if (data && data[key] !== undefined) {
				_optimisticKeys.delete(data[key]);
			}

			if (event === 'created') {
				const idx = _index.get(data[key]);
				if (idx !== undefined) {
					currentValue[idx] = data;
				} else if (prepend) {
					currentValue.unshift(data);
					for (const [k, i] of _index) _index.set(k, i + 1);
					_index.set(data[key], 0);
				} else {
					_index.set(data[key], currentValue.length);
					currentValue.push(data);
				}
			} else if (event === 'updated') {
				const idx = _index.get(data[key]);
				if (idx !== undefined) currentValue[idx] = data;
			} else if (event === 'deleted') {
				const idx = _index.get(data[key]);
				if (idx !== undefined) {
					currentValue.splice(idx, 1);
					_index.delete(data[key]);
					for (const [k, i] of _index) {
						if (i > idx) _index.set(k, i - 1);
					}
				}
			}
			return false;
		} else if (merge === 'latest') {
			if (!Array.isArray(currentValue)) currentValue = [];
			currentValue.push(data);
			if (currentValue.length > max) {
				currentValue = currentValue.slice(-max);
				return true;
			}
			return false;
		} else if (merge === 'presence') {
			if (!Array.isArray(currentValue)) { currentValue = []; _index.clear(); }
			if (event === 'join') {
				const idx = _index.get(data.key);
				if (idx !== undefined) {
					currentValue[idx] = data;
				} else {
					_index.set(data.key, currentValue.length);
					currentValue.push(data);
				}
			} else if (event === 'leave') {
				const idx = _index.get(data.key);
				if (idx !== undefined) {
					currentValue.splice(idx, 1);
					_index.delete(data.key);
					for (const [k, i] of _index) {
						if (i > idx) _index.set(k, i - 1);
					}
				}
			} else if (event === 'set') {
				currentValue = data;
				_rebuildIndex();
				return true;
			}
			return false;
		} else if (merge === 'cursor') {
			if (!Array.isArray(currentValue)) { currentValue = []; _index.clear(); }
			if (event === 'update') {
				const idx = _index.get(data.key);
				if (idx !== undefined) {
					currentValue[idx] = data;
				} else {
					_index.set(data.key, currentValue.length);
					currentValue.push(data);
				}
			} else if (event === 'remove') {
				const idx = _index.get(data.key);
				if (idx !== undefined) {
					currentValue.splice(idx, 1);
					_index.delete(data.key);
					for (const [k, i] of _index) {
						if (i > idx) _index.set(k, i - 1);
					}
				}
			} else if (event === 'set') {
				currentValue = data;
				_rebuildIndex();
				return true;
			}
			return false;
		} else if (merge === 'set') {
			currentValue = data;
			return true;
		}
		return false;
	}

	/**
	 * Apply a single pub/sub event to the current value using the merge strategy.
	 * Creates a new array reference for Svelte reactivity only when needed.
	 * @param {{ event: string, data: any }} envelope
	 */
	function applyEvent(envelope) {
		const replaced = _applyMerge(envelope);
		if (!replaced && Array.isArray(currentValue)) currentValue = currentValue.slice();
		store.set(currentValue);
		_recordHistory();
	}

	/**
	 * Fetch initial data and subscribe to live updates.
	 */
	function fetchAndSubscribe() {
		if (fetching) return;
		fetching = true;
		initialLoaded = false;
		buffer = [];

		// Cancel any previous pending request
		if (pendingId) {
			const prev = pending.get(pendingId);
			if (prev) {
				pending.delete(pendingId);
				if (prev.timer) clearTimeout(prev.timer);
			}
			pendingId = null;
		}

		ensureListener();
		ensureDisconnectListener();

		const id = _idPrefix + (idCounter++).toString(36);
		pendingId = id;
		const conn = _connect();

		const timer = setTimeout(() => {
			pending.delete(id);
			pendingId = null;
			fetching = false;
			store.set({ error: new RpcError('TIMEOUT', `Stream '${path}' timed out after 30s`) });
		}, 30000);

		pending.set(id, {
			stream: true,
			resolve(response) {
				fetching = false;
				pendingId = null;
				topic = response.topic || null;

				// Track sequence number for replay
				if (response.seq !== undefined) _lastSeq = response.seq;

				// Track version for delta sync
				if (response.version !== undefined) _lastVersion = response.version;

				// Handle unchanged response (delta sync -- nothing changed)
				if (response.unchanged === true) {
					// Keep current value as-is, just re-subscribe to topic
					initialLoaded = true;
					// Subscribe to live updates on the topic
					if (topic && !topicUnsub) {
						const topicStore = on(topic);
						topicUnsub = topicStore.subscribe((envelope) => {
							if (!envelope) return;
							if (!initialLoaded) {
								buffer.push(envelope);
							} else {
								applyEvent(envelope);
							}
						});
					}
					return;
				}

				// Handle delta response: apply diff events in batch
				if (response.delta === true && Array.isArray(response.data)) {
					for (const item of response.data) {
						if (item._deleted) {
							_applyMerge({ event: 'deleted', data: item });
						} else {
							const exists = _index.has(item[key]);
							_applyMerge({ event: exists ? 'updated' : 'created', data: item });
						}
					}
				} else if (response.replay === true && Array.isArray(response.data)) {
					// Handle replay response: apply missed events in batch
					for (const evt of response.data) {
						_applyMerge(evt);
					}
				} else {
					currentValue = response.data;
				}

				// Use server-provided options when available
				if (response.merge) merge = response.merge;
				if (response.key) key = response.key;
				if (response.prepend !== undefined) prepend = response.prepend;
				if (response.max !== undefined) max = response.max;

				// Rebuild index after data and options are settled
				_rebuildIndex();

				// Track pagination state
				if (response.hasMore !== undefined) _hasMore = response.hasMore;
				if (response.cursor !== undefined) _cursor = response.cursor;

				// Track schema version
				if (response.schemaVersion !== undefined) _schemaVersion = response.schemaVersion;

				initialLoaded = true;
				if (Array.isArray(currentValue)) currentValue = currentValue.slice();
				store.set(currentValue);

				// Subscribe to live updates on the topic
				if (topic && !topicUnsub) {
					const topicStore = on(topic);
					topicUnsub = topicStore.subscribe((envelope) => {
						if (!envelope) return;
						if (!initialLoaded) {
							buffer.push(envelope);
						} else {
							applyEvent(envelope);
						}
					});
				}

				// Replay buffered messages in batch
				if (buffer.length > 0) {
					for (const evt of buffer) {
						_applyMerge(evt);
					}
					if (Array.isArray(currentValue)) currentValue = currentValue.slice();
					store.set(currentValue);
					_recordHistory();
				}
				buffer = [];
			},
			reject(err) {
				fetching = false;
				pendingId = null;
				store.set({ error: err instanceof RpcError ? err : new RpcError('STREAM_ERROR', err?.message || 'Stream failed') });
			},
			timer
		});

		/** @type {any} */
		const request = { rpc: path, id, args: dynamicArgs || [], stream: true };
		if (_lastSeq !== null) request.seq = _lastSeq;
		if (_lastVersion !== undefined) request.version = _lastVersion;
		if (_schemaVersion !== undefined) request.schemaVersion = _schemaVersion;
		conn.sendQueued(request);
	}

	/**
	 * Clean up subscriptions.
	 */
	function cleanup() {
		if (pendingId) {
			const entry = pending.get(pendingId);
			if (entry) {
				pending.delete(pendingId);
				if (entry.timer) clearTimeout(entry.timer);
			}
			pendingId = null;
		}
		if (topicUnsub) {
			topicUnsub();
			topicUnsub = null;
		}
		if (statusUnsub) {
			statusUnsub();
			statusUnsub = null;
		}
		if (_reconnectTimer) {
			clearTimeout(_reconnectTimer);
			_reconnectTimer = null;
		}
		topic = null;
		initialLoaded = false;
		fetching = false;
		buffer = [];
		currentValue = undefined;
		store.set(undefined);
		_index.clear();
		_history = [];
		_historyIndex = -1;
		_devtoolsStream(path, null, 0);
	}

	return {
		subscribe(fn) {
			if (subCount++ === 0) {
				// First subscriber - start the stream
				fetchAndSubscribe();
				_devtoolsStream(path, topic, subCount);

				// Listen for reconnects to refetch (debounced to avoid thundering herd)
				let firstStatus = true;
				statusUnsub = status.subscribe((s) => {
					if (firstStatus) {
						firstStatus = false;
						return;
					}
					if (s === 'open' && subCount > 0) {
						if (_reconnectTimer) clearTimeout(_reconnectTimer);
						_reconnectTimer = setTimeout(() => {
							_reconnectTimer = null;
							// Reconnected - refetch without resetting store (keep stale data visible)
							if (topicUnsub) {
								topicUnsub();
								topicUnsub = null;
							}
							initialLoaded = false;
							fetching = false;
							buffer = [];
							fetchAndSubscribe();
						}, 50 + Math.floor(Math.random() * 150));
					}
				});
			}

			const unsub = store.subscribe(fn);

			return () => {
				unsub();
				if (--subCount === 0) {
					cleanup();
				}
			};
		},

		/**
		 * Apply an optimistic update to the store immediately.
		 * Returns a rollback function that undoes the change.
		 *
		 * @param {string} event - 'created', 'updated', 'deleted' (crud); 'set' (set); 'push' (latest)
		 * @param {any} data - The data to apply
		 * @returns {() => void} Rollback function
		 */
		optimistic(event, data) {
			const snapshot = Array.isArray(currentValue) ? currentValue.slice() : currentValue;

			if (merge === 'crud') {
				if (data && data[key] !== undefined) {
					_optimisticKeys.add(data[key]);
				}
			}

			applyEvent({ event, data });

			return function rollback() {
				if (merge === 'crud' && data && data[key] !== undefined) {
					_optimisticKeys.delete(data[key]);
				}
				currentValue = snapshot;
				_rebuildIndex();
				store.set(currentValue);
			};
		},

		/**
		 * Load the next page of data (cursor-based pagination).
		 * The server must return `{ data, hasMore, cursor }` for this to work.
		 *
		 * @param {...any} extraArgs - Additional arguments passed to the server initFn
		 * @returns {Promise<boolean>} Whether more pages are available after this load
		 */
		async loadMore(...extraArgs) {
			if (_loadingMore || !_hasMore || !_cursor) return false;
			_loadingMore = true;

			ensureListener();
			const id = _idPrefix + (idCounter++).toString(36);
			const conn = _connect();

			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					_loadingMore = false;
					reject(new RpcError('TIMEOUT', `loadMore '${path}' timed out after 30s`));
				}, 30000);

				pending.set(id, {
					stream: true,
					resolve(response) {
						_loadingMore = false;
						if (response.hasMore !== undefined) _hasMore = response.hasMore;
						if (response.cursor !== undefined) _cursor = response.cursor;

						if (Array.isArray(response.data) && Array.isArray(currentValue)) {
							if (prepend) {
								currentValue = response.data.concat(currentValue);
							} else {
								currentValue = currentValue.concat(response.data);
							}
						} else if (response.data !== undefined) {
							currentValue = response.data;
						}

						_rebuildIndex();
						store.set(currentValue);
						resolve(_hasMore);
					},
					reject(err) {
						_loadingMore = false;
						reject(err instanceof RpcError ? err : new RpcError('LOAD_MORE_ERROR', err?.message || 'Load more failed'));
					},
					timer
				});

				conn.sendQueued({
					rpc: path,
					id,
					args: [...(dynamicArgs || []), ...extraArgs],
					stream: true,
					cursor: _cursor
				});
			});
		},

		/**
		 * Whether more pages are available for loading.
		 * @returns {boolean}
		 */
		get hasMore() {
			return _hasMore;
		},

		/**
		 * Pre-populate the stream with SSR data.
		 * On first subscribe, sends the stream RPC to subscribe for live updates
		 * but keeps the SSR data visible (does not reset to undefined).
		 *
		 * @param {any} initialData - Data from the server load function
		 * @returns {{ subscribe: Function, optimistic: Function, hydrate: Function }}
		 */
		hydrate(initialData) {
			currentValue = initialData;
			_rebuildIndex();
			store.set(currentValue);
			_hydrated = true;
			return this;
		},

		/**
		 * Enable history tracking for undo/redo.
		 * @param {number} [maxSize] - Maximum history entries (default 50)
		 */
		enableHistory(maxSize) {
			_historyEnabled = true;
			if (maxSize !== undefined) _historyMax = maxSize;
			// Record current state as the baseline
			if (_history.length === 0 && currentValue !== undefined) {
				const snapshot = Array.isArray(currentValue) ? [...currentValue] : currentValue;
				_history.push(snapshot);
				_historyIndex = 0;
			}
		},

		/**
		 * Undo the last change. Restores the previous snapshot.
		 */
		undo() {
			if (!_historyEnabled) {
				_historyEnabled = true;
				return;
			}
			if (_historyIndex <= 0) return;
			_historyIndex--;
			currentValue = Array.isArray(_history[_historyIndex])
				? [..._history[_historyIndex]]
				: _history[_historyIndex];
			_rebuildIndex();
			store.set(currentValue);
		},

		/**
		 * Redo the last undone change.
		 */
		redo() {
			if (!_historyEnabled) {
				_historyEnabled = true;
				return;
			}
			if (_historyIndex >= _history.length - 1) return;
			_historyIndex++;
			currentValue = Array.isArray(_history[_historyIndex])
				? [..._history[_historyIndex]]
				: _history[_historyIndex];
			_rebuildIndex();
			store.set(currentValue);
		},

		/**
		 * Whether there are entries to undo.
		 * @returns {boolean}
		 */
		get canUndo() {
			return _historyEnabled && _historyIndex > 0;
		},

		/**
		 * Whether there are entries to redo.
		 * @returns {boolean}
		 */
		get canRedo() {
			return _historyEnabled && _historyIndex < _history.length - 1;
		},

		/**
		 * Pause history recording. Events still apply to the store value,
		 * but no snapshots are saved to the undo stack.
		 */
		pauseHistory() {
			_historyPaused = true;
		},

		/**
		 * Resume history recording after a pause.
		 * Records the current value as a snapshot so undo returns to
		 * the state at resume-time rather than before the pause.
		 */
		resumeHistory() {
			if (!_historyPaused) return;
			_historyPaused = false;
			_recordHistory();
		},

		/**
		 * Return a wrapper store that only activates when `condition` is truthy.
		 * When condition becomes falsy, the underlying subscription is cleaned up.
		 *
		 * Accepts a boolean, a Svelte store (object with .subscribe), or a
		 * getter function (() => boolean). Stores and functions are reactive:
		 * the stream subscribes/unsubscribes as the condition changes.
		 *
		 * @param {boolean | { subscribe: Function } | (() => boolean)} condition
		 * @returns {{ subscribe: Function }}
		 */
		when(condition) {
			const self = this;
			let innerUnsub = null;
			let currentVal = undefined;
			/** @type {Set<(v: any) => void>} */
			const subs = new Set();
			let subCount = 0;
			let active = false;
			/** @type {(() => void) | null} */
			let conditionUnsub = null;

			function activate() {
				if (innerUnsub) return;
				active = true;
				innerUnsub = self.subscribe((v) => {
					currentVal = v;
					for (const s of subs) s(currentVal);
				});
			}

			function deactivate() {
				if (!innerUnsub) return;
				active = false;
				innerUnsub();
				innerUnsub = null;
				currentVal = undefined;
				for (const s of subs) s(currentVal);
			}

			function handleCondition(value) {
				if (value && subCount > 0) {
					activate();
				} else if (!value) {
					deactivate();
				}
			}

			// Determine condition type
			const isStore = condition && typeof condition === 'object' && typeof condition.subscribe === 'function';
			const isFn = typeof condition === 'function';

			return {
				subscribe(fn) {
					if (subCount++ === 0) {
						if (isStore) {
							conditionUnsub = condition.subscribe((v) => handleCondition(v));
						} else if (isFn) {
							// Poll the getter on subscribe. For true reactivity with
							// Svelte 5 $state, users should wrap in $derived or pass a store.
							handleCondition(condition());
						} else if (condition) {
							activate();
						}
					}
					subs.add(fn);
					fn(currentVal);

					return () => {
						subs.delete(fn);
						if (--subCount === 0) {
							deactivate();
							if (conditionUnsub) {
								conditionUnsub();
								conditionUnsub = null;
							}
						}
					};
				}
			};
		}
	};
}

/** @type {boolean} */
let batchListenerAttached = false;

/**
 * Attach the __rpc batch response listener once.
 */
function ensureBatchListener() {
	if (batchListenerAttached) return;
	batchListenerAttached = true;

	const store = on('__rpc');
	store.subscribe((envelope) => {
		if (!envelope) return;
		const { event: correlationId, data } = envelope;
		if (correlationId !== '__batch' || !data?.batch) return;

		// Resolve/reject individual promises from the batch
		for (const result of data.batch) {
			const entry = pending.get(result.id);
			if (!entry) continue;
			pending.delete(result.id);
			if (entry.timer) clearTimeout(entry.timer);

			if (result.ok) {
				entry.resolve(result.data);
			} else {
				entry.reject(new RpcError(result.code || 'UNKNOWN', result.error || 'Unknown error'));
			}
		}
	});
}

/**
 * Group multiple RPC calls into a single WebSocket frame.
 * Returns an array of results in the same order as the calls.
 *
 * @param {() => Promise<any>[]} fn - Function that returns an array of RPC call promises
 * @param {{ sequential?: boolean }} [options]
 * @returns {Promise<any[]>}
 */
export function batch(fn, options) {
	ensureListener();
	ensureDisconnectListener();
	ensureBatchListener();

	// Collect RPC calls during fn() execution
	_batchCollector = [];
	/** @type {any} */
	let promises;
	try {
		promises = fn();
	} catch (err) {
		// Clean up collector and any pending entries on synchronous throw
		const collected = _batchCollector;
		_batchCollector = null;
		if (collected) {
			for (const call of collected) {
				const entry = pending.get(call.id);
				if (entry) {
					pending.delete(call.id);
					if (entry.timer) clearTimeout(entry.timer);
				}
			}
		}
		throw err;
	}
	const collected = _batchCollector;
	_batchCollector = null;

	if (collected.length === 0) return Promise.resolve([]);

	// Set a batch-level timeout
	const batchTimer = setTimeout(() => {
		for (const call of collected) {
			const entry = pending.get(call.id);
			if (entry) {
				pending.delete(call.id);
				entry.reject(new RpcError('TIMEOUT', `Batch timed out after 30s`));
			}
		}
	}, 30000);

	// Send all calls as one frame
	const conn = _connect();
	const payload = { batch: collected };
	if (options?.sequential) payload.sequential = true;
	conn.sendQueued(payload);

	// Return promise that resolves when all individual promises resolve
	return Promise.all(promises).finally(() => clearTimeout(batchTimer));
}

/**
 * Dev-mode check for non-serializable arguments.
 * @param {string} path
 * @param {any[]} args
 */
function _checkArgs(path, args) {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const t = typeof arg;
		if (t === 'function' || t === 'symbol' || t === 'bigint' || t === 'undefined') {
			console.warn(
				`[svelte-realtime] RPC '${path}' called with non-JSON-serializable argument at index ${i} (${t}) -- this will be lost during transmission`
			);
		}
	}
}

/**
 * @typedef {{ path: string, args: any[], queuedAt: number, resolve: Function, reject: Function }} OfflineEntry
 */

/** @type {{ onConnect?: () => void, onDisconnect?: () => void, offline?: { queue?: boolean, maxQueue?: number, maxAge?: number, replay?: 'sequential' | 'batch' | ((queue: OfflineEntry[]) => OfflineEntry[]), beforeReplay?: (call: { path: string, args: any[], queuedAt: number }) => boolean, onReplayError?: (call: { path: string, args: any[], queuedAt: number }, error: any) => void } }} */
let _clientConfig = {};

/** @type {boolean} */
let _configListenerAttached = false;

/** @type {OfflineEntry[]} */
const _offlineQueue = [];

/** @type {boolean} */
let _isOffline = false;

/** @type {boolean} */
let _replayingQueue = false;

/**
 * Configure client-side connection hooks and offline queue.
 *
 * @param {{ onConnect?: () => void, onDisconnect?: () => void, offline?: { queue?: boolean, maxQueue?: number, maxAge?: number, replay?: 'sequential' | 'batch' | ((queue: OfflineEntry[]) => OfflineEntry[]), beforeReplay?: (call: { path: string, args: any[], queuedAt: number }) => boolean, onReplayError?: (call: { path: string, args: any[], queuedAt: number }, error: any) => void } }} config
 */
export function configure(config) {
	_clientConfig = config;

	if (!_configListenerAttached) {
		_configListenerAttached = true;
		let isFirst = true;
		status.subscribe((s) => {
			if (isFirst) { isFirst = false; return; }
			if (s === 'open') {
				_isOffline = false;
				if (_clientConfig.onConnect) _clientConfig.onConnect();
				_drainOfflineQueue();
			}
			if (s === 'closed') {
				_isOffline = true;
				if (_clientConfig.onDisconnect) _clientConfig.onDisconnect();
			}
		});
	}
}

/**
 * Drain the offline queue on reconnection.
 */
async function _drainOfflineQueue() {
	if (_offlineQueue.length === 0 || _replayingQueue) return;
	_replayingQueue = true;

	const offlineOpts = _clientConfig.offline;
	const beforeReplay = offlineOpts?.beforeReplay;
	const onReplayError = offlineOpts?.onReplayError;
	const maxAge = offlineOpts?.maxAge || 0;
	const now = Date.now();

	// Filter the queue
	/** @type {OfflineEntry[]} */
	let queue = [];
	for (const entry of _offlineQueue) {
		if (maxAge > 0 && now - entry.queuedAt > maxAge) {
			entry.reject(new RpcError('STALE', 'Offline mutation expired'));
			continue;
		}
		if (beforeReplay) {
			const keep = beforeReplay({ path: entry.path, args: entry.args, queuedAt: entry.queuedAt });
			if (!keep) {
				entry.reject(new RpcError('STALE', 'Offline mutation dropped by beforeReplay filter'));
				continue;
			}
		}
		queue.push(entry);
	}
	_offlineQueue.length = 0;

	// Apply custom filter function
	if (typeof offlineOpts?.replay === 'function') {
		queue = offlineOpts.replay(queue);
	}

	// Replay using the configured strategy
	const strategy = offlineOpts?.replay;
	if ((strategy === 'concurrent' || strategy === 'batch') && queue.length > 0) {
		// Concurrent strategy: send queued calls with concurrency limit to avoid flooding
		const concurrency = 10;
		for (let i = 0; i < queue.length; i += concurrency) {
			const chunk = queue.slice(i, i + concurrency);
			const promises = chunk.map(entry => {
				const promise = _sendRpc(entry.path, entry.args);
				promise.then(
					(result) => entry.resolve(result),
					(err) => {
						if (onReplayError) {
							onReplayError({ path: entry.path, args: entry.args, queuedAt: entry.queuedAt }, err);
						}
						entry.reject(err);
					}
				);
				return promise.catch(() => {}); // swallow for Promise.all
			});
			await Promise.all(promises);
		}
	} else {
		// Sequential strategy (default)
		for (const entry of queue) {
			try {
				const result = await _sendRpc(entry.path, entry.args);
				entry.resolve(result);
			} catch (err) {
				if (onReplayError) {
					onReplayError({ path: entry.path, args: entry.args, queuedAt: entry.queuedAt }, err);
				}
				entry.reject(err);
			}
		}
	}

	_replayingQueue = false;
}

/**
 * Combine multiple stores into a single derived store.
 * The combining function receives the current value of each source store
 * and returns the combined value. When any source updates, the function re-runs.
 *
 * @param {...any} args - Source stores followed by a combining function as the last argument
 * @returns {import('svelte/store').Readable<any>}
 */
export function combine(...args) {
	const fn = args.pop();
	const sources = args;

	if (typeof fn !== 'function') {
		throw new Error('combine() requires a combining function as the last argument');
	}
	if (sources.length < 2) {
		throw new Error('combine() requires at least 2 source stores');
	}

	const values = new Array(sources.length);
	let subCount = 0;
	/** @type {Set<(v: any) => void>} */
	const subscribers = new Set();
	/** @type {Array<() => void>} */
	let sourceUnsubs = [];
	let currentValue;

	function notify() {
		const next = fn(...values);
		if (next === currentValue) return;
		currentValue = next;
		for (const sub of subscribers) sub(currentValue);
	}

	function startSources() {
		let initializing = true;
		sourceUnsubs = sources.map((source, i) => {
			return source.subscribe((v) => {
				values[i] = v;
				if (!initializing) {
					notify();
				}
			});
		});
		initializing = false;
		// Compute once after all sources have emitted their initial values
		currentValue = fn(...values);
	}

	function stopSources() {
		for (const unsub of sourceUnsubs) unsub();
		sourceUnsubs = [];
	}

	return {
		subscribe(sub) {
			if (subCount++ === 0) {
				startSources();
			}
			subscribers.add(sub);
			sub(currentValue);

			return () => {
				subscribers.delete(sub);
				if (--subCount === 0) {
					stopSources();
				}
			};
		}
	};
}

/**
 * Register a handler for point-to-point signals.
 * Signals are sent by `ctx.signal(userId, event, data)` on the server.
 *
 * The userId must match the one used by `enableSignals()` on the server,
 * because the server publishes to `__signal:${userId}`.
 *
 * @param {string} userId - The current user's id (must match server-side enableSignals)
 * @param {(event: string, data: any) => void} callback
 * @returns {() => void} Unsubscribe function
 */
export function onSignal(userId, callback) {
	// Support legacy call signature: onSignal(callback)
	if (typeof userId === 'function' && callback === undefined) {
		callback = /** @type {(event: string, data: any) => void} */ (/** @type {unknown} */ (userId));
		userId = '';
	}
	const topic = userId ? ('__signal:' + userId) : '__signal';
	const store = on(topic);
	return store.subscribe((envelope) => {
		if (!envelope) return;
		callback(envelope.event, envelope.data);
	});
}

// -- DevTools instrumentation (dev-mode only) ---------------------------------

/** @type {{ history: any[], streams: Map<string, any>, pending: Map<string, any> } | null} */
export const __devtools = (typeof import.meta !== 'undefined' && import.meta.env?.DEV)
	? { history: [], streams: new Map(), pending: new Map() }
	: null;

/**
 * Record an RPC call start for devtools.
 * @param {string} path
 * @param {string} id
 * @param {any[]} args
 */
function _devtoolsStart(path, id, args) {
	if (!__devtools) return;
	__devtools.pending.set(id, { path, args, startTime: Date.now() });
}

/**
 * Record an RPC call completion for devtools.
 * @param {string} id
 * @param {boolean} ok
 * @param {any} result
 */
function _devtoolsEnd(id, ok, result) {
	if (!__devtools) return;
	const entry = __devtools.pending.get(id);
	if (!entry) return;
	__devtools.pending.delete(id);
	const record = {
		path: entry.path,
		args: entry.args,
		ok,
		result,
		duration: Date.now() - entry.startTime,
		time: Date.now()
	};
	__devtools.history.push(record);
	if (__devtools.history.length > 50) __devtools.history.shift();
}

/**
 * Track an active stream for devtools.
 * @param {string} path
 * @param {string | null} topic
 * @param {number} subCount
 */
function _devtoolsStream(path, topic, subCount) {
	if (!__devtools) return;
	if (subCount <= 0) {
		__devtools.streams.delete(path);
	} else {
		__devtools.streams.set(path, { path, topic, subCount });
	}
}
