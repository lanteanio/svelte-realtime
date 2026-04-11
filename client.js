// @ts-check
import { connect as _connect, on, status } from 'svelte-adapter-uws/client';
import { writable, readable } from 'svelte/store';

/** @type {import('svelte/store').Readable<undefined>} */
export const empty = readable(undefined);

const _textEncoder = new TextEncoder();

/** Pre-allocated binary frame buffer for reuse across sequential binary RPC calls */
let _binaryFrameBuffer = /** @type {Uint8Array | null} */ (null);
let _binaryFrameSize = 0;

/**
 * Get a reusable binary frame buffer of at least `size` bytes.
 * Grows by 2x to avoid frequent reallocation.
 * @param {number} size
 * @returns {Uint8Array}
 */
function _getBinaryFrame(size) {
	if (!_binaryFrameBuffer || _binaryFrameSize < size) {
		_binaryFrameSize = Math.max(size, (_binaryFrameSize || 1024) * 2);
		_binaryFrameBuffer = new Uint8Array(_binaryFrameSize);
	}
	return _binaryFrameBuffer;
}

/**
 * RAF-based event batching for high-frequency streams (cursors, presence).
 * In the browser, incoming pub/sub events are queued and flushed once per
 * animation frame, reducing Svelte reactive updates from N-per-event to
 * 1-per-frame. In Node/SSR, events apply synchronously (no DOM to protect).
 */
const _useRAF = typeof window !== 'undefined' && typeof requestAnimationFrame === 'function';

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

/** Generate a unique correlation ID, wrapping the counter before exceeding safe integer range */
function _nextId() {
	if (idCounter >= 0x1FFFFFFFFFFFFF) idCounter = 0;
	return _idPrefix + (idCounter++).toString(36);
}

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

/** Terminal close codes that indicate a permanently-dead connection (no retry) */
const _TERMINAL_CODES = new Set([1008, 4401, 4403]);

const _DEFAULT_TIMEOUT = 30000;

/** @returns {number} Configured or default RPC timeout in ms */
function _getTimeout() {
	return _clientConfig.timeout || _DEFAULT_TIMEOUT;
}

/** @type {boolean} Whether the connection is permanently dead (terminal close code, exhausted retries, or explicit close) */
let _terminated = false;

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

		// Batch response
		if (correlationId === '__batch' && data?.batch) {
			for (const result of data.batch) {
				const entry = pending.get(result.id);
				if (!entry) continue;
				pending.delete(result.id);
				if (entry.timer) clearTimeout(entry.timer);
				if (result.ok) {
					entry.resolve(entry.stream ? result : result.data);
				} else {
					entry.reject(new RpcError(result.code || 'UNKNOWN', result.error || 'Unknown error'));
				}
			}
			return;
		}

		// Single response
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
			const code = s === 'closed' ? 'DISCONNECTED' : 'CONNECTION_CLOSED';
			for (const [id, entry] of pending) {
				pending.delete(id);
				if (entry.timer) clearTimeout(entry.timer);
				entry.reject(new RpcError(code, 'WebSocket connection lost'));
			}
		}
		if (s === 'open') {
			_terminated = false;
		}
	});

	// Listen for terminal close via ready() rejection (adapter 0.4.0)
	if (typeof _connect === 'function') {
		try {
			const conn = _connect();
			if (conn && typeof conn.ready === 'function') {
				conn.ready().catch((/** @type {any} */ err) => {
					_terminated = true;
					const errCode = err?.code || 'CONNECTION_CLOSED';
					const errMsg = err?.message || 'Connection permanently closed';
					// Reject all pending RPCs
					for (const [id, entry] of pending) {
						pending.delete(id);
						if (entry.timer) clearTimeout(entry.timer);
						entry.reject(new RpcError(errCode, errMsg));
					}
					// Drain offline queue with errors
					for (const entry of _offlineQueue) {
						entry.reject(new RpcError(errCode, errMsg));
					}
					_offlineQueue.length = 0;
				});
			}
		} catch {
			// _connect may not be callable yet (SSR) -- that's fine
		}
	}
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
		if (a === null) return path + '\0N';
		if (a === undefined) return path + '\0U';
		const t = typeof a;
		if (t === 'string') return path + '\0S' + a;
		if (t === 'number') return path + '\0#' + a;
		if (t === 'boolean') return path + '\0B' + a;
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

	// Fast-fail if connection is permanently dead
	if (_terminated) {
		return Promise.reject(new RpcError('CONNECTION_CLOSED', 'Connection permanently closed'));
	}

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

	const id = _nextId();

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
		const _startTime = Date.now();
		const timer = setTimeout(() => {
			if (Date.now() - _startTime > 90000) {
				// Device was sleeping. Clean up the pending entry so it doesn't hang
				// forever — the disconnect listener or reconnect will handle the actual error.
				pending.delete(id);
				_devtoolsEnd(id, false, 'SLEEP_TIMEOUT');
				reject(new RpcError('DISCONNECTED', 'Connection interrupted (device sleep)'));
				return;
			}
			pending.delete(id);
			_devtoolsEnd(id, false, 'TIMEOUT');
			reject(new RpcError('TIMEOUT', `RPC '${path}' timed out after 30s`));
		}, _getTimeout());

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
		if (_terminated) {
			return Promise.reject(new RpcError('CONNECTION_CLOSED', 'Connection permanently closed'));
		}
		ensureListener();
		ensureDisconnectListener();

		const id = _nextId();

		_devtoolsStart(path, id, args);
		const conn = _connect();

		return new Promise((resolve, reject) => {
			const _startTime = Date.now();
			const timer = setTimeout(() => {
				if (Date.now() - _startTime > 90000) {
					pending.delete(id);
					_devtoolsEnd(id, false, 'SLEEP_TIMEOUT');
					reject(new RpcError('DISCONNECTED', 'Connection interrupted (device sleep)'));
					return;
				}
				pending.delete(id);
				_devtoolsEnd(id, false, 'TIMEOUT');
				reject(new RpcError('TIMEOUT', `Binary RPC '${path}' timed out after 30s`));
			}, _getTimeout());

			pending.set(id, {
				resolve(v) { _devtoolsEnd(id, true, v); resolve(v); },
				reject(e) { _devtoolsEnd(id, false, e); reject(e); },
				timer
			});

			// Wire format: byte[0] = 0x00, byte[1-2] = header length (uint16 BE), then JSON header, then binary payload
			const header = JSON.stringify({ rpc: path, id, args: args.length > 0 ? args : undefined });
			const headerBytes = _textEncoder.encode(header);
			if (headerBytes.length > 0xFFFF) {
				pending.delete(id);
				clearTimeout(timer);
				reject(new RpcError('PAYLOAD_TOO_LARGE', 'Binary RPC header exceeds 65535 bytes'));
				return;
			}
			const bufBytes = ArrayBuffer.isView(buffer)
				? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
				: new Uint8Array(buffer);
			const size = 3 + headerBytes.length + bufBytes.length;
			const frame = _getBinaryFrame(size);
			frame[0] = 0x00;
			frame[1] = (headerBytes.length >> 8) & 0xFF;
			frame[2] = headerBytes.length & 0xFF;
			frame.set(headerBytes, 3);
			frame.set(bufBytes, 3 + headerBytes.length);

			// Send a view of exactly the right size (frame may be oversized from reuse)
			conn.sendQueued(frame.buffer.slice(0, size));
		});
	};
}

/**
 * Microtask-batched stream subscribe RPCs.
 * Collects all subscribe RPCs within a single microtask and sends them as one batch frame.
 * @type {Array<any> | null}
 */
let _subscribeBatch = null;

/**
 * Queue a stream subscribe RPC to be sent in a batch within the current microtask.
 * If only one request queues, it's sent as a single frame (no batch overhead).
 * @param {any} request - The subscribe RPC request object
 */
function _batchedSubscribe(request) {
	if (!_subscribeBatch) {
		_subscribeBatch = [];
		queueMicrotask(() => {
			const batch = _subscribeBatch;
			_subscribeBatch = null;
			if (!batch || batch.length === 0) return;
			const conn = _connect();
			if (batch.length === 1) {
				conn.sendQueued(batch[0]);
			} else {
				conn.sendQueued({ batch });
			}
		});
	}
	_subscribeBatch.push(request);
}

/** @type {Map<string, { store: any, refCount: number }>} */
const _streamCache = new Map();

/** Hard cap on cached stream instances to prevent memory exhaustion */
const _STREAM_CACHE_MAX = 1000;

/** Overflow dedupe for currently-live stores that couldn't fit in the main cache */
const _streamOverflow = new Map();

/** Set of cache keys with zero refCount, for O(1) eviction instead of full scan */
const _evictable = new Set();

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

			// Check overflow dedupe for active stores that didn't fit in the main cache
			const overflow = _streamOverflow.get(cacheKey);
			if (overflow) return overflow.store;

			const store = _createStream(path, options, args);
			const rawSubscribe = store.subscribe.bind(store);

			if (_streamCache.size >= _STREAM_CACHE_MAX) {
				for (const k of _evictable) {
					_streamCache.delete(k);
					_evictable.delete(k);
					if (_streamCache.size < _STREAM_CACHE_MAX) break;
				}
			}

			if (_streamCache.size < _STREAM_CACHE_MAX) {
				_streamCache.set(cacheKey, { store, refCount: 0 });
				_evictable.add(cacheKey);
			} else {
				if (_streamOverflow.size >= _STREAM_CACHE_MAX) {
					for (const [k, e] of _streamOverflow) {
						if (e.refCount <= 0) { _streamOverflow.delete(k); break; }
					}
				}
				_streamOverflow.set(cacheKey, { store, refCount: 0 });
			}

			store.subscribe = function cachedSubscribe(fn) {
				const mainEntry = _streamCache.get(cacheKey);
				if (mainEntry && mainEntry.store === store) {
					mainEntry.refCount++;
					_evictable.delete(cacheKey);
				}
				const overflowEntry = _streamOverflow.get(cacheKey);
				if (overflowEntry && overflowEntry.store === store) overflowEntry.refCount++;

				const unsub = rawSubscribe(fn);
				return () => {
					unsub();
					const mainEntry = _streamCache.get(cacheKey);
					if (mainEntry && mainEntry.store === store && --mainEntry.refCount <= 0) {
						_evictable.add(cacheKey);
					}
					const overflowEntry = _streamOverflow.get(cacheKey);
					if (overflowEntry && overflowEntry.store === store && --overflowEntry.refCount <= 0) {
						_streamOverflow.delete(cacheKey);
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
	let max = options?.max || (merge === 'latest' ? 50 : 0);

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

	/** @type {number} Consecutive reconnect attempts (reset on successful fetch) */
	let _reconnectAttempts = 0;

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
		// Skip history for large arrays (> 200 items) to avoid excessive memory
		if (Array.isArray(currentValue) && currentValue.length > 200) return;
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
	/** @type {boolean} Whether _applyMerge has changed currentValue since last flush */
	let _dirty = false;

	function _applyMerge(envelope) {
		const { event, data } = envelope;

		if (envelope.seq !== undefined) _lastSeq = envelope.seq;
		_dirty = true;

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
					if (max && currentValue.length > max) {
						const removed = currentValue.splice(max);
						for (const item of removed) _index.delete(item[key]);
					}
				} else {
					_index.set(data[key], currentValue.length);
					currentValue.push(data);
					if (max && currentValue.length > max) {
						const removed = currentValue.splice(0, currentValue.length - max);
						for (const item of removed) _index.delete(item[key]);
						_rebuildIndex();
					}
				}
			} else if (event === 'updated') {
				const idx = _index.get(data[key]);
				if (idx !== undefined) currentValue[idx] = data;
			} else if (event === 'deleted') {
				const idx = _index.get(data[key]);
				if (idx !== undefined) {
					_index.delete(data[key]);
					const last = currentValue.length - 1;
					if (idx < last) {
						const swapped = currentValue[last];
						currentValue[idx] = swapped;
						_index.set(swapped[key], idx);
					}
					currentValue.length = last;
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
					_index.delete(data.key);
					const last = currentValue.length - 1;
					if (idx < last) {
						const swapped = currentValue[last];
						currentValue[idx] = swapped;
						_index.set(swapped.key, idx);
					}
					currentValue.length = last;
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
					_index.delete(data.key);
					const last = currentValue.length - 1;
					if (idx < last) {
						const swapped = currentValue[last];
						currentValue[idx] = swapped;
						_index.set(swapped.key, idx);
					}
					currentValue.length = last;
				}
			} else if (event === 'set') {
				currentValue = data;
				_rebuildIndex();
				return true;
			}
			return false;
		} else if (merge === 'set') {
			if (data === currentValue) { _dirty = false; return true; }
			currentValue = data;
			return true;
		}
		return false;
	}

	/** Double-buffer swap pattern: two pre-allocated arrays reused every frame */
	let _bufA = [];
	let _bufB = [];
	let _activeBuf = _bufA;

	/** @type {number | null} */
	let _rafId = null;

	/** Idempotent events where the latest value per key wins (safe to dedup) */
	const _IDEMPOTENT = new Set(['updated', 'update', 'join']);

	/**
	 * Flush all queued events in a single batch, then update the store once.
	 * Uses double-buffer swap to avoid allocating new arrays per frame.
	 * Deduplicates idempotent events by entity key within a single frame.
	 */
	function _flushEvents() {
		_rafId = null;
		const queue = _activeBuf;
		_activeBuf = _activeBuf === _bufA ? _bufB : _bufA;
		if (queue.length === 0) return;

		// RAF dedup: for keyed merge strategies, keep only the last idempotent event per key
		if (queue.length > 1 && merge !== 'set' && merge !== 'latest') {
			const keyField = (merge === 'presence' || merge === 'cursor') ? 'key' : key;
			const seen = new Map();
			for (let i = queue.length - 1; i >= 0; i--) {
				if (!_IDEMPOTENT.has(queue[i].event)) continue;
				const k = queue[i].data?.[keyField];
				if (k !== undefined) {
					if (seen.has(k)) {
						queue[i] = null;
					} else {
						seen.set(k, true);
					}
				}
			}
			for (let i = 0; i < queue.length; i++) {
				if (queue[i] !== null) _applyMerge(queue[i]);
			}
		} else {
			for (let i = 0; i < queue.length; i++) {
				_applyMerge(queue[i]);
			}
		}

		queue.length = 0; // Reuse the array, don't allocate a new one
		if (!_dirty) return;
		_dirty = false;
		if (Array.isArray(currentValue)) currentValue = currentValue.slice();
		store.set(currentValue);
		_recordHistory();
	}

	/**
	 * Apply a pub/sub event to the store. In the browser, events are queued
	 * and flushed once per animation frame to reduce reactive updates from
	 * N-per-event to 1-per-frame. In Node/SSR, events apply immediately.
	 *
	 * Handles replay end markers from adapter 0.4.0 extensions:
	 * - `{ reqId }` signals replay complete (no action needed)
	 * - `{ reqId, truncated: true }` signals a cache miss; triggers full refetch
	 * @param {{ event: string, data: any }} envelope
	 */
	function applyEvent(envelope) {
		// Replay end marker (adapter 0.4.0 extensions): object with reqId
		if (envelope.data && typeof envelope.data === 'object' && envelope.data.reqId !== undefined) {
			if (envelope.data.truncated === true) {
				// Cache miss — trigger a full refetch (reset seq so we get full data)
				_lastSeq = null;
				if (topicUnsub) { topicUnsub(); topicUnsub = null; }
				initialLoaded = false;
				fetching = false;
				buffer = [];
				fetchAndSubscribe();
			}
			// Non-truncated end marker — replay complete, nothing to do
			return;
		}

		if (_useRAF) {
			_activeBuf.push(envelope);
			if (_rafId === null) {
				_rafId = requestAnimationFrame(_flushEvents);
			}
		} else {
			const replaced = _applyMerge(envelope);
			if (!replaced && Array.isArray(currentValue)) currentValue = currentValue.slice();
			store.set(currentValue);
			_recordHistory();
		}
	}

	/**
	 * Fetch initial data and subscribe to live updates.
	 */
	function fetchAndSubscribe() {
		if (fetching) return;
		if (_terminated) {
			store.set({ error: new RpcError('CONNECTION_CLOSED', 'Connection permanently closed') });
			return;
		}
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

		const id = _nextId();
		pendingId = id;
		const conn = _connect();

		const _startTime = Date.now();
		const timer = setTimeout(() => {
			if (Date.now() - _startTime > 90000) {
				pending.delete(id);
				pendingId = null;
				fetching = false;
				store.set({ error: new RpcError('DISCONNECTED', 'Connection interrupted (device sleep)') });
				return;
			}
			pending.delete(id);
			pendingId = null;
			fetching = false;
			store.set({ error: new RpcError('TIMEOUT', `Stream '${path}' timed out after 30s`) });
		}, _getTimeout());

		pending.set(id, {
			stream: true,
			resolve(response) {
				fetching = false;
				pendingId = null;
				_reconnectAttempts = 0;
				topic = response.topic || null;

				// Track sequence number for replay
				if (response.seq !== undefined) _lastSeq = response.seq;

				// Track version for delta sync
				if (response.version !== undefined) _lastVersion = response.version;

				// Install server-provided options BEFORE applying diffs/replay,
				// so _applyMerge uses the correct merge strategy and key field.
				if (response.merge) merge = response.merge;
				if (response.key) key = response.key;
				if (response.prepend !== undefined) prepend = response.prepend;
				if (response.max !== undefined) max = response.max;

				// Handle unchanged response (delta sync -- nothing changed)
				if (response.unchanged === true) {
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
					initialLoaded = true;
					// Drain anything buffered between listener attach and now
					if (buffer.length > 0) {
						for (const evt of buffer) _applyMerge(evt);
						if (Array.isArray(currentValue)) currentValue = currentValue.slice();
						store.set(currentValue);
						buffer = [];
					}
					return;
				}

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
					for (const evt of response.data) {
						_applyMerge(evt);
					}
				} else if (response.channel && currentValue !== undefined) {
					// Channel fast-path returns an empty placeholder (null or []).
					// Keep the existing value (hydrated SSR data or previously
					// accumulated events) so the store never flashes to empty.
				} else {
					currentValue = response.data;
				}

				_rebuildIndex();

				if (response.hasMore !== undefined) _hasMore = response.hasMore;
				if (response.cursor !== undefined) _cursor = response.cursor;
				if (response.schemaVersion !== undefined) _schemaVersion = response.schemaVersion;

				// Attach topic listener BEFORE flipping initialLoaded, so events
				// arriving between ws.subscribe(topic) (server-side) and now are buffered.
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

				initialLoaded = true;
				if (Array.isArray(currentValue)) currentValue = currentValue.slice();
				store.set(currentValue);
				_recordHistory();

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
		_batchedSubscribe(request);
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
		if (_rafId !== null) {
			cancelAnimationFrame(_rafId);
			_rafId = null;
		}
		_bufA.length = 0;
		_bufB.length = 0;
		_activeBuf = _bufA;
		topic = null;
		initialLoaded = false;
		fetching = false;
		buffer = [];
		currentValue = undefined;
		store.set(undefined);
		_index.clear();
		_history = [];
		_historyIndex = -1;
		_reconnectAttempts = 0;
		_devtoolsStream(path, null, 0);
	}

	/** @type {boolean} Whether a deferred cleanup is pending (prevents thrashing on rapid unsub+resub) */
	let _pendingCleanup = false;

	return {
		subscribe(fn) {
			if (subCount++ === 0) {
				if (_pendingCleanup) {
					// Rapid resub — cancel the pending cleanup, subscription is still alive
					_pendingCleanup = false;
				} else {
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
						let delay;
						if (_reconnectAttempts < 2) {
							delay = 20 + Math.floor(Math.random() * 80);
						} else {
							const base = Math.min(1000 * Math.pow(2.2, _reconnectAttempts - 2), 300000);
							delay = Math.floor(base * (0.75 + Math.random() * 0.5));
						}
						_reconnectAttempts++;
						_reconnectTimer = setTimeout(() => {
							_reconnectTimer = null;
							if (topicUnsub) {
								topicUnsub();
								topicUnsub = null;
							}
							initialLoaded = false;
							fetching = false;
							buffer = [];
							fetchAndSubscribe();
						}, delay);
					}
				});

				// Surface terminal close as an error on the stream (adapter 0.4.0)
				try {
					const conn = _connect();
					if (conn && typeof conn.ready === 'function') {
						conn.ready().catch((/** @type {any} */ err) => {
							if (subCount > 0) {
								store.set({ error: new RpcError(err?.code || 'CONNECTION_CLOSED', err?.message || 'Connection permanently closed') });
							}
						});
					}
				} catch {}

			} // end else (not _pendingCleanup)
			}

			const unsub = store.subscribe(fn);

			return () => {
				unsub();
				if (--subCount === 0) {
					_pendingCleanup = true;
					queueMicrotask(() => {
						if (_pendingCleanup && subCount === 0) {
							_pendingCleanup = false;
							cleanup();
						}
					});
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
			if (_terminated) {
				throw new RpcError('CONNECTION_CLOSED', 'Connection permanently closed');
			}
			_loadingMore = true;

			ensureListener();
			const id = _nextId();
			const conn = _connect();

			return new Promise((resolve, reject) => {
				const _startTime = Date.now();
				const timer = setTimeout(() => {
					if (Date.now() - _startTime > 90000) {
						pending.delete(id);
						_loadingMore = false;
						reject(new RpcError('DISCONNECTED', 'Connection interrupted (device sleep)'));
						return;
					}
					pending.delete(id);
					_loadingMore = false;
					reject(new RpcError('TIMEOUT', `loadMore '${path}' timed out after 30s`));
				}, _getTimeout());

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
				// Record baseline snapshot (same as enableHistory)
				if (_history.length === 0 && currentValue !== undefined) {
					const snapshot = Array.isArray(currentValue) ? [...currentValue] : currentValue;
					_history.push(snapshot);
					_historyIndex = 0;
				}
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
				// Record baseline snapshot (same as enableHistory)
				if (_history.length === 0 && currentValue !== undefined) {
					const snapshot = Array.isArray(currentValue) ? [...currentValue] : currentValue;
					_history.push(snapshot);
					_historyIndex = 0;
				}
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

/**
 * Group multiple RPC calls into a single WebSocket frame.
 * Returns an array of results in the same order as the calls.
 *
 * @param {() => Promise<any>[]} fn - Function that returns an array of RPC call promises
 * @param {{ sequential?: boolean }} [options]
 * @returns {Promise<any[]>}
 */
export function batch(fn, options) {
	if (_terminated) {
		return Promise.reject(new RpcError('CONNECTION_CLOSED', 'Connection permanently closed'));
	}
	ensureListener();
	ensureDisconnectListener();

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

	if (collected.length > 50) {
		for (const call of collected) {
			const entry = pending.get(call.id);
			if (entry) {
				pending.delete(call.id);
				if (entry.timer) clearTimeout(entry.timer);
				entry.reject(new RpcError('INVALID_REQUEST', 'Batch exceeds maximum of 50 calls'));
			}
		}
		return Promise.reject(new RpcError('INVALID_REQUEST', 'Batch exceeds maximum of 50 calls'));
	}

	// Set a batch-level timeout (sleep-aware)
	const _batchStartTime = Date.now();
	const batchTimer = setTimeout(() => {
		if (Date.now() - _batchStartTime > 90000) {
			for (const call of collected) {
				const entry = pending.get(call.id);
				if (entry) {
					pending.delete(call.id);
					entry.reject(new RpcError('DISCONNECTED', 'Connection interrupted (device sleep)'));
				}
			}
			return;
		}
		for (const call of collected) {
			const entry = pending.get(call.id);
			if (entry) {
				pending.delete(call.id);
				entry.reject(new RpcError('TIMEOUT', `Batch timed out after 30s`));
			}
		}
	}, _getTimeout());

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
				`[svelte-realtime] RPC '${path}' called with non-JSON-serializable argument at index ${i} (${t}) -- this will be lost during transmission\n  See: https://svti.me/rpc`
			);
		}
	}
}

/**
 * @typedef {{ path: string, args: any[], queuedAt: number, resolve: Function, reject: Function }} OfflineEntry
 */

/** @type {{ url?: string, onConnect?: () => void, onDisconnect?: () => void, timeout?: number, offline?: { queue?: boolean, maxQueue?: number, maxAge?: number, replay?: 'sequential' | 'batch' | ((queue: OfflineEntry[]) => OfflineEntry[]), beforeReplay?: (call: { path: string, args: any[], queuedAt: number }) => boolean, onReplayError?: (call: { path: string, args: any[], queuedAt: number }, error: any) => void } }} */
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
 * @param {{ url?: string, onConnect?: () => void, onDisconnect?: () => void, offline?: { queue?: boolean, maxQueue?: number, maxAge?: number, replay?: 'sequential' | 'batch' | ((queue: OfflineEntry[]) => OfflineEntry[]), beforeReplay?: (call: { path: string, args: any[], queuedAt: number }) => boolean, onReplayError?: (call: { path: string, args: any[], queuedAt: number }, error: any) => void } }} config
 */
export function configure(config) {
	_clientConfig = config;

	if (config.url) {
		_connect({ url: config.url });
	}

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
		throw new Error('combine() requires a combining function as the last argument\n  See: https://svti.me/client');
	}
	if (sources.length < 2) {
		throw new Error('combine() requires at least 2 source stores\n  See: https://svti.me/client');
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
	? { history: new Array(50).fill(null), streams: new Map(), pending: new Map() }
	: null;

/** Ring buffer index for devtools history (O(1) insertion, no array.shift) */
let _devtoolsHistoryIdx = 0;
let _devtoolsSeq = 0;
const _DEVTOOLS_HISTORY_MAX = 50;

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
		time: Date.now(),
		seq: ++_devtoolsSeq
	};
	__devtools.history[_devtoolsHistoryIdx] = record;
	_devtoolsHistoryIdx = (_devtoolsHistoryIdx + 1) % _DEVTOOLS_HISTORY_MAX;
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

/**
 * Re-export `onDerived` from the adapter client.
 * Provides a reactive derived topic subscription that auto-switches when a
 * source store changes. More lightweight than dynamic streams for cases where
 * you just want raw topic events keyed to a store value.
 */
export { onDerived } from 'svelte-adapter-uws/client';
