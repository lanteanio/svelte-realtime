// @ts-check

const textDecoder = new TextDecoder();
const _validPathRe = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)+$/;
const _validSegmentRe = /^[a-zA-Z0-9_]+$/;

/** @type {Map<string, Function>} */
const registry = new Map();

/** @type {Map<string, Function>} */
const guards = new Map();

/** @type {Set<Function>} Streams with onUnsubscribe hooks (for iterating static matches in close) */
const _streamsWithUnsubscribe = new Set();

/**
 * Tag a topic function with __topicUsesCtx by inspecting its first parameter name.
 *
 * Auto-detects only named ctx params: ctx, context, _ctx → __topicUsesCtx = true.
 * Everything else is left unset, falling back to fn.length in _callTopicFn.
 *
 * If fn.length is wrong (defaults, destructuring with defaults), the user must
 * opt in explicitly by setting fn.__topicUsesCtx = true before registering.
 * live.room already does this for its topic function.
 *
 * @param {Function} fn
 */
function _tagTopicFn(fn) {
	try {
		const src = fn.toString();
		// Bare arrow: ctx => ... or context => ...
		const arrow = src.match(/^\s*([\w$]+)\s*=>/);
		if (arrow) {
			const name = arrow[1];
			if (name === 'ctx' || name === 'context' || name === '_ctx') {
				/** @type {any} */ (fn).__topicUsesCtx = true;
			}
			return;
		}
		// Parenthesized: extract first token inside (...)
		const paren = src.match(/\(\s*([\w$]+)/);
		if (paren) {
			const name = paren[1];
			if (name === 'ctx' || name === 'context' || name === '_ctx') {
				/** @type {any} */ (fn).__topicUsesCtx = true;
			}
		}
		// Destructured, rest, empty, or unrecognized → leave unset
	} catch {}
}

/**
 * Call a topic factory function, deciding whether to inject ctx.
 *
 * If __topicUsesCtx was set by _tagTopicFn or explicitly, honor it.
 * Otherwise fall back to fn.length vs args.length heuristic.
 *
 * @param {Function} fn
 * @param {any} ctx
 * @param {any[]} args
 * @returns {any}
 */
function _callTopicFn(fn, ctx, args) {
	let result;
	if (fn.__topicUsesCtx === true) result = fn(ctx, ...args);
	else if (fn.__topicUsesCtx === false) result = fn(...args);
	else {
		result = fn.length <= args.length ? fn(...args) : fn(ctx, ...args);
	}
	if (typeof result !== 'string') {
		throw new LiveError('INVALID_REQUEST',
			'Topic function must return a string, got ' + (result && typeof result === 'object' && typeof result.then === 'function' ? 'Promise (topic functions must not be async)' : typeof result)
		);
	}
	return result;
}

/**
 * Per-socket stream ownership. Maps ws -> topic -> [{fn, count}].
 * Each entry tracks a logical stream subscription with its hook function and refcount.
 * Used for gauge tracking, onUnsubscribe dispatch, and rollback.
 * @type {WeakMap<object, Map<string, Array<{fn: Function, count: number}>>>}
 */
const _wsStreamOwners = new WeakMap();

/** @type {Array<(ctx: any, next: () => Promise<any>) => Promise<any>>} */
const _globalMiddleware = [];

/**
 * Copy stream metadata from a source function to a wrapper.
 * Single source of truth for all metadata properties -- add new fields here.
 * @param {any} target
 * @param {any} source
 */
function _copyStreamMeta(target, source) {
	target.__isStream = source.__isStream;
	target.__isLive = source.__isLive;
	target.__streamTopic = source.__streamTopic;
	target.__streamOptions = source.__streamOptions;
	if (source.__replay) target.__replay = source.__replay;
	if (source.__delta) target.__delta = source.__delta;
	if (source.__onSubscribe) target.__onSubscribe = source.__onSubscribe;
	if (source.__onUnsubscribe) target.__onUnsubscribe = source.__onUnsubscribe;
	if (source.__streamFilter) target.__streamFilter = source.__streamFilter;
	if (source.__streamArgs) target.__streamArgs = source.__streamArgs;
	if (source.__streamTransform) target.__streamTransform = source.__streamTransform;
	if (source.__streamVersion !== undefined) target.__streamVersion = source.__streamVersion;
	if (source.__streamMigrate) target.__streamMigrate = source.__streamMigrate;
	if (source.__isChannel) target.__isChannel = source.__isChannel;
	if (source.__isDerived) target.__isDerived = source.__isDerived;
	if (source.__derivedDynamic) {
		target.__derivedDynamic = source.__derivedDynamic;
		target.__derivedSourceFactory = source.__derivedSourceFactory;
		target.__derivedTopicArgs = source.__derivedTopicArgs;
		target.__derivedDebounce = source.__derivedDebounce;
	}
	if (source.__derivedSources) target.__derivedSources = source.__derivedSources;
	if (source.__isGated) {
		target.__isGated = true;
		target.__gatePredicate = source.__gatePredicate;
	}
}

/**
 * Per-topic coalesce registry. When a stream registered with `coalesceBy`
 * is subscribed, its topic is recorded here along with the live set of
 * subscriber sockets. The publish helper uses this to decide between
 * `platform.publish` (default broadcast) and per-socket
 * `platform.sendCoalesced` fan-out.
 *
 * Hot-path cost on the default (no-coalesce) branch: one Map.get on an
 * almost-always-empty map. See bench/publish.js for numbers.
 *
 * @type {Map<string, { coalesceBy: Function, ws: Set<any> }>}
 */
const _topicCoalesce = new Map();

function _registerCoalesce(ws, topic, coalesceBy) {
	let entry = _topicCoalesce.get(topic);
	if (!entry) {
		entry = { coalesceBy, ws: new Set() };
		_topicCoalesce.set(topic, entry);
	}
	entry.ws.add(ws);
}

function _unregisterCoalesce(ws, topic) {
	const entry = _topicCoalesce.get(topic);
	if (!entry) return;
	entry.ws.delete(ws);
	if (entry.ws.size === 0) _topicCoalesce.delete(topic);
}

/**
 * Per-topic transform registry. When a stream registered with `transform`
 * is subscribed, its topic is recorded here. The publish helper applies
 * the transform once per publish, BEFORE platform.publish (or the
 * sendCoalesced fan-out), so subscribers see the projected wire shape.
 *
 * Refcounted by ws-topic contributions -- evicted when the last
 * subscriber leaves so HMR-changed stream definitions can re-register.
 *
 * @type {Map<string, { transform: Function, refcount: number }>}
 */
const _topicTransform = new Map();

/** Per-ws set of topics where this ws has contributed a transform refcount.
 *  Lets the unregister side be idempotent and ws-aware. */
const _wsTransformContrib = new WeakMap();

function _registerTransform(ws, topic, transform) {
	let entry = _topicTransform.get(topic);
	if (!entry) {
		entry = { transform, refcount: 0 };
		_topicTransform.set(topic, entry);
	}
	entry.refcount++;
	let contrib = _wsTransformContrib.get(ws);
	if (!contrib) { contrib = new Set(); _wsTransformContrib.set(ws, contrib); }
	contrib.add(topic);
}

function _unregisterTransform(ws, topic) {
	const contrib = _wsTransformContrib.get(ws);
	if (!contrib || !contrib.has(topic)) return;
	contrib.delete(topic);
	const entry = _topicTransform.get(topic);
	if (!entry) return;
	entry.refcount--;
	if (entry.refcount <= 0) _topicTransform.delete(topic);
}

/**
 * Reset the per-topic transform registry. Tests only.
 * @internal
 */
export function _resetTransformRegistry() {
	_topicTransform.clear();
}

/**
 * Apply a transform function to initial-load data. Per-item for arrays
 * (covers crud/latest/presence/cursor merge), whole-value for
 * non-arrays (covers set merge).
 * @param {Function} transform
 * @param {any} data
 * @returns {any}
 */
function _applyInitTransform(transform, data) {
	if (Array.isArray(data)) {
		const out = new Array(data.length);
		for (let i = 0; i < data.length; i++) out[i] = transform(data[i]);
		return out;
	}
	return transform(data);
}

/** @type {WeakMap<any, { publish: Function, throttle: Function, debounce: Function, signal: Function, batch: Function, shed: Function }>} */
const _ctxHelpersCache = new WeakMap();

/**
 * Get cached ctx helper methods for a platform.
 * Avoids creating new closures on every RPC call.
 * @param {import('svelte-adapter-uws').Platform} platform
 * @returns {{ publish: Function, throttle: Function, debounce: Function, signal: Function, batch: Function, shed: Function }}
 */
function _getCtxHelpers(platform) {
	let helpers = _ctxHelpersCache.get(platform);
	if (!helpers) {
		const publish = function publish(topic, event, data, options) {
			// Fast path: no per-topic registries populated anywhere -> straight
			// broadcast. Two Map.size reads + AND + branch is faster than two
			// Map.get calls in the common no-feature case, and pays for itself
			// the moment any app uses neither coalesceBy nor transform.
			if (_topicCoalesce.size === 0 && _topicTransform.size === 0) {
				return platform.publish(topic, event, data, options);
			}
			const c = _topicCoalesce.get(topic);
			const t = _topicTransform.get(topic);
			// coalesceBy reads the ORIGINAL data (before transform) so the key
			// extractor sees the un-projected fields it was written against.
			const coalesceKey = c ? c.coalesceBy(data) : undefined;
			// Transform produces the wire data once -- applied here, before
			// fan-out, so every subscriber sees the same projected shape.
			const wireData = t ? t.transform(data) : data;
			if (!c) return platform.publish(topic, event, wireData, options);
			const fullKey = topic + '\0' + (coalesceKey == null ? '' : coalesceKey);
			let last = true;
			for (const ws of c.ws) {
				last = platform.sendCoalesced(ws, { key: fullKey, topic, event, data: wireData });
			}
			return last;
		};
		helpers = {
			publish,
			throttle: (topic, event, data, ms) => _throttlePublish(platform, topic, event, data, ms),
			debounce: (topic, event, data, ms) => _debouncePublish(platform, topic, event, data, ms),
			signal: (userId, event, data) => platform.publish('__signal:' + userId, event, data),
			batch: (messages) => platform.batch ? platform.batch(messages) : messages.forEach(m => publish(m.topic, m.event, m.data, m.options)),
			shed: (className) => _shouldShed(platform, className)
		};
		_ctxHelpersCache.set(platform, helpers);
	}
	return helpers;
}

/**
 * Roll back a stream subscription that was set up before the init function failed.
 * Unsubscribes the topic, removes dynamic mappings, and decrements the gauge.
 * @param {any} ws
 * @param {string} topic
 * @param {Function} fn
 */
/**
 * Register a stream subscription in the per-socket ownership map.
 * @param {any} ws
 * @param {string} topic
 * @param {Function} fn
 */
function _trackStreamSub(ws, topic, fn) {
	let topicMap = _wsStreamOwners.get(ws);
	if (!topicMap) { topicMap = new Map(); _wsStreamOwners.set(ws, topicMap); }
	let owners = topicMap.get(topic);
	const isFirstSubForTopic = !owners;
	if (!owners) { owners = []; topicMap.set(topic, owners); }
	const existing = owners.find(o => o.fn === fn);
	if (existing) { existing.count++; } else { owners.push({ fn, count: 1 }); }
	if (isFirstSubForTopic && /** @type {any} */ (fn).__coalesceBy) {
		_registerCoalesce(ws, topic, /** @type {any} */ (fn).__coalesceBy);
	}
	if (isFirstSubForTopic && /** @type {any} */ (fn).__streamTransform) {
		_registerTransform(ws, topic, /** @type {any} */ (fn).__streamTransform);
	}
	if (_metricsInstruments) _metricsInstruments.streamGauge.inc();
}

/**
 * Record RPC metrics for any exit path. Call exactly once per RPC.
 * @param {string} path
 * @param {string} code - error code, or empty string for success
 * @param {number} startTime - from Date.now(), or 0 to skip duration
 */
function _recordRpcMetrics(path, code, startTime) {
	if (!_metricsInstruments) return;
	const status = code ? 'error' : 'ok';
	_metricsInstruments.rpcCount.inc({ path, status });
	if (code) _metricsInstruments.rpcErrors.inc({ path, code });
	if (startTime) _metricsInstruments.rpcDuration.observe({ path }, (Date.now() - startTime) / 1000);
}

/** @type {WeakSet<object>} Sockets currently in rollback (skips grace period in presence) */
const _rollingBack = new WeakSet();

function _rollbackStreamSubscribe(ws, topic, fn, ctx) {
	try { ws.unsubscribe(topic); } catch {}
	if (_metricsInstruments) _metricsInstruments.streamGauge.dec();
	const topicMap = _wsStreamOwners.get(ws);
	if (topicMap) {
		const owners = topicMap.get(topic);
		if (owners) {
			const idx = owners.findIndex(o => o.fn === fn);
			if (idx >= 0) {
				owners[idx].count--;
				if (owners[idx].count <= 0) owners.splice(idx, 1);
				if (owners.length === 0) {
					topicMap.delete(topic);
					_unregisterCoalesce(ws, topic);
					_unregisterTransform(ws, topic);
				}
			}
		}
	}
	if (/** @type {any} */ (fn).__onUnsubscribe && ctx) {
		_rollingBack.add(ws);
		Promise.resolve()
			.then(() => /** @type {any} */ (fn).__onUnsubscribe(ctx, topic))
			.catch(() => {})
			.finally(() => _rollingBack.delete(ws));
	}
}

/**
 * Build a ctx object with a stable V8 hidden class.
 * All call sites must use this factory to ensure monomorphic property access.
 * Same property count, same order, same types at each slot -> single hidden class.
 * @param {any} user
 * @param {any} ws
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ publish: Function, throttle: Function, debounce: Function, signal: Function, batch: Function, shed: Function }} helpers
 * @param {any} cursor
 * @param {string | null} [idempotencyKey] Envelope-supplied idempotency key, or null. Internal use only.
 * @returns {any}
 */
function _buildCtx(user, ws, platform, helpers, cursor, idempotencyKey) {
	return {
		user,
		ws,
		platform,
		publish: helpers.publish,
		cursor,
		throttle: helpers.throttle,
		debounce: helpers.debounce,
		signal: helpers.signal,
		batch: helpers.batch,
		shed: helpers.shed,
		_idempotencyKey: idempotencyKey || null
	};
}

/**
 * Walk a wrapper chain and set __rateLimitPath on any rate-limited function found.
 * Handles arbitrary nesting: validated(rateLimit(...)), room action wrappers, etc.
 * @param {any} fn
 * @param {string} path
 */
function _propagateRateLimitPath(fn, path) {
	let cur = fn;
	for (let depth = 0; cur && depth < 10; depth++) {
		if (cur.__isRateLimited) cur.__rateLimitPath = path;
		cur = cur.__wrappedFn || null;
	}
}

/**
 * Register a live function in the registry.
 * Called by the Vite-generated registry module.
 * Accepts either a live function directly or a lazy loader (tagged with __lazy).
 * @param {string} path
 * @param {Function} fn
 * @param {string} [modulePath] - Explicit module path for guard resolution (used by room sub-handlers)
 */
export function __register(path, fn, modulePath) {
	registry.set(path, fn);
	if (/** @type {any} */ (fn).__lazy) {
		if (modulePath) /** @type {any} */ (fn).__modulePathHint = modulePath;
		return;
	}
	// Cache module path to avoid recomputing substring on every RPC call
	/** @type {any} */ (fn).__modulePath = modulePath || path.substring(0, path.lastIndexOf('/'));
	// Propagate rate-limit path through the wrapper chain
	_propagateRateLimitPath(fn, path);
	if (/** @type {any} */ (fn).__isStream && /** @type {any} */ (fn).__onUnsubscribe) {
		_streamsWithUnsubscribe.add(fn);
	}
}

/**
 * Resolve a lazy registry entry. If the entry is a lazy loader (__lazy),
 * dynamically import the module, cache the resolved function, and return it.
 * @param {string} path
 * @returns {Promise<Function | null>}
 */
async function _resolveRegistryEntry(path) {
	const entry = registry.get(path);
	if (!entry) return null;
	if (!/** @type {any} */ (entry).__lazy) return entry;
	const hint = /** @type {any} */ (entry).__modulePathHint;
	const fn = await entry();
	if (!fn) {
		registry.delete(path);
		return null;
	}
	registry.set(path, fn);
	/** @type {any} */ (fn).__modulePath = hint || path.substring(0, path.lastIndexOf('/'));
	_propagateRateLimitPath(fn, path);
	if (/** @type {any} */ (fn).__isStream && /** @type {any} */ (fn).__onUnsubscribe) {
		_streamsWithUnsubscribe.add(fn);
	}
	return fn;
}

/**
 * Register a guard for a module.
 * Called by the Vite-generated registry module.
 * Accepts either a guard function directly or a lazy loader (tagged with __lazy).
 * @param {string} modulePath
 * @param {Function} fn
 */
export function __registerGuard(modulePath, fn) {
	guards.set(modulePath, fn);
}

/**
 * Resolve a lazy guard entry.
 * @param {string} modulePath
 * @returns {Promise<Function | null>}
 */
async function _resolveGuard(modulePath) {
	const entry = guards.get(modulePath);
	if (!entry) return null;
	if (!/** @type {any} */ (entry).__lazy) return entry;
	const fn = await entry();
	if (!fn) {
		guards.delete(modulePath);
		return null;
	}
	guards.set(modulePath, fn);
	return fn;
}

/**
 * Mark a function as RPC-callable.
 * @template {Function} T
 * @param {T} fn
 * @returns {T}
 */
export function live(fn) {
	/** @type {any} */ (fn).__isLive = true;
	return fn;
}

/**
 * Mark a function as a stream provider.
 * Topic can be a static string or a function of (ctx, ...args) => string for dynamic topics.
 * @param {string | Function} topic
 * @param {Function} initFn
 * @param {{ merge?: 'crud' | 'latest' | 'set' | 'presence' | 'cursor', key?: string, prepend?: boolean, max?: number, replay?: boolean | { size?: number }, coalesceBy?: (data: any) => string | number | null | undefined }} [options]
 * @returns {Function}
 */
live.stream = function stream(topic, initFn, options) {
	if (typeof topic === 'string' && topic.startsWith('__')) {
		throw new Error(`[svelte-realtime] live.stream topic '${topic}' uses reserved prefix '__'\n  See: https://svti.me/streams`);
	}
	if (typeof topic === 'function') {
		if (topic.constructor?.name === 'AsyncFunction') {
			throw new Error(`[svelte-realtime] live.stream topic function must not be async -- topic resolution is synchronous\n  See: https://svti.me/streams`);
		}
		_tagTopicFn(topic);
	}
	const { replay, onSubscribe, onUnsubscribe, filter, access, delta, version, migrate, coalesceBy, classOfService, args: argsSchema, transform, ...rest } = options || {};
	if (coalesceBy !== undefined && typeof coalesceBy !== 'function') {
		throw new Error('[svelte-realtime] live.stream coalesceBy must be a function (data) => key');
	}
	if (classOfService !== undefined && typeof classOfService !== 'string') {
		throw new Error('[svelte-realtime] live.stream classOfService must be a string naming a class registered via live.admission()');
	}
	if (argsSchema !== undefined && (argsSchema === null || typeof argsSchema !== 'object')) {
		throw new Error('[svelte-realtime] live.stream args must be a Standard Schema or Zod-compatible schema');
	}
	if (transform !== undefined && typeof transform !== 'function') {
		throw new Error('[svelte-realtime] live.stream transform must be a function (data) => projection');
	}
	if (delta !== undefined) {
		if (typeof delta !== 'object' || delta === null) {
			throw new Error('[svelte-realtime] live.stream delta must be an object');
		}
		if (delta.version !== undefined && typeof delta.version !== 'function') {
			throw new Error('[svelte-realtime] live.stream delta.version must be a function');
		}
		if (delta.diff !== undefined && typeof delta.diff !== 'function') {
			throw new Error('[svelte-realtime] live.stream delta.diff must be a function');
		}
		if (delta.fromSeq !== undefined && typeof delta.fromSeq !== 'function') {
			throw new Error('[svelte-realtime] live.stream delta.fromSeq must be a function (sinceSeq) => events[]');
		}
	}
	const merged = { merge: 'crud', key: 'id', ...rest };
	if (replay) /** @type {any} */ (initFn).__replay = typeof replay === 'object' ? replay : {};
	if (delta) /** @type {any} */ (initFn).__delta = delta;
	if (classOfService) /** @type {any} */ (initFn).__classOfService = classOfService;
	/** @type {any} */ (initFn).__isStream = true;
	/** @type {any} */ (initFn).__isLive = true;
	/** @type {any} */ (initFn).__streamTopic = topic;
	/** @type {any} */ (initFn).__streamOptions = merged;
	if (coalesceBy) /** @type {any} */ (initFn).__coalesceBy = coalesceBy;
	if (argsSchema) /** @type {any} */ (initFn).__streamArgs = argsSchema;
	if (transform) /** @type {any} */ (initFn).__streamTransform = transform;
	if (onSubscribe) /** @type {any} */ (initFn).__onSubscribe = onSubscribe;
	if (onUnsubscribe) /** @type {any} */ (initFn).__onUnsubscribe = onUnsubscribe;
	// Subscribe-time access predicate: (ctx) => boolean
	const filterFn = access || filter;
	if (filterFn) /** @type {any} */ (initFn).__streamFilter = filterFn;
	// Schema versioning
	if (version !== undefined) /** @type {any} */ (initFn).__streamVersion = version;
	if (migrate) /** @type {any} */ (initFn).__streamMigrate = migrate;
	return initFn;
};

/**
 * Create an ephemeral pub/sub channel with no database initialization.
 * Channels have no initFn -- clients subscribe to a topic and receive events immediately.
 *
 * @param {string | Function} topic - Static topic string or function (ctx, ...args) => string for dynamic channels
 * @param {{ merge?: 'crud' | 'latest' | 'set' | 'presence' | 'cursor', key?: string, max?: number }} [options]
 * @returns {Function}
 */
live.channel = function channel(topic, options) {
	if (typeof topic === 'string' && topic.startsWith('__')) {
		throw new Error(`[svelte-realtime] live.channel topic '${topic}' uses reserved prefix '__'\n  See: https://svti.me/streams`);
	}
	if (typeof topic === 'function') {
		if (topic.constructor?.name === 'AsyncFunction') {
			throw new Error(`[svelte-realtime] live.channel topic function must not be async -- topic resolution is synchronous\n  See: https://svti.me/streams`);
		}
		_tagTopicFn(topic);
	}
	const merged = { merge: options?.merge || 'set', key: options?.key || 'id' };
	if (options?.max !== undefined) merged.max = options.max;
	const emptyValue = (merged.merge === 'set') ? null : [];

	const initFn = async function channelInit() { return emptyValue; };
	/** @type {any} */ (initFn).__isStream = true;
	/** @type {any} */ (initFn).__isLive = true;
	/** @type {any} */ (initFn).__isChannel = true;
	/** @type {any} */ (initFn).__streamTopic = topic;
	/** @type {any} */ (initFn).__streamOptions = merged;
	return initFn;
};

/**
 * Mark a function as a binary RPC handler.
 * The first argument after ctx is the raw ArrayBuffer.
 * Remaining arguments are JSON-encoded in a header.
 *
 * @param {Function} fn - Handler function (ctx, buffer, ...jsonArgs)
 * @returns {Function}
 */
live.binary = function binary(fn, options) {
	/** @type {any} */ (fn).__isLive = true;
	/** @type {any} */ (fn).__isBinary = true;
	if (options?.maxSize) /** @type {any} */ (fn).__maxBinarySize = options.maxSize;
	return fn;
};

/**
 * Register a global middleware that runs before per-module guards for every RPC/stream call.
 * Middleware receives `(ctx, next)` -- call `next()` to continue the chain.
 * Throw a LiveError to reject the call.
 *
 * @param {(ctx: any, next: () => Promise<any>) => Promise<any>} fn
 */
live.middleware = function middleware(fn) {
	_globalMiddleware.push(fn);
};

/**
 * Declarative access control helpers for subscribe-time gating.
 * These return predicates compatible with `live.stream({ access: ... })`.
 * Access predicates receive only `ctx` and are checked once at subscription time.
 * For per-event filtering, use `pipe.filter()`.
 */
live.access = {
	/**
	 * Only allow subscription if `ctx.user[field]` is present (authenticated with that field).
	 * For per-user data isolation, use dynamic topics instead: `(ctx) => \`items:\${ctx.user.id}\``.
	 * @param {string} [field] - The field on ctx.user to check (default: 'id')
	 * @returns {(ctx: any) => boolean}
	 */
	owner(field = 'id') {
		return (ctx) => ctx.user?.[field] != null;
	},

	/**
	 * Role-based access: map role names to boolean or predicate.
	 * @param {Record<string, true | ((ctx: any) => boolean)>} map
	 * @returns {(ctx: any) => boolean}
	 */
	role(map) {
		return (ctx) => {
			const role = ctx.user?.role;
			if (!role || !(role in map)) return false;
			const rule = map[role];
			return rule === true ? true : rule(ctx);
		};
	},

	/**
	 * Only allow subscription if `ctx.user.teamId` is present.
	 * For per-team data isolation, use dynamic topics: `(ctx) => \`items:\${ctx.user.teamId}\``.
	 * @returns {(ctx: any) => boolean}
	 */
	team() {
		return (ctx) => ctx.user?.teamId != null;
	},

	/**
	 * Org-scoped access: an extracted value (default arg 0) must equal
	 * `ctx.user.organization_id` (default field). Returns false when
	 * `ctx.user` is null. Use to close authorization-bypass holes
	 * around per-org streams and RPCs.
	 *
	 * @param {{ from?: (ctx: any, ...args: any[]) => any, userField?: string }} [opts]
	 * @returns {(ctx: any, ...args: any[]) => boolean}
	 */
	org(opts) {
		const userField = (opts && opts.userField) || 'organization_id';
		const from = (opts && opts.from) || ((_ctx, ...args) => args[0]);
		return (ctx, ...args) => {
			const expected = ctx && ctx.user && ctx.user[userField];
			if (expected == null) return false;
			const actual = from(ctx, ...args);
			return actual != null && actual === expected;
		};
	},

	/**
	 * User-scoped access: an extracted value (default arg 0) must equal
	 * `ctx.user.user_id` (default field, matching `[table]_id` convention).
	 * Returns false when `ctx.user` is null. Use for streams/RPCs that
	 * MUST belong to the calling user (e.g. private inbox); set `from`
	 * for handlers where the relevant id lives in a non-default
	 * position.
	 *
	 * @param {{ from?: (ctx: any, ...args: any[]) => any, userField?: string }} [opts]
	 * @returns {(ctx: any, ...args: any[]) => boolean}
	 */
	user(opts) {
		const userField = (opts && opts.userField) || 'user_id';
		const from = (opts && opts.from) || ((_ctx, ...args) => args[0]);
		return (ctx, ...args) => {
			const expected = ctx && ctx.user && ctx.user[userField];
			if (expected == null) return false;
			const actual = from(ctx, ...args);
			return actual != null && actual === expected;
		};
	},

	/**
	 * OR logic: any predicate returning true allows the subscription.
	 * Args are forwarded so args-aware predicates (`org`, `user`) compose.
	 * @param {...((ctx: any, ...args: any[]) => boolean)} predicates
	 * @returns {(ctx: any, ...args: any[]) => boolean}
	 */
	any(...predicates) {
		return (ctx, ...args) => predicates.some(p => p(ctx, ...args));
	},

	/**
	 * AND logic: all predicates must return true to allow the subscription.
	 * Args are forwarded so args-aware predicates (`org`, `user`) compose.
	 * @param {...((ctx: any, ...args: any[]) => boolean)} predicates
	 * @returns {(ctx: any, ...args: any[]) => boolean}
	 */
	all(...predicates) {
		return (ctx, ...args) => predicates.every(p => p(ctx, ...args));
	}
};

/** @type {Map<string, { prev: number, curr: number, windowStart: number, windowMs: number }>} */
const _rateLimits = new Map();

/** @type {number} */
let _rateLimitLastSweep = Date.now();

/** Hard cap on rate limit buckets to prevent memory exhaustion */
const _RATE_LIMIT_MAX = 5000;

/**
 * Declarative per-function rate limiting.
 * Wraps a live() function with a sliding window rate limiter.
 *
 * @param {{ points: number, window: number, key?: (ctx: any) => string }} config
 * @param {Function} fn - Handler function (ctx, ...args)
 * @returns {Function}
 */
live.rateLimit = function rateLimit(config, fn) {
	const { points, window: windowMs } = config;
	const keyFn = config.key || ((ctx) => _getIdentityKey(ctx));

	const wrapper = async function rateLimitedWrapper(ctx, ...args) {
		const userKey = keyFn(ctx);
		const bucketKey = /** @type {any} */ (wrapper).__rateLimitPath + '\0' + userKey;
		const now = Date.now();

		// Lazy sweep: prune stale entries every 30s, sweep all entries
		if (now - _rateLimitLastSweep > 30000) {
			_rateLimitLastSweep = now;
			for (const [k, bucket] of _rateLimits) {
				if (now - bucket.windowStart >= bucket.windowMs * 2) {
					_rateLimits.delete(k);
				}
			}
		}

		let bucket = _rateLimits.get(bucketKey);

		// Hard cap on new buckets only — existing identities always pass through
		if (!bucket && _rateLimits.size >= _RATE_LIMIT_MAX) {
			for (const [k, b] of _rateLimits) {
				if (now - b.windowStart >= b.windowMs * 2) _rateLimits.delete(k);
			}
			if (_rateLimits.size >= _RATE_LIMIT_MAX) {
				throw new LiveError('RATE_LIMITED', 'Too many concurrent rate-limit identities');
			}
		}
		if (!bucket) {
			bucket = { prev: 0, curr: 0, windowStart: now, windowMs };
			_rateLimits.set(bucketKey, bucket);
		}

		// Rotate windows if needed
		const elapsed = now - bucket.windowStart;
		if (elapsed >= windowMs * 2) {
			// Both windows expired, reset
			bucket.prev = 0;
			bucket.curr = 0;
			bucket.windowStart = now;
		} else if (elapsed >= windowMs) {
			// Current window expired, rotate
			bucket.prev = bucket.curr;
			bucket.curr = 0;
			bucket.windowStart += windowMs;
		}

		// Estimate count in sliding window using weighted average
		const windowElapsed = now - bucket.windowStart;
		const weight = Math.max(0, 1 - windowElapsed / windowMs);
		const estimated = bucket.prev * weight + bucket.curr;

		if (estimated >= points) {
			const retryAfter = Math.ceil(windowMs - windowElapsed);
			const err = new LiveError('RATE_LIMITED', 'Too many requests');
			/** @type {any} */ (err).retryAfter = retryAfter;
			throw err;
		}

		bucket.curr++;
		return fn(ctx, ...args);
	};

	/** @type {any} */ (wrapper).__isLive = true;
	/** @type {any} */ (wrapper).__isRateLimited = true;
	/** @type {any} */ (wrapper).__rateLimitPath = '';
	/** @type {any} */ (wrapper).__wrappedFn = fn;
	return wrapper;
};

/** @type {{ acquire: (key: string, ttlSec: number) => Promise<any> } | null} */
let _defaultIdempotencyStore = null;

/**
 * Lazy in-process idempotency store. Three-state acquire matching the contract
 * of `createIdempotencyStore` from svelte-adapter-uws-extensions, so swapping
 * the default for a multi-instance backend is a one-line change.
 * Bounded by maxEntries; lazy-sweeps expired records every 30s.
 */
function _createInMemoryIdempotencyStore({ maxEntries = 10000 } = {}) {
	/** @type {Map<string, { value: any, expiresAt: number }>} */
	const results = new Map();
	/** @type {Map<string, Promise<any>>} */
	const inflight = new Map();
	let lastSweep = Date.now();

	return {
		async acquire(key, ttlSec) {
			const now = Date.now();
			if (now - lastSweep >= 30000) {
				lastSweep = now;
				for (const [k, e] of results) {
					if (e.expiresAt <= now) results.delete(k);
				}
			}
			const cached = results.get(key);
			if (cached) {
				if (cached.expiresAt > now) return { result: cached.value };
				results.delete(key);
			}
			while (inflight.has(key)) {
				try { await inflight.get(key); } catch {}
				const re = results.get(key);
				if (re && re.expiresAt > Date.now()) return { result: re.value };
			}
			let resolveInflight;
			let rejectInflight;
			const promise = new Promise((res, rej) => { resolveInflight = res; rejectInflight = rej; });
			// Suppress unhandled-rejection logs when there are no waiters at the
			// moment a handler aborts. Real awaiters attach their own handlers
			// via `await inflight.get(key)`.
			promise.catch(() => {});
			inflight.set(key, promise);
			if (results.size >= maxEntries) {
				const drop = Math.max(1, Math.floor(maxEntries * 0.1));
				let i = 0;
				for (const k of results.keys()) {
					results.delete(k);
					if (++i >= drop) break;
				}
			}
			const ttlMs = ttlSec * 1000;
			return {
				acquired: true,
				async commit(value) {
					if (ttlMs > 0) results.set(key, { value, expiresAt: Date.now() + ttlMs });
					inflight.delete(key);
					if (resolveInflight) resolveInflight(value);
				},
				async abort() {
					inflight.delete(key);
					if (rejectInflight) rejectInflight(new Error('ABORTED'));
				}
			};
		}
	};
}

function _getDefaultIdempotencyStore() {
	if (_defaultIdempotencyStore) return _defaultIdempotencyStore;
	_defaultIdempotencyStore = _createInMemoryIdempotencyStore();
	return _defaultIdempotencyStore;
}

/**
 * Reset the default in-process idempotency store. Tests only.
 * @internal
 */
export function _resetIdempotencyStore() {
	_defaultIdempotencyStore = null;
}

/**
 * Reset the per-topic coalesce registry. Tests only.
 * @internal
 */
export function _resetCoalesceRegistry() {
	_topicCoalesce.clear();
}

/**
 * Wrap an RPC handler with idempotency: identical calls (by key) return the
 * cached result without re-running the handler. Composes with live(),
 * live.validated(), live.rateLimit(), etc.
 *
 * The key is derived from `config.keyFrom(ctx, ...args)` if provided, otherwise
 * from the client envelope's `idempotencyKey` (set via the client's
 * `rpc.with({ idempotencyKey })` helper). When neither is present, the call
 * runs as if the wrapper were absent.
 *
 * Only successful results are cached. A throwing handler aborts the slot so
 * the next caller re-runs.
 *
 * Default store is in-process (bounded). For multi-instance deployments,
 * pass `store: createIdempotencyStore(redis)` from svelte-adapter-uws-extensions.
 *
 * @param {{ keyFrom?: (ctx: any, ...args: any[]) => string | null | undefined, store?: { acquire: (key: string, ttlSec: number) => Promise<any> }, ttl?: number }} config
 * @param {Function} fn Handler function (ctx, ...args)
 * @returns {Function}
 */
live.idempotent = function idempotent(config, fn) {
	if (typeof fn !== 'function') {
		throw new Error('[svelte-realtime] live.idempotent(config, fn) requires a handler function');
	}
	const cfg = config || {};
	if (cfg.keyFrom !== undefined && typeof cfg.keyFrom !== 'function') {
		throw new Error('[svelte-realtime] live.idempotent: keyFrom must be a function');
	}
	if (cfg.store !== undefined && (cfg.store === null || typeof cfg.store.acquire !== 'function')) {
		throw new Error('[svelte-realtime] live.idempotent: store must implement acquire(key, ttlSec)');
	}
	if (cfg.ttl !== undefined && (typeof cfg.ttl !== 'number' || cfg.ttl < 0)) {
		throw new Error('[svelte-realtime] live.idempotent: ttl must be a non-negative number of seconds');
	}
	const ttlSec = typeof cfg.ttl === 'number' ? cfg.ttl : 172800;
	const keyFrom = cfg.keyFrom || null;
	const customStore = cfg.store || null;

	const wrapper = async function idempotentWrapper(ctx, ...args) {
		const key = keyFrom ? keyFrom(ctx, ...args) : ctx._idempotencyKey;
		if (!key) return fn(ctx, ...args);
		const store = customStore || _getDefaultIdempotencyStore();
		const slot = await store.acquire(key, ttlSec);
		if (slot && slot.acquired) {
			try {
				const data = await fn(ctx, ...args);
				await slot.commit(data);
				return data;
			} catch (err) {
				try { await slot.abort(); } catch {}
				throw err;
			}
		}
		if (slot && slot.pending) {
			throw new LiveError('CONFLICT', 'A request with this idempotency key is already in progress');
		}
		return slot.result;
	};

	/** @type {any} */ (wrapper).__isLive = true;
	/** @type {any} */ (wrapper).__isIdempotent = true;
	/** @type {any} */ (wrapper).__idempotency = { keyFrom, store: customStore, ttl: ttlSec };
	/** @type {any} */ (wrapper).__wrappedFn = fn;
	return wrapper;
};

/**
 * Mark a function as RPC-callable with schema validation.
 * Validates args[0] against the schema before calling fn.
 * Supports any Standard Schema-compatible schema (https://standardschema.dev/),
 * including Zod, ArkType, Valibot v1+, and others.
 *
 * @param {any} schema - Zod, ArkType, Valibot, or any Standard Schema-compatible schema
 * @param {Function} fn - Handler function (ctx, validatedInput, ...rest)
 * @returns {Function}
 */
live.validated = function validated(schema, fn) {
	const wrapper = async function validatedWrapper(ctx, ...args) {
		const input = args[0];
		const result = _validate(schema, input);
		if (!result.ok) {
			const err = new LiveError('VALIDATION', result.message);
			/** @type {any} */ (err).issues = result.issues;
			throw err;
		}
		args[0] = result.data;
		return fn(ctx, ...args);
	};
	/** @type {any} */ (wrapper).__isLive = true;
	/** @type {any} */ (wrapper).__isValidated = true;
	/** @type {any} */ (wrapper).__schema = schema;
	/** @type {any} */ (wrapper).__wrappedFn = fn;
	return wrapper;
};

/**
 * Validate input against a Standard Schema-compatible schema, with legacy Zod/Valibot fallbacks.
 * @param {any} schema
 * @param {any} input
 * @returns {{ ok: true, data: any } | { ok: false, message: string, issues: Array<{ path: string[], message: string }> }}
 */
function _validate(schema, input) {
	// Standard Schema: schema exposes `~standard.validate` (https://standardschema.dev/)
	if (schema?.['~standard'] && typeof schema['~standard'].validate === 'function') {
		const result = schema['~standard'].validate(input);
		if (result instanceof Promise) {
			return {
				ok: false,
				message: 'Async schemas are not supported in live.validated(). Use a synchronous schema.',
				issues: [{ path: [], message: 'Async schema not supported' }]
			};
		}
		if (result.issues == null) {
			return { ok: true, data: result.value };
		}
		const issues = result.issues.map((/** @type {any} */ i) => ({
			path: (i.path || []).map((/** @type {any} */ p) => {
				const key = typeof p === 'object' && p !== null && 'key' in p ? p.key : p;
				return key != null ? String(key) : '';
			}).filter((k) => k !== ''),
			message: i.message || 'Validation failed'
		}));
		return { ok: false, message: 'Validation failed', issues };
	}

	// Zod legacy fallback: schema has .safeParse method
	if (typeof schema?.safeParse === 'function') {
		const result = schema.safeParse(input);
		if (result.success) {
			return { ok: true, data: result.data };
		}
		const issues = (result.error?.issues || result.error?.errors || []).map((/** @type {any} */ i) => ({
			path: i.path?.map(String) || [],
			message: i.message || 'Validation failed'
		}));
		return {
			ok: false,
			message: 'Validation failed',
			issues
		};
	}

	// Valibot legacy fallback: schema is passed to a standalone safeParse
	// In Valibot v1, schemas have a ._run or .pipe method
	// Try to use the schema directly as a Valibot schema
	if (schema?._run || schema?.pipe || schema?.type) {
		// Attempt to import valibot's safeParse at call-time
		// Since we can't do static import (it's optional), check if schema has _run
		try {
			const entries = schema._run?.({ typed: false, value: input }, {});
			if (entries && !entries.issues) {
				return { ok: true, data: entries.output ?? input };
			}
			if (entries?.issues) {
				const issues = entries.issues.map((/** @type {any} */ i) => ({
					path: i.path?.map((/** @type {any} */ p) => String(p.key)) || [],
					message: i.message || 'Validation failed'
				}));
				return { ok: false, message: 'Validation failed', issues };
			}
		} catch {
			// Fall through
		}
	}

	// Unknown schema type -- reject. Passing unvalidated input through is a security risk.
	return {
		ok: false,
		message: 'Unrecognized schema type passed to live.validated(). Supported: Standard Schema (https://standardschema.dev/), Zod (.safeParse), Valibot (._run).',
		issues: [{ path: [], message: 'Unrecognized schema type' }]
	};
}

/** @type {Map<string, { schedule: number[], fn: Function, topic: string }>} */
const cronRegistry = new Map();

/** @type {ReturnType<typeof setInterval> | null} */
let _cronInterval = null;

/** @type {import('svelte-adapter-uws').Platform | null} */
let _cronPlatform = null;

/** @type {((path: string, error: unknown) => void) | null} */
let _serverErrorHandler = null;

/**
 * Set a global error handler for server-side errors (cron, effects, derived).
 * Without this, errors are logged in dev and silently swallowed in production.
 * @param {(path: string, error: unknown) => void} handler
 */
export function onError(handler) {
	_serverErrorHandler = handler;
}

/** @deprecated Use onError() instead. */
export function onCronError(handler) {
	_serverErrorHandler = handler;
}

/**
 * Create a server-side scheduled function that publishes to a topic on a cron schedule.
 *
 * @param {string} schedule - Cron expression (5 fields: minute hour day month weekday)
 * @param {string} topic - Topic to publish results to
 * @param {Function} fn - Async function to run on schedule
 * @returns {Function}
 */
live.cron = function cron(schedule, topic, fn) {
	/** @type {any} */ (fn).__isCron = true;
	/** @type {any} */ (fn).__cronSchedule = schedule;
	/** @type {any} */ (fn).__cronTopic = topic;
	/** @type {any} */ (fn).__cronParsed = _parseCron(schedule);
	return fn;
};

/** @type {Map<string, { sources: string[], fn: Function, topic: string, debounce: number, timer: ReturnType<typeof setTimeout> | null }>} */
const derivedRegistry = new Map();

/**
 * Create a server-side computed stream that recomputes when any source topic publishes.
 *
 * Static form: sources is a string[] of topic names.
 * Dynamic form: sources is a function (...args) => string[] that resolves topics at subscribe time.
 *
 * @param {string[] | Function} sources - Topic names to watch, or a factory that receives runtime args
 * @param {Function} fn - Async function that computes the derived value
 * @param {{ merge?: string, debounce?: number }} [options]
 * @returns {Function}
 */
live.derived = function derived(sources, fn, options) {
	const baseTopic = /** @type {any} */ (fn).__derivedTopic || ('__derived:' + (_derivedIdCounter++));
	const merge = options?.merge || 'set';
	const debounce = options?.debounce || 0;
	const dynamic = typeof sources === 'function';

	/** @type {any} */ (fn).__isDerived = true;
	/** @type {any} */ (fn).__isStream = true;
	/** @type {any} */ (fn).__isLive = true;
	/** @type {any} */ (fn).__streamOptions = { merge, key: 'id' };
	/** @type {any} */ (fn).__derivedDebounce = debounce;

	if (dynamic) {
		/** @type {any} */ (fn).__derivedDynamic = true;
		/** @type {any} */ (fn).__derivedSourceFactory = sources;
		/** @type {Map<string, any[]>} */
		const topicArgs = new Map();
		const topicFn = (...args) => {
			const t = baseTopic + '~' + args.map(a => String(a).replace(/~/g, '')).join('~');
			topicArgs.set(t, args);
			if (topicArgs.size > 10000) {
				const iter = topicArgs.keys();
				topicArgs.delete(iter.next().value);
			}
			return t;
		};
		/** @type {any} */ (topicFn).__topicUsesCtx = false;
		/** @type {any} */ (fn).__streamTopic = topicFn;
		/** @type {any} */ (fn).__derivedTopicArgs = topicArgs;

		/** @type {any} */ (fn).__onSubscribe = function (_ctx, resolvedTopic) {
			_activateDynamicDerived(fn, resolvedTopic, _ctx && _ctx.user);
		};
		/** @type {any} */ (fn).__onUnsubscribe = function (_ctx, resolvedTopic) {
			_deactivateDynamicDerived(fn, resolvedTopic);
		};
	} else {
		/** @type {any} */ (fn).__streamTopic = baseTopic;
		/** @type {any} */ (fn).__derivedSources = sources;
	}

	return fn;
};

let _derivedIdCounter = 0;

/** @type {boolean} Whether any dynamic derived streams have been registered */
let _hasDynamicDerived = false;

/** @type {Map<Function, object>} O(1) lookup from fn reference to dynamic derived registry entry */
const _dynamicDerivedByFn = new Map();

/** @type {import('svelte-adapter-uws').Platform | null} Captured platform for dynamic derived recomputation */
let _derivedPlatform = null;

/** @type {boolean} Whether _activateDerived has been called at least once */
let _activateDerivedCalled = false;

/** @type {boolean} Whether the missing _activateDerived warning has already fired */
let _warnedActivateDerived = false;

/** @type {Map<string, { sources: string[], fn: Function, debounce: number, timer: ReturnType<typeof setTimeout> | null }>} */
const effectRegistry = new Map();

/**
 * Create a server-side reactive side effect.
 * Effects fire when source topics publish. They are fire-and-forget -- no data, no topic.
 *
 * @param {string[]} sources - Topic names to watch
 * @param {Function} fn - Async function (event, data, platform) called on each matching publish
 * @param {{ debounce?: number }} [options]
 * @returns {Function}
 */
live.effect = function effect(sources, fn, options) {
	const debounce = options?.debounce || 0;
	/** @type {any} */ (fn).__isEffect = true;
	/** @type {any} */ (fn).__effectSources = sources;
	/** @type {any} */ (fn).__effectDebounce = debounce;
	return fn;
};

/**
 * Register an effect. Called by the Vite-generated registry module.
 * @param {string} path
 * @param {Function} fn
 */
export function __registerEffect(path, fn) {
	if (/** @type {any} */ (fn).__lazy) {
		_lazyQueue.push({ type: 'effect', path, loader: fn });
		return;
	}
	const sources = /** @type {any} */ (fn).__effectSources;
	const debounce = /** @type {any} */ (fn).__effectDebounce || 0;
	if (!sources) return;
	effectRegistry.set(path, { sources, fn, debounce, timer: null });
	for (const src of sources) {
		let set = _effectBySource.get(src);
		if (!set) { set = new Set(); _effectBySource.set(src, set); }
		set.add(effectRegistry.get(path));
		_watchedTopics.add(src);
	}
}

/** @type {Map<string, { source: string, reducers: any, topic: string, state: any, snapshot: Function | null, debounce: number, timer: ReturnType<typeof setTimeout> | null }>} */
const aggregateRegistry = new Map();
/** @type {Map<string, any>} Topic-keyed lookup for aggregates */
const _aggregateByTopic = new Map();

/** @type {Map<string, Set<any>>} Source topic -> derived entries that watch it */
const _derivedBySource = new Map();

/** @type {Map<string, Set<any>>} Source topic -> effect entries that watch it */
const _effectBySource = new Map();

/** @type {Map<string, Set<any>>} Source topic -> aggregate entries that watch it */
const _aggregateBySource = new Map();

/** @type {Set<string>} All source topics watched by derived/effect/aggregate for fast bail-out */
const _watchedTopics = new Set();

/**
 * Create a real-time incremental aggregation over a source topic.
 * Each event runs O(1) reducers instead of requerying the database.
 *
 * @param {string} source - Topic to watch for events
 * @param {Record<string, { init?: () => any, reduce?: (acc: any, event: string, data: any) => any, compute?: (state: any) => any }>} reducers
 * @param {{ topic: string, snapshot?: () => Promise<any>, debounce?: number }} options
 * @returns {Function}
 */
live.aggregate = function aggregate(source, reducers, options) {
	const topic = options.topic;
	const debounce = options?.debounce || 0;

	// Build initial state from init() functions
	const initState = {};
	for (const [field, r] of Object.entries(reducers)) {
		if (r.init) initState[field] = r.init();
	}

	const initFn = async function aggregateInit() {
		const entry = _aggregateByTopic.get(topic);
		if (entry) {
			// Wait for snapshot hydration to finish before returning state
			if (entry._hydrationPromise) await entry._hydrationPromise;
			return _computeAggregateState(entry.state, reducers);
		}
		return _computeAggregateState(initState, reducers);
	};

	/** @type {any} */ (initFn).__isAggregate = true;
	/** @type {any} */ (initFn).__isStream = true;
	/** @type {any} */ (initFn).__isLive = true;
	/** @type {any} */ (initFn).__streamTopic = topic;
	/** @type {any} */ (initFn).__streamOptions = { merge: 'set', key: 'id' };
	/** @type {any} */ (initFn).__aggregateSource = source;
	/** @type {any} */ (initFn).__aggregateReducers = reducers;
	/** @type {any} */ (initFn).__aggregateInitState = initState;
	/** @type {any} */ (initFn).__aggregateSnapshot = options?.snapshot || null;
	/** @type {any} */ (initFn).__aggregateDebounce = debounce;
	return initFn;
};

/**
 * Compute aggregate state including computed fields.
 * @param {any} state
 * @param {Record<string, any>} reducers
 * @returns {any}
 */
function _computeAggregateState(state, reducers) {
	const result = { ...state };
	for (const [field, r] of Object.entries(reducers)) {
		if (r.compute) {
			result[field] = r.compute(result);
		}
	}
	return result;
}

/**
 * Register an aggregate. Called by the Vite-generated registry module.
 * @param {string} path
 * @param {Function} fn
 */
export function __registerAggregate(path, fn) {
	if (/** @type {any} */ (fn).__lazy) {
		_lazyQueue.push({ type: 'aggregate', path, loader: fn });
		return;
	}
	const source = /** @type {any} */ (fn).__aggregateSource;
	const reducers = /** @type {any} */ (fn).__aggregateReducers;
	const topic = /** @type {any} */ (fn).__streamTopic;
	const initState = /** @type {any} */ (fn).__aggregateInitState;
	const snapshot = /** @type {any} */ (fn).__aggregateSnapshot;
	const debounce = /** @type {any} */ (fn).__aggregateDebounce || 0;
	if (!source || !topic) return;
	const entry = { source, reducers, topic, state: { ...initState }, snapshot, debounce, timer: null, _reducerEntries: Object.entries(reducers), _hydrationPromise: null };

	if (snapshot) {
		entry._hydrationPromise = (async () => {
			try {
				const snapshotState = await snapshot();
				if (snapshotState && typeof snapshotState === 'object') {
					Object.assign(entry.state, snapshotState);
				}
			} catch {}
			entry._hydrationPromise = null;
		})();
	}

	aggregateRegistry.set(path, entry);
	_aggregateByTopic.set(topic, entry);
	let srcSet = _aggregateBySource.get(source);
	if (!srcSet) { srcSet = new Set(); _aggregateBySource.set(source, srcSet); }
	srcSet.add(entry);
	_watchedTopics.add(source);
}

/**
 * Conditional stream activation. Wraps a stream function with a predicate.
 * If the predicate returns false, responds with a gated (no-op) response.
 *
 * @param {(ctx: any, ...args: any[]) => boolean} predicate
 * @param {Function} fn - The stream function to wrap
 * @returns {Function}
 */
live.gate = function gate(predicate, fn) {
	const wrapper = async function gatedWrapper(ctx, ...args) {
		return fn(ctx, ...args);
	};

	_copyStreamMeta(wrapper, fn);
	/** @type {any} */ (wrapper).__isGated = true;
	/** @type {any} */ (wrapper).__gatePredicate = predicate;

	return wrapper;
};

/**
 * Wrap a live function with an authorization predicate. Throws when the
 * predicate returns false: UNAUTHENTICATED if `ctx.user` is null,
 * FORBIDDEN otherwise. Predicate may be sync or async.
 *
 * For STREAMS, prefer the `access` option on `live.stream({ access: ... })`
 * so the gate fires before subscribe-side bookkeeping. Use `live.scoped`
 * for RPC handlers, where there is no `access` option.
 *
 * Composes with `live.validated`, `live.rateLimit`, and other wrappers.
 *
 * @param {(ctx: any, ...args: any[]) => boolean | Promise<boolean>} predicate
 * @param {Function} fn - Live function to wrap
 * @returns {Function}
 *
 * @example
 * ```js
 * export const updateOrg = live.scoped(
 *   live.access.org({ from: (ctx, input) => input.orgId }),
 *   live.validated(schema, async (ctx, input) => updateOrg(input))
 * );
 * ```
 */
live.scoped = function scoped(predicate, fn) {
	if (typeof predicate !== 'function') {
		throw new Error('[svelte-realtime] live.scoped(predicate, fn) requires a predicate function');
	}
	if (typeof fn !== 'function') {
		throw new Error('[svelte-realtime] live.scoped(predicate, fn) requires a handler function');
	}
	const wrapper = async function scopedWrapper(ctx, ...args) {
		const ok = await predicate(ctx, ...args);
		if (!ok) {
			const code = ctx && ctx.user ? 'FORBIDDEN' : 'UNAUTHENTICATED';
			throw new LiveError(code, code === 'UNAUTHENTICATED' ? 'Authentication required' : 'Access denied');
		}
		return fn(ctx, ...args);
	};
	/** @type {any} */ (wrapper).__isLive = true;
	/** @type {any} */ (wrapper).__isScoped = true;
	/** @type {any} */ (wrapper).__wrappedFn = fn;
	if (/** @type {any} */ (fn).__isStream) {
		_copyStreamMeta(wrapper, fn);
	}
	return wrapper;
};

/**
 * Compose stream transforms that apply to initial data (and optionally live events).
 *
 * @param {Function} stream - The stream function to wrap
 * @param {...{ transformInit?: Function, transformEvent?: Function }} transforms
 * @returns {Function}
 */
export function pipe(stream, ...transforms) {
	const wrapper = async function pipedWrapper(ctx, ...args) {
		let data = await stream(ctx, ...args);

		// Handle paginated responses
		let isPaginated = false;
		let paginationMeta = {};
		if (data && typeof data === 'object' && !Array.isArray(data) && 'data' in data && 'hasMore' in data) {
			isPaginated = true;
			paginationMeta = { hasMore: data.hasMore, cursor: data.cursor };
			data = data.data;
		}

		// Apply each transform to the initial data
		for (const t of transforms) {
			if (t.transformInit) {
				data = await t.transformInit(data, ctx);
			}
		}

		if (isPaginated) {
			return { data, ...paginationMeta };
		}
		return data;
	};

	_copyStreamMeta(wrapper, stream);

	return wrapper;
}

/**
 * Filter transform: removes items that don't match the predicate.
 * @param {(ctx: any, item: any) => boolean} predicate
 * @returns {{ transformInit: Function, transformEvent: Function }}
 */
pipe.filter = function pipeFilter(predicate) {
	return {
		transformInit(data, ctx) {
			if (!Array.isArray(data)) return data;
			return data.filter(item => predicate(ctx, item));
		},
		transformEvent(ctx, event, data) {
			return predicate(ctx, data);
		}
	};
};

/**
 * Sort transform: sorts initial data by a field.
 * @param {string} field
 * @param {'asc' | 'desc'} [direction]
 * @returns {{ transformInit: Function }}
 */
pipe.sort = function pipeSort(field, direction = 'asc') {
	return {
		transformInit(data) {
			if (!Array.isArray(data)) return data;
			return [...data].sort((a, b) => {
				const va = a[field], vb = b[field];
				if (va < vb) return direction === 'asc' ? -1 : 1;
				if (va > vb) return direction === 'asc' ? 1 : -1;
				return 0;
			});
		}
	};
};

/**
 * Limit transform: caps the number of initial data items.
 * @param {number} n
 * @returns {{ transformInit: Function }}
 */
pipe.limit = function pipeLimit(n) {
	return {
		transformInit(data) {
			if (!Array.isArray(data)) return data;
			return data.slice(0, n);
		}
	};
};

/**
 * Join transform: enriches each item by resolving a field via an async function.
 * @param {string} field - Field to look up
 * @param {(value: any) => Promise<any>} resolver - Async resolver
 * @param {string} as - Field name to attach the resolved value
 * @returns {{ transformInit: Function }}
 */
pipe.join = function pipeJoin(field, resolver, as) {
	return {
		async transformInit(data) {
			if (!Array.isArray(data)) return data;
			return Promise.all(data.map(async (item) => {
				const resolved = await resolver(item[field]);
				return { ...item, [as]: resolved };
			}));
		}
	};
};

/**
 * Create a collaborative room that bundles data stream, presence, cursors, and room-scoped RPC.
 *
 * @param {{ topic: (ctx: any, ...args: any[]) => string, init: (ctx: any, ...args: any[]) => Promise<any>, presence?: (ctx: any) => any, cursors?: boolean | { throttle?: number }, actions?: Record<string, Function>, guard?: Function, onJoin?: Function, onLeave?: Function, merge?: string, key?: string }} config
 * @returns {any}
 */
/**
 * Per topic+userId presence tracking.
 * Stores { count, timer } where count is the number of active connections
 * and timer is a pending grace-period leave (or null).
 * @type {Map<string, { count: number, timer: ReturnType<typeof setTimeout> | null }>}
 */
const _presenceRef = new Map();

const _PRESENCE_REF_MAX = 10000;

/** @type {WeakMap<object, string>} Stable guest ID per connection for anonymous users */
const _guestIds = new WeakMap();
let _guestIdCounter = 0;

/**
 * Get a stable identity key for a connection. Uses ctx.user.id if present,
 * otherwise assigns a unique guest ID that persists for the connection lifetime.
 * @param {any} ctx
 * @returns {string}
 */
function _getIdentityKey(ctx) {
	const id = ctx.user?.id;
	if (id !== undefined && id !== null) return String(id);
	if (!ctx.ws) return 'anon';
	let guestId = _guestIds.get(ctx.ws);
	if (!guestId) {
		guestId = '__guest_' + (++_guestIdCounter).toString(36);
		_guestIds.set(ctx.ws, guestId);
	}
	return guestId;
}

live.room = function room(config) {
	const {
		topic: topicFn,
		init: initFn,
		presence: presenceFn,
		cursors: cursorConfig,
		actions,
		guard: guardFn,
		onJoin,
		onLeave,
		merge: mergeMode = 'crud',
		key: keyField = 'id'
	} = config;

	/** @type {any} */ (topicFn).__topicUsesCtx = true;

	// Number of room-identifying args the topic function expects (excluding ctx).
	// Used by room actions to separate room args from action-specific payload.
	let _roomArgCount = Math.max(0, topicFn.length - 1);
	if (config.topicArgs !== undefined) {
		if (!Number.isInteger(config.topicArgs) || config.topicArgs < 0) {
			throw new Error(`[svelte-realtime] live.room() topicArgs must be a non-negative integer, got ${config.topicArgs}\n  See: https://svti.me/rooms`);
		}
		_roomArgCount = config.topicArgs;
	} else if (actions) {
		throw new Error(
			`[svelte-realtime] live.room() with actions requires 'topicArgs'. ` +
			`Set topicArgs to the number of room-identifying args (excluding ctx).\n  See: https://svti.me/rooms`
		);
	}

	const roomExport = {};

	const dataStream = live.stream(topicFn, async function roomInit(ctx, ...args) {
		if (guardFn) await guardFn(ctx, ...args);
		const result = await initFn(ctx, ...args);
		// onJoin runs after successful init so a failed init doesn't leave orphaned side effects
		if (onJoin) {
			try { await onJoin(ctx, ...args); } catch {}
		}
		return result;
	}, {
		merge: mergeMode,
		key: keyField,
		onSubscribe: presenceFn ? (ctx, topic) => {
			const userId = _getIdentityKey(ctx);
			const refKey = topic + '\0' + userId;

			let ref = _presenceRef.get(refKey);
			if (ref) {
				// Cancel pending grace leave if reconnecting
				if (ref.timer) { clearTimeout(ref.timer); ref.timer = null; }
				ref.count++;
				// Refresh LRU position so active entries survive eviction
				_presenceRef.delete(refKey);
				_presenceRef.set(refKey, ref);
				return;
			}

			if (_presenceRef.size >= _PRESENCE_REF_MAX) {
				for (const [k, r] of _presenceRef) {
					if (r.timer) {
						clearTimeout(r.timer);
						const [t, u] = k.split('\0');
						ctx.publish(t + ':presence', 'leave', { key: u });
						if (onLeave) {
							Promise.resolve().then(() => onLeave(ctx, t)).catch(() => {});
						}
						_presenceRef.delete(k);
					}
				}
				if (_presenceRef.size >= _PRESENCE_REF_MAX) {
					return;
				}
			}

			_presenceRef.set(refKey, { count: 1, timer: null });

			const presenceData = presenceFn(ctx);
			if (presenceData) {
				ctx.publish(topic + ':presence', 'join', { key: userId, data: presenceData });
			}
		} : undefined,
		onUnsubscribe: presenceFn ? (ctx, topic) => {
			const userId = _getIdentityKey(ctx);
			const refKey = topic + '\0' + userId;

			const ref = _presenceRef.get(refKey);
			if (!ref) return;

			ref.count--;
			if (ref.count > 0) return;

			// On rollback (failed stream init), skip grace and leave immediately
			if (ctx.ws && _rollingBack.has(ctx.ws)) {
				if (ref.timer) clearTimeout(ref.timer);
				_presenceRef.delete(refKey);
				ctx.publish(topic + ':presence', 'leave', { key: userId });
				if (onLeave) {
					Promise.resolve().then(() => onLeave(ctx, topic)).catch(() => {});
				}
				return;
			}

			ref.timer = setTimeout(() => {
				_presenceRef.delete(refKey);
				ctx.publish(topic + ':presence', 'leave', { key: userId });
				if (onLeave) {
					Promise.resolve().then(() => onLeave(ctx, topic)).catch(() => {});
				}
			}, 5000);
		} : undefined
	});

	/** @type {any} */ (roomExport).__isRoom = true;
	/** @type {any} */ (roomExport).__dataStream = dataStream;
	/** @type {any} */ (roomExport).__topicFn = topicFn;
	/** @type {any} */ (roomExport).__hasPresence = !!presenceFn;
	/** @type {any} */ (roomExport).__hasCursors = !!cursorConfig;
	/** @type {any} */ (roomExport).__cursorThrottle = typeof cursorConfig === 'object' ? cursorConfig.throttle || 50 : 50;

	// Presence stream (if enabled)
	if (presenceFn) {
		/** @type {any} */ (roomExport).__presenceStream = live.stream(
			(ctx, ...args) => topicFn(ctx, ...args) + ':presence',
			async (ctx, ...args) => {
				if (guardFn) await guardFn(ctx, ...args);
				const presenceTopic = topicFn(ctx, ...args) + ':presence';
				if (ctx.platform.presence && typeof ctx.platform.presence.list === 'function') {
					return ctx.platform.presence.list(presenceTopic);
				}
				return [];
			},
			{ merge: 'presence' }
		);
	}

	// Cursor stream (if enabled)
	if (cursorConfig) {
		/** @type {any} */ (roomExport).__cursorStream = live.stream(
			(ctx, ...args) => topicFn(ctx, ...args) + ':cursors',
			async (ctx, ...args) => {
				if (guardFn) await guardFn(ctx, ...args);
				return [];
			},
			{ merge: 'cursor' }
		);
	}

	// Room-scoped actions
	if (actions) {
		/** @type {any} */ (roomExport).__actions = {};
		for (const [name, fn] of Object.entries(actions)) {
			if (!_validSegmentRe.test(name)) {
				if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
					console.warn(`[svelte-realtime] Room action '${name}' contains invalid characters (only a-z, A-Z, 0-9, _ allowed) -- skipped\n  See: https://svti.me/rooms`);
				}
				continue;
			}
			const wrappedAction = live(async function roomAction(ctx, ...args) {
				if (guardFn) await guardFn(ctx, ...args);
				const roomArgs = args.slice(0, _roomArgCount);
				const roomTopic = _callTopicFn(topicFn, ctx, roomArgs);
				const originalPublish = ctx.publish;
				ctx.publish = (event, data) => originalPublish(roomTopic, event, data);
				try {
					return await fn(ctx, ...args);
				} finally {
					ctx.publish = originalPublish;
				}
			});
			/** @type {any} */ (wrappedAction).__wrappedFn = fn;
			/** @type {any} */ (roomExport).__actions[name] = wrappedAction;
		}
	}

	// Convenience .hooks property for one-liner wiring in hooks.ws.js:
	// export const { subscribe, unsubscribe, message, close } = myRoom.hooks;
	/** @type {any} */ (roomExport).hooks = {
		message(ws, ctx) {
			handleRpc(ws, ctx.data, ctx.platform);
		},
		close(ws, ctx) {
			close(ws, ctx);
		},
		unsubscribe: unsubscribe
	};

	return roomExport;
};

/** @type {{ rpcCount?: any, rpcDuration?: any, rpcErrors?: any, streamGauge?: any, cronCount?: any, cronErrors?: any } | null} */
let _metricsInstruments = null;

/** Valid pressure reasons accepted in admission rules. Mirrors the adapter's PressureReason enum. */
const _PRESSURE_REASONS = new Set(['NONE', 'PUBLISH_RATE', 'SUBSCRIBERS', 'MEMORY']);

/** @type {{ classes: Record<string, string[] | ((snapshot: any) => boolean)> } | null} */
let _admissionConfig = null;

/**
 * Configure pressure-aware admission control. Each named class maps to
 * either an array of pressure reasons (shed when `platform.pressure.reason`
 * is in the array) or a `(snapshot) => boolean` predicate (shed when truthy).
 *
 * Once configured, `ctx.shed(className)` evaluates the rule against the
 * current `platform.pressure` snapshot, and any `live.stream({ classOfService })`
 * auto-rejects new subscribes under matching pressure with `OVERLOADED`.
 *
 * Pass `null` to clear (tests).
 *
 * Zero overhead when never called: `ctx.shed` returns `false` and
 * `classOfService` is a no-op.
 *
 * @param {{ classes: Record<string, string[] | ((snapshot: any) => boolean)> } | null} config
 */
live.admission = function admission(config) {
	if (config === null || config === undefined) { _admissionConfig = null; return; }
	if (typeof config !== 'object') {
		throw new Error('[svelte-realtime] live.admission: config must be an object or null');
	}
	if (!config.classes || typeof config.classes !== 'object') {
		throw new Error('[svelte-realtime] live.admission: config.classes must be an object');
	}
	const classes = {};
	for (const [name, rule] of Object.entries(config.classes)) {
		if (Array.isArray(rule)) {
			for (const r of rule) {
				if (!_PRESSURE_REASONS.has(r)) {
					throw new Error(
						`[svelte-realtime] live.admission: class '${name}' has unknown pressure reason '${r}'. ` +
						`Valid: ${[..._PRESSURE_REASONS].join(', ')}`
					);
				}
			}
			classes[name] = rule;
		} else if (typeof rule === 'function') {
			classes[name] = rule;
		} else {
			throw new Error(
				`[svelte-realtime] live.admission: class '${name}' must be an array of pressure reasons or a (snapshot) => boolean predicate`
			);
		}
	}
	_admissionConfig = { classes };
};

/**
 * Reset the admission configuration. Tests only.
 * @internal
 */
export function _resetAdmission() {
	_admissionConfig = null;
}

/**
 * Evaluate whether a request of the given class should be shed under
 * current pressure. Returns `true` to shed, `false` to admit.
 *
 * - No admission configured -> always admit.
 * - No `platform.pressure` snapshot -> always admit (no signal to act on).
 * - Class not configured -> throws (typo defense).
 *
 * @param {any} platform
 * @param {string} className
 * @returns {boolean}
 */
function _shouldShed(platform, className) {
	if (!_admissionConfig) return false;
	const rule = _admissionConfig.classes[className];
	if (rule === undefined) {
		const known = Object.keys(_admissionConfig.classes).join(', ') || '<none>';
		throw new Error(`[svelte-realtime] ctx.shed: unknown class '${className}'. Configured: ${known}`);
	}
	const snapshot = platform && platform.pressure;
	if (!snapshot) return false;
	if (typeof rule === 'function') return !!rule(snapshot);
	return rule.includes(snapshot.reason);
}

/**
 * Opt-in Prometheus metrics integration.
 * Accepts a MetricsRegistry from `svelte-adapter-uws-extensions/prometheus`
 * and instruments RPC calls, stream subscriptions, and cron executions.
 *
 * Zero overhead if never called.
 *
 * @param {any} registry - A MetricsRegistry instance with counter(), histogram(), gauge()
 */
live.metrics = function metrics(registry) {
	_metricsInstruments = {
		rpcCount: registry.counter({ name: 'svelte_realtime_rpc_total', help: 'Total RPC calls', labelNames: ['path', 'status'] }),
		rpcDuration: registry.histogram({ name: 'svelte_realtime_rpc_duration_seconds', help: 'RPC call duration', labelNames: ['path'] }),
		rpcErrors: registry.counter({ name: 'svelte_realtime_rpc_errors_total', help: 'Total RPC errors', labelNames: ['path', 'code'] }),
		streamGauge: registry.gauge({ name: 'svelte_realtime_stream_subscriptions', help: 'Active stream subscriptions' }),
		cronCount: registry.counter({ name: 'svelte_realtime_cron_total', help: 'Total cron executions', labelNames: ['path', 'status'] }),
		cronErrors: registry.counter({ name: 'svelte_realtime_cron_errors_total', help: 'Total cron errors', labelNames: ['path'] })
	};
};

/**
 * Wrap a stream initFn call with a circuit breaker.
 * When the breaker is open, returns the fallback value or throws SERVICE_UNAVAILABLE.
 *
 * @param {{ breaker: any, fallback?: any }} options
 * @param {Function} fn - The stream initFn
 * @returns {Function}
 */
live.breaker = function breaker(options, fn) {
	const { breaker: cb, fallback } = options;
	const wrapper = async function breakerWrapper(ctx, ...args) {
		if (cb.isOpen && cb.isOpen()) {
			if (fallback !== undefined) return typeof fallback === 'function' ? fallback() : fallback;
			throw new LiveError('SERVICE_UNAVAILABLE', 'Service temporarily unavailable (circuit open)');
		}
		try {
			const result = await fn(ctx, ...args);
			if (cb.success) cb.success();
			return result;
		} catch (err) {
			if (cb.failure) cb.failure();
			throw err;
		}
	};
	_copyStreamMeta(wrapper, fn);
	return wrapper;
};

/**
 * Register a derived stream. Called by the Vite-generated registry module.
 * @param {string} path
 * @param {Function} fn
 */
export function __registerDerived(path, fn) {
	if (/** @type {any} */ (fn).__lazy) {
		_lazyQueue.push({ type: 'derived', path, loader: fn });
		_hasDynamicDerived = true;
		return;
	}

	if (/** @type {any} */ (fn).__derivedDynamic) {
		const sourceFactory = /** @type {any} */ (fn).__derivedSourceFactory;
		const debounce = /** @type {any} */ (fn).__derivedDebounce || 0;

		/** @type {Map<string, any[]>} */
		const topicArgs = new Map();
		const topicFn = (...args) => {
			const t = path + '~' + args.map(a => String(a).replace(/~/g, '')).join('~');
			topicArgs.set(t, args);
			if (topicArgs.size > 10000) {
				const iter = topicArgs.keys();
				topicArgs.delete(iter.next().value);
			}
			return t;
		};
		/** @type {any} */ (topicFn).__topicUsesCtx = false;
		/** @type {any} */ (fn).__streamTopic = topicFn;
		/** @type {any} */ (fn).__derivedTopicArgs = topicArgs;

		const entry = {
			sources: null, sourceFactory, fn, topic: topicFn,
			debounce, timer: null, dynamic: true, instances: new Map()
		};
		derivedRegistry.set(path, entry);
		_dynamicDerivedByFn.set(fn, entry);
		_hasDynamicDerived = true;
		return;
	}

	/** @type {any} */ (fn).__streamTopic = path;
	const sources = /** @type {any} */ (fn).__derivedSources;
	const debounce = /** @type {any} */ (fn).__derivedDebounce || 0;
	if (!sources) return;
	derivedRegistry.set(path, { sources, fn, topic: path, debounce, timer: null });
	for (const src of sources) {
		let set = _derivedBySource.get(src);
		if (!set) { set = new Set(); _derivedBySource.set(src, set); }
		set.add(derivedRegistry.get(path));
		_watchedTopics.add(src);
	}
}

/**
 * Activate derived stream listeners. Call after platform is available.
 * Source topics are watched via a simple polling mechanism or should be
 * triggered externally when the platform fires publish.
 * @param {import('svelte-adapter-uws').Platform} platform
 */
/** @type {WeakSet<object>} Guard against double-wrapping platform.publish during HMR */
const _activatedPlatforms = new WeakSet();

export function _activateDerived(platform) {
	_derivedPlatform = platform;
	_activateDerivedCalled = true;
	if (_activatedPlatforms.has(platform)) return;

	// Only wrap platform.publish if there are actual reactive registrations
	if (_derivedBySource.size === 0 && _effectBySource.size === 0 && _aggregateBySource.size === 0 && !_hasDynamicDerived) {
		return;
	}

	_activatedPlatforms.add(platform);
	_wrapPlatformPublish(platform);
}

function _wrapPlatformPublish(platform) {

	const originalPublish = platform.publish.bind(platform);

	let _publishDepth = 0;

	platform.publish = function derivedPublish(topic, event, data, opts) {
		const result = originalPublish(topic, event, data, opts);

		if (!_watchedTopics.has(topic)) return result;

		// Guard against infinite recursion (aggregate publishes back through this wrapper)
		if (_publishDepth > 8) return result;
		_publishDepth++;

		// Check if any derived stream watches this topic
		const derivedEntries = _derivedBySource.get(topic);
		if (derivedEntries) {
			for (const entry of derivedEntries) {
				if (entry.debounce > 0) {
					if (entry.timer) clearTimeout(entry.timer);
					entry.timer = setTimeout(() => {
						entry.timer = null;
						_recomputeDerived(entry, platform);
					}, entry.debounce);
				} else {
					_recomputeDerived(entry, platform);
				}
			}
		}

		// Fire matching effects
		const effectEntries = _effectBySource.get(topic);
		if (effectEntries) {
			for (const entry of effectEntries) {
				if (entry.debounce > 0) {
					if (entry.timer) clearTimeout(entry.timer);
					entry.timer = setTimeout(() => {
						entry.timer = null;
						_fireEffect(entry, event, data, platform);
					}, entry.debounce);
				} else {
					// Fire-and-forget: don't block the publish path
					Promise.resolve().then(() => _fireEffect(entry, event, data, platform));
				}
			}
		}

		// Run matching aggregates
		const aggregateEntries = _aggregateBySource.get(topic);
		if (aggregateEntries) {
			for (const entry of aggregateEntries) {
				// Apply reducers
				for (const [field, reducer] of entry._reducerEntries) {
					if (reducer.reduce) {
						entry.state[field] = reducer.reduce(entry.state[field], event, data);
					}
				}

				const computed = _computeAggregateState(entry.state, entry.reducers);

				if (entry.debounce > 0) {
					if (entry.timer) clearTimeout(entry.timer);
					entry.timer = setTimeout(() => {
						entry.timer = null;
						platform.publish(entry.topic, 'set', computed);
					}, entry.debounce);
				} else {
					platform.publish(entry.topic, 'set', computed);
				}
			}
		}

		_publishDepth--;
		return result;
	};
}

/**
 * Recompute a derived stream and publish the result.
 * For dynamic instances, entry.args holds the runtime args and a ctx is built from the platform.
 * @param {{ fn: Function, topic: string, args?: any[] }} entry
 * @param {import('svelte-adapter-uws').Platform} platform
 */
async function _recomputeDerived(entry, platform) {
	try {
		let result;
		if (entry.args) {
			const _h = _getCtxHelpers(platform);
			const ctx = _buildCtx(entry.user || null, null, platform, _h, null);
			result = await entry.fn(ctx, ...entry.args);
		} else {
			result = await entry.fn();
		}
		platform.publish(entry.topic, 'set', result);
	} catch (err) {
		if (_serverErrorHandler) {
			try { _serverErrorHandler('derived', err); } catch {}
		} else if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
			console.error(`[svelte-realtime] Derived stream '${entry.topic}' error:`, err);
		}
	}
}

/**
 * Activate a dynamic derived instance for a resolved topic.
 * Wires the instance's resolved sources into _derivedBySource so publishes trigger recomputation.
 * @param {Function} fn - The derived compute function
 * @param {string} resolvedTopic - The resolved output topic (e.g. '__derived:5:org_123')
 * @param {any} [user] - The subscribing client's user data, used for ctx during recomputation
 */
function _activateDynamicDerived(fn, resolvedTopic, user) {
	const entry = _dynamicDerivedByFn.get(fn);
	if (!entry) return;

	const existing = entry.instances.get(resolvedTopic);
	if (existing) {
		existing.refCount++;
		return;
	}

	// Late activation: if _activateDerived returned early before dynamic entries existed,
	// wrap platform.publish now that we have something to watch.
	if (_derivedPlatform && !_activatedPlatforms.has(_derivedPlatform)) {
		_activatedPlatforms.add(_derivedPlatform);
		_wrapPlatformPublish(_derivedPlatform);
	}

	const topicArgs = /** @type {any} */ (fn).__derivedTopicArgs;
	const args = topicArgs && topicArgs.get(resolvedTopic);
	if (!args) return;

	const resolvedSources = entry.sourceFactory(...args);
	if (!Array.isArray(resolvedSources) || resolvedSources.length === 0) {
		if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
			console.warn(`[svelte-realtime] Dynamic derived sourceFactory returned empty sources for topic '${resolvedTopic}'`);
		}
		return;
	}

	const instance = {
		fn: entry.fn,
		args,
		topic: resolvedTopic,
		resolvedSources,
		debounce: entry.debounce,
		timer: null,
		refCount: 1,
		user: user || null
	};

	entry.instances.set(resolvedTopic, instance);

	for (const src of resolvedSources) {
		let set = _derivedBySource.get(src);
		if (!set) { set = new Set(); _derivedBySource.set(src, set); }
		set.add(instance);
		_watchedTopics.add(src);
	}
}

/**
 * Deactivate a dynamic derived instance when the last subscriber disconnects.
 * Removes the instance from _derivedBySource and cleans up.
 * @param {Function} fn - The derived compute function
 * @param {string} resolvedTopic - The resolved output topic
 */
function _deactivateDynamicDerived(fn, resolvedTopic) {
	const entry = _dynamicDerivedByFn.get(fn);
	if (!entry) return;

	const instance = entry.instances.get(resolvedTopic);
	if (!instance) return;

	instance.refCount--;
	if (instance.refCount > 0) return;

	if (instance.timer) clearTimeout(instance.timer);

	for (const src of instance.resolvedSources) {
		const set = _derivedBySource.get(src);
		if (set) {
			set.delete(instance);
			if (set.size === 0) {
				_derivedBySource.delete(src);
				if (!_effectBySource.has(src) && !_aggregateBySource.has(src)) {
					_watchedTopics.delete(src);
				}
			}
		}
	}

	entry.instances.delete(resolvedTopic);
	const topicArgs = /** @type {any} */ (fn).__derivedTopicArgs;
	if (topicArgs) topicArgs.delete(resolvedTopic);
}

/**
 * Fire an effect handler. Errors are caught and routed to the error handler.
 * @param {{ fn: Function }} entry
 * @param {string} event
 * @param {any} data
 * @param {import('svelte-adapter-uws').Platform} platform
 */
async function _fireEffect(entry, event, data, platform) {
	try {
		await entry.fn(event, data, platform);
	} catch (err) {
		if (_serverErrorHandler) {
			try { _serverErrorHandler('effect', err); } catch {}
		} else if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
			console.error('[svelte-realtime] Effect error:', err);
		}
	}
}

/**
 * Register a cron job. Called by the Vite-generated registry module.
 * @param {string} path
 * @param {Function} fn
 */
export function __registerCron(path, fn) {
	if (/** @type {any} */ (fn).__lazy) {
		_lazyQueue.push({ type: 'cron', path, loader: fn });
		_ensureCronInterval();
		return;
	}
	const parsed = /** @type {any} */ (fn).__cronParsed;
	const topic = /** @type {any} */ (fn).__cronTopic;
	if (!parsed || !topic) return;
	cronRegistry.set(path, { schedule: parsed, fn, topic });
	_ensureCronInterval();
}

/**
 * Capture a platform reference for cron jobs.
 * Call this in your `open` hook or pass to `handleRpc`.
 * @param {import('svelte-adapter-uws').Platform} platform
 */
export function setCronPlatform(platform) {
	_cronPlatform = platform;
}

/** @type {ReturnType<typeof setTimeout> | null} */
let _cronStartupTimer = null;

function _ensureCronInterval() {
	if (_cronInterval) return;
	// Set sentinel immediately to prevent duplicate timers from concurrent calls
	_cronInterval = /** @type {any} */ (-1);
	_cronInterval = setInterval(_tickCron, 60000);
	// Run an initial tick after a short delay to catch jobs on startup
	_cronStartupTimer = setTimeout(_tickCron, 1000);
}

/**
 * Queue of deferred registrations for cron/derived/effect/aggregate/room-actions.
 * Populated when lazy loaders are passed to __registerCron, __registerDerived, etc.
 * Resolved on first RPC call or cron tick via _resolveAllLazy().
 * @type {Array<{ type: string, path: string, loader: Function }>}
 */
const _lazyQueue = [];

/** @type {Promise<void> | null} */
let _lazyInitPromise = null;

/** @type {boolean} Set to true once all lazy entries have been resolved */
let _lazyResolved = false;

/**
 * Resolve all deferred (lazy) cron/derived/effect/aggregate/room-action registrations.
 * Safe to call multiple times -- only the first call does work, concurrent callers
 * await the same promise.
 */
async function _resolveAllLazy() {
	if (_lazyResolved) return;
	if (_lazyInitPromise) return _lazyInitPromise;
	if (_lazyQueue.length === 0) { _lazyResolved = true; return; }
	_lazyInitPromise = (async () => {
		const queue = _lazyQueue.splice(0);
		for (const { type, path, loader } of queue) {
			try {
				const fn = await loader();
				if (!fn) continue;
				switch (type) {
					case 'cron':
						__registerCron(path, fn);
						break;
					case 'derived':
						__register(path, fn);
						__registerDerived(path, fn);
						break;
					case 'effect':
						__registerEffect(path, fn);
						break;
					case 'aggregate':
						__register(path, fn);
						__registerAggregate(path, fn);
						break;
					case 'room-actions': {
						const modulePath = path.substring(0, path.lastIndexOf('/'));
						if (/** @type {any} */ (fn).__actions) {
							for (const [k, v] of Object.entries(/** @type {any} */ (fn).__actions)) {
								if (_validSegmentRe.test(k)) {
									__register(path + '/__action/' + k, v, modulePath);
								}
							}
						}
						break;
					}
				}
			} catch (err) {
				console.error(`[svelte-realtime] Failed to resolve lazy registration for '${path}':`, err);
			}
		}
		_lazyResolved = true;
	})();
	return _lazyInitPromise;
}

/**
 * Register room actions lazily. Called by the Vite-generated registry module
 * when a live.room() export needs its __actions registered.
 * @param {string} basePath
 * @param {Function} loader - Lazy loader that resolves to the room export
 */
export function __registerRoomActions(basePath, loader) {
	_lazyQueue.push({ type: 'room-actions', path: basePath, loader });
}

/**
 * Clear all cron timers. Called during HMR to prevent orphan intervals.
 */
export function _clearCron() {
	if (_cronInterval) {
		clearInterval(_cronInterval);
		_cronInterval = null;
	}
	if (_cronStartupTimer) {
		clearTimeout(_cronStartupTimer);
		_cronStartupTimer = null;
	}
	cronRegistry.clear();
}

/**
 * Snapshot and clear all registries for HMR. Returns a snapshot that can be
 * passed to `_restoreHmr()` if the re-import fails, so old handlers survive
 * a syntax error in the edited file.
 * @returns {object}
 */
export function _prepareHmr() {
	const snap = {
		registry: new Map(registry),
		guards: new Map(guards),
		cron: new Map(cronRegistry),
		derived: new Map(derivedRegistry),
		effects: new Map(effectRegistry),
		aggregates: new Map(aggregateRegistry),
		hadCron: _cronInterval !== null,
	};

	// Clear debounce timers
	for (const e of derivedRegistry.values()) {
		if (e.timer) clearTimeout(e.timer);
		if (e.instances) {
			for (const inst of e.instances.values()) { if (inst.timer) clearTimeout(inst.timer); }
		}
	}
	for (const e of effectRegistry.values()) { if (e.timer) clearTimeout(e.timer); }
	for (const e of aggregateRegistry.values()) { if (e.timer) clearTimeout(e.timer); }

	// Clear orphaned throttle/debounce timers to prevent stale platform.publish refs
	for (const [, entry] of _throttles) clearTimeout(entry.timer);
	_throttles.clear();
	for (const [, timer] of _debounces) clearTimeout(timer);
	_debounces.clear();

	// Clear cron timers (but keep _cronPlatform -- it stays valid across HMR)
	_clearCron();

	// Clear lazy queue and reset lazy init state
	_lazyQueue.length = 0;
	_lazyInitPromise = null;
	_lazyResolved = false;

	// Clear all registries and lookup maps
	registry.clear();
	guards.clear();
	derivedRegistry.clear();
	effectRegistry.clear();
	aggregateRegistry.clear();
	_derivedBySource.clear();
	_effectBySource.clear();
	_aggregateBySource.clear();
	_aggregateByTopic.clear();
	_watchedTopics.clear();
	_streamsWithUnsubscribe.clear();
	_hasDynamicDerived = false;
	_dynamicDerivedByFn.clear();
	_activateDerivedCalled = false;
	_warnedActivateDerived = false;

	return snap;
}

/**
 * Restore registries from a snapshot produced by `_prepareHmr()`.
 * Called when re-import fails so the server keeps working with old handlers.
 * @param {object} snap
 */
export function _restoreHmr(snap) {
	for (const [k, v] of snap.registry) {
		registry.set(k, v);
		if (/** @type {any} */ (v).__isStream && /** @type {any} */ (v).__onUnsubscribe) {
			_streamsWithUnsubscribe.add(v);
		}
	}
	for (const [k, v] of snap.guards) guards.set(k, v);

	// Restore cron
	for (const [k, v] of snap.cron) cronRegistry.set(k, v);
	if (snap.hadCron && cronRegistry.size > 0) _ensureCronInterval();

	// Restore derived (rebuild source maps from entries)
	for (const [k, v] of snap.derived) {
		v.timer = null;
		derivedRegistry.set(k, v);
		if (v.dynamic) {
			_hasDynamicDerived = true;
			_dynamicDerivedByFn.set(v.fn, v);
			if (v.instances) {
				for (const inst of v.instances.values()) {
					inst.timer = null;
					for (const src of inst.resolvedSources) {
						let set = _derivedBySource.get(src);
						if (!set) { set = new Set(); _derivedBySource.set(src, set); }
						set.add(inst);
						_watchedTopics.add(src);
					}
				}
			}
		} else {
			for (const src of v.sources) {
				let set = _derivedBySource.get(src);
				if (!set) { set = new Set(); _derivedBySource.set(src, set); }
				set.add(v);
				_watchedTopics.add(src);
			}
		}
	}

	// Restore effects
	for (const [k, v] of snap.effects) {
		v.timer = null;
		effectRegistry.set(k, v);
		for (const src of v.sources) {
			let set = _effectBySource.get(src);
			if (!set) { set = new Set(); _effectBySource.set(src, set); }
			set.add(v);
			_watchedTopics.add(src);
		}
	}

	// Restore aggregates
	for (const [k, v] of snap.aggregates) {
		v.timer = null;
		aggregateRegistry.set(k, v);
		_aggregateByTopic.set(v.topic, v);
		let srcSet = _aggregateBySource.get(v.source);
		if (!srcSet) { srcSet = new Set(); _aggregateBySource.set(v.source, srcSet); }
		srcSet.add(v);
		_watchedTopics.add(v.source);
	}
}

export async function _tickCron() {
	if (!_lazyResolved) await _resolveAllLazy();
	const now = new Date();
	const minute = now.getMinutes();
	const hour = now.getHours();
	const day = now.getDate();
	const month = now.getMonth() + 1;
	const weekday = now.getDay();

	for (const [path, entry] of cronRegistry) {
		const [mf, hf, df, monthf, wf] = entry.schedule;
		if (!_cronFieldMatch(mf, minute)) continue;
		if (!_cronFieldMatch(hf, hour)) continue;
		if (!_cronFieldMatch(df, day)) continue;
		if (!_cronFieldMatch(monthf, month)) continue;
		if (!_cronFieldMatch(wf, weekday)) continue;

		// Match - run the job
		(async () => {
			try {
				if (!_cronPlatform) {
					if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
						console.warn(`[svelte-realtime] Cron '${path}' fired but no platform captured. Call setCronPlatform(platform) in your open hook.\n  See: https://svti.me/cron`);
					}
					return;
				}
				const _h = _getCtxHelpers(_cronPlatform);
				const ctx = _buildCtx(null, null, _cronPlatform, _h, null);
				const result = await entry.fn(ctx);
				if (result !== undefined) {
					_cronPlatform.publish(entry.topic, 'set', result);
				}
				if (_metricsInstruments) _metricsInstruments.cronCount.inc({ path, status: 'ok' });
			} catch (err) {
				if (_metricsInstruments) {
					_metricsInstruments.cronCount.inc({ path, status: 'error' });
					_metricsInstruments.cronErrors.inc({ path });
				}
				if (_serverErrorHandler) {
					_serverErrorHandler(path, err);
				} else if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
					console.error(`[svelte-realtime] Cron '${path}' error:`, err);
				}
			}
		})();
	}
}

/**
 * Parse a 5-field cron expression into an array of field matchers.
 * Supports: *, N, N-M, N,M, and *\/N
 * @param {string} expr
 * @returns {any[]}
 */
function _parseCron(expr) {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(`[svelte-realtime] Invalid cron expression '${expr}' -- expected 5 fields (minute hour day month weekday)\n  See: https://svti.me/cron`);
	}
	return parts.map((field, idx) => _parseCronField(field, idx));
}

/** Max values per cron field index: minute, hour, day, month, weekday */
const _CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

/**
 * Parse a single cron field with validation.
 * Returns null for '*' (match all), or a Set of allowed values,
 * or { step: N } for step expressions.
 * @param {string} field
 * @param {number} idx - Field index (0=minute, 1=hour, 2=day, 3=month, 4=weekday)
 * @returns {any}
 */
function _parseCronField(field, idx) {
	const [min, max] = _CRON_RANGES[idx] || [0, 59];

	if (field === '*') return null;

	if (field.startsWith('*/')) {
		const step = parseInt(field.slice(2), 10);
		if (!Number.isFinite(step) || step < 1) {
			throw new Error(`[svelte-realtime] Invalid cron step '${field}' -- step must be a positive integer\n  See: https://svti.me/cron`);
		}
		return { step };
	}

	if (field.includes('-') && !field.includes(',')) {
		const parts = field.split('-');
		const a = parseInt(parts[0], 10);
		const b = parseInt(parts[1], 10);
		if (!Number.isFinite(a) || !Number.isFinite(b) || a < min || b > max || a > b) {
			throw new Error(`[svelte-realtime] Invalid cron range '${field}' -- values must be ${min}-${max}\n  See: https://svti.me/cron`);
		}
		const vals = new Set();
		for (let i = a; i <= b; i++) vals.add(i);
		return vals;
	}

	if (field.includes(',')) {
		const nums = field.split(',').map(s => {
			const n = parseInt(s, 10);
			if (!Number.isFinite(n) || n < min || n > max) {
				throw new Error(`[svelte-realtime] Invalid cron value '${s}' in '${field}' -- must be ${min}-${max}\n  See: https://svti.me/cron`);
			}
			return n;
		});
		return new Set(nums);
	}

	const n = parseInt(field, 10);
	if (!Number.isFinite(n) || n < min || n > max) {
		throw new Error(`[svelte-realtime] Invalid cron value '${field}' -- must be ${min}-${max}\n  See: https://svti.me/cron`);
	}
	return new Set([n]);
}

/**
 * Check if a value matches a cron field matcher.
 * @param {any} matcher
 * @param {number} value
 * @returns {boolean}
 */
function _cronFieldMatch(matcher, value) {
	if (matcher === null) return true; // * matches all
	if (matcher.step) return value % matcher.step === 0;
	return matcher.has(value);
}

/**
 * Create a webhook-to-stream bridge.
 * The Vite plugin detects `live.webhook()` exports and generates a SvelteKit `+server.js` endpoint.
 *
 * @param {string} topic - Topic to publish events to
 * @param {{ verify: (req: { body: string, headers: Record<string, string> }) => any, transform: (event: any) => { event: string, data: any } | null }} config
 * @returns {any}
 */
live.webhook = function webhook(topic, config) {
	const handler = {
		__isWebhook: true,
		__webhookTopic: topic,
		__verify: config.verify,
		__transform: config.transform,

		/**
		 * Handle an incoming webhook request.
		 * Call this from a SvelteKit +server.js POST handler.
		 *
		 * @param {{ body: string, headers: Record<string, string>, platform: any }} req
		 * @returns {{ status: number, body?: string }}
		 */
		async handle(req) {
			let event;
			try {
				event = config.verify({ body: req.body, headers: req.headers });
			} catch {
				return { status: 400, body: 'Verification failed' };
			}

			const mapped = config.transform(event);
			if (!mapped) return { status: 200, body: 'Ignored' };

			if (req.platform) {
				req.platform.publish(topic, mapped.event, mapped.data);
			}
			return { status: 200, body: 'OK' };
		}
	};

	return handler;
};

/**
 * Create a per-module guard. Accepts middleware functions (variadic) and/or
 * a single declarative options object as the first argument:
 *
 * - `{ authenticated: true }` -- throws UNAUTHENTICATED unless `ctx.user`
 *   is non-null. Cheaper to write than the equivalent function and harder
 *   to forget.
 *
 * Function-style middleware composes: `guard({ authenticated: true }, customCheck)`
 * runs the auth check first, then `customCheck(ctx)`. If any throws, the
 * chain stops. Bare-error throws are auto-classified to LiveError
 * (UNAUTHENTICATED if no user, FORBIDDEN otherwise) at the call site.
 *
 * @param {...(Function | { authenticated?: boolean })} parts
 * @returns {Function}
 */
export function guard(...parts) {
	const fns = [];
	for (const part of parts) {
		if (typeof part === 'function') {
			fns.push(part);
			continue;
		}
		if (part && typeof part === 'object') {
			if (part.authenticated === true) {
				fns.push(_guardAuthenticated);
			}
			continue;
		}
		throw new Error('[svelte-realtime] guard() accepts middleware functions or an options object');
	}
	if (fns.length === 0) {
		throw new Error('[svelte-realtime] guard() requires at least one function or option');
	}
	if (fns.length === 1) {
		/** @type {any} */ (fns[0]).__isGuard = true;
		return fns[0];
	}
	const composite = async (ctx) => {
		for (const fn of fns) {
			await fn(ctx);
		}
	};
	/** @type {any} */ (composite).__isGuard = true;
	return composite;
}

async function _guardAuthenticated(ctx) {
	if (!ctx || ctx.user == null) {
		throw new LiveError('UNAUTHENTICATED', 'Authentication required');
	}
}

/**
 * Run a per-module guard with auto-classification of non-LiveError throws.
 *
 * - LiveError thrown by the guard -> propagated as-is (caller-controlled
 *   code AND message reach the client).
 * - Bare Error / non-Error thrown -> wrapped as
 *   `LiveError(UNAUTHENTICATED, 'Authentication required')` when
 *   `ctx.user` is null, otherwise `LiveError(FORBIDDEN, 'Access denied')`.
 *   The original error is preserved on `.cause` for server-side logging
 *   but is NOT propagated to the client (avoids accidentally leaking
 *   internal details like a DB error message through a guard).
 *
 * Net: a guard can `throw new Error('whatever')` and the client sees a
 * 4xx-class typed error instead of `INTERNAL_ERROR` (5xx), without any
 * raw error text reaching the wire. To surface a specific reason, throw
 * `new LiveError('FORBIDDEN', 'Account suspended')` directly.
 *
 * @param {Function} guardFn
 * @param {any} ctx
 */
async function _runGuard(guardFn, ctx) {
	try {
		await guardFn(ctx);
	} catch (err) {
		if (err instanceof LiveError) throw err;
		const code = ctx && ctx.user ? 'FORBIDDEN' : 'UNAUTHENTICATED';
		const msg = code === 'UNAUTHENTICATED' ? 'Authentication required' : 'Access denied';
		const wrapped = new LiveError(code, msg);
		/** @type {any} */ (wrapped).cause = err;
		throw wrapped;
	}
}

/**
 * Typed error that propagates code to the client.
 */
export class LiveError extends Error {
	/**
	 * @param {string} code
	 * @param {string} [message]
	 */
	constructor(code, message) {
		super(message || code);
		this.code = code;
	}
}

/**
 * Check whether a raw WebSocket message is an RPC request and handle it.
 *
 * @param {any} ws
 * @param {ArrayBuffer} data - Raw message data from the adapter message hook
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: (ws: any, rpcPath: string, args: any[]) => Promise<void> | void, onError?: (path: string, error: unknown, ctx: any) => void }} [options]
 * @returns {boolean} true if the message was an RPC request
 */
export function handleRpc(ws, data, platform, options) {
	// Auto-capture platform for cron jobs
	if (!_cronPlatform && cronRegistry.size > 0) _cronPlatform = platform;

	// Fast path: only process ArrayBuffer
	if (!(data instanceof ArrayBuffer) || data.byteLength < 4) return false;
	const bytes = new Uint8Array(data);

	// Binary RPC: byte[0] = 0x00, byte[1-2] = header length (uint16 BE)
	if (bytes[0] === 0x00 && data.byteLength > 3) {
		const headerLen = (bytes[1] << 8) | bytes[2];
		if (headerLen > 0 && 3 + headerLen <= data.byteLength) {
			try {
				const headerJson = textDecoder.decode(data.slice(3, 3 + headerLen));
				const header = JSON.parse(headerJson);
				if (typeof header.rpc === 'string' && typeof header.id === 'string') {
					const payload = data.slice(3 + headerLen);
					_executeBinaryRpc(ws, header, payload, platform, options);
					return true;
				}
			} catch (err) {
				if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
					console.warn('[svelte-realtime] Failed to parse binary RPC header:', err, '\n  See: https://svti.me/binary');
				}
			}
		}
		return false;
	}

	// Text RPC: must start with {"r or {"b
	if (data.byteLength < 10) return false;
	// byte[0] = '{' (0x7B), byte[1] = '"' (0x22)
	if (bytes[0] !== 0x7B) return false;
	// byte[2] = 'r' (0x72) for RPC, or 'b' (0x62) for batch
	if (bytes[2] !== 0x72 && bytes[2] !== 0x62) return false;

	/** @type {any} */
	let msg;
	try {
		msg = JSON.parse(textDecoder.decode(data));
	} catch {
		return false;
	}

	// Batch request: {"batch": [...]}
	if (Array.isArray(msg.batch)) {
		_executeBatch(ws, msg, platform, options);
		return true;
	}

	if (typeof msg.rpc !== 'string' || typeof msg.id !== 'string') return false;

	// Validated as RPC - handle asynchronously, return true synchronously
	_executeRpc(ws, msg, platform, options);
	return true;
}

/**
 * @param {any} ws
 * @param {{ rpc: string, id: string, args?: any[], stream?: boolean, seq?: number, version?: any }} msg
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: (ws: any, rpcPath: string, args: any[]) => Promise<void> | void, onError?: (path: string, error: unknown, ctx: any) => void }} [options]
 */
async function _executeRpc(ws, msg, platform, options) {
	const result = await _executeSingleRpc(ws, msg, platform, options);
	_respond(ws, platform, msg.id, result);
}

/**
 * Execute a batch of RPC calls. Supports parallel (default) and sequential modes.
 *
 * @param {any} ws
 * @param {{ batch: Array<{ rpc: string, id: string, args?: any[], stream?: boolean }>, sequential?: boolean }} msg
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: (ws: any, rpcPath: string, args: any[]) => Promise<void> | void, onError?: (path: string, error: unknown, ctx: any) => void }} [options]
 */
async function _executeBatch(ws, msg, platform, options) {
	const { batch, sequential } = msg;
	const _batchMetricsStart = _metricsInstruments ? Date.now() : 0;

	if (batch.length > 50) {
		_recordRpcMetrics('__batch__', 'INVALID_REQUEST', _batchMetricsStart);
		_respond(ws, platform, '__batch', {
			batch: [{ id: '', ok: false, code: 'INVALID_REQUEST', error: 'Batch exceeds maximum of 50 calls' }]
		});
		return;
	}

	/** @type {Array<{ id: string, ok: boolean, data?: any, code?: string, error?: string }>} */
	let results;

	if (sequential) {
		results = new Array(batch.length);
		for (let i = 0; i < batch.length; i++) {
			const call = batch[i];
			if (!call || typeof call.rpc !== 'string' || typeof call.id !== 'string') {
				_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _batchMetricsStart);
				results[i] = { id: call?.id || '', ok: false, code: 'INVALID_REQUEST', error: 'Each batch entry requires rpc and id' };
				continue;
			}
			results[i] = await _executeSingleRpc(ws, call, platform, options);
		}
	} else {
		results = await Promise.all(batch.map((call) => {
			if (!call || typeof call.rpc !== 'string' || typeof call.id !== 'string') {
				_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _batchMetricsStart);
				return { id: call?.id || '', ok: false, code: 'INVALID_REQUEST', error: 'Each batch entry requires rpc and id' };
			}
			return _executeSingleRpc(ws, call, platform, options);
		}));
	}

	_respond(ws, platform, '__batch', { batch: results });
}

/**
 * Execute a single RPC call and return the result (used by batch and single execution).
 *
 * @param {any} ws
 * @param {{ rpc: string, id: string, args?: any[], stream?: boolean }} msg
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: (ws: any, rpcPath: string, args: any[]) => Promise<void> | void, onError?: (path: string, error: unknown, ctx: any) => void }} [options]
 * @returns {Promise<{ id: string, ok: boolean, data?: any, code?: string, error?: string }>}
 */
async function _executeSingleRpc(ws, msg, platform, options) {
	const { rpc: path, id, args: rawArgs, stream: isStream, seq: clientSeq, cursor: clientCursor, schemaVersion: clientSchemaVersion } = msg;
	const _metricsStart = _metricsInstruments ? Date.now() : 0;

	if (!_validPathRe.test(path)) {
		_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _metricsStart);
		return { id, ok: false, code: 'INVALID_REQUEST', error: 'Invalid path' };
	}

	if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
		_recordRpcMetrics(path, 'INVALID_REQUEST', _metricsStart);
		return { id, ok: false, code: 'INVALID_REQUEST', error: 'args must be an array' };
	}

	if (!_lazyResolved) await _resolveAllLazy();

	const args = rawArgs || [];
	const fn = await _resolveRegistryEntry(path);
	if (!fn) {
		if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
			console.warn(`[svelte-realtime] RPC call to '${path}' -- no such live function registered\n  See: https://svti.me/rpc`);
		}
		_recordRpcMetrics(path, 'NOT_FOUND', _metricsStart);
		return { id, ok: false, code: 'NOT_FOUND', error: 'Not found' };
	}

	const _h = _getCtxHelpers(platform);
	const ctx = _buildCtx(ws.getUserData(), ws, platform, _h, clientCursor !== undefined ? clientCursor : null, msg.idempotencyKey);
	let _subscribedStreamTopic = null;

	try {
		const _result = await _runWithMiddleware(ctx, async () => {
		const modulePath = /** @type {any} */ (fn).__modulePath || path.substring(0, path.lastIndexOf('/'));
		const guardFn = await _resolveGuard(modulePath);
		if (guardFn) await _runGuard(guardFn, ctx);

		if (options?.beforeExecute) {
			await options.beforeExecute(ws, path, args);
		}

		if (isStream && /** @type {any} */ (fn).__isStream) {
			// Validate args BEFORE topic resolution -- prevents topic injection
			// via malformed dynamic-topic args (e.g. `audit:${orgId}` with
			// orgId crafted to escape the topic namespace). The validated
			// tuple is bound to a stream-branch-local `let` to keep the
			// outer `args` const for the non-stream path's V8 inline cache.
			let streamArgs = args;
			const argsSchema = /** @type {any} */ (fn).__streamArgs;
			if (argsSchema) {
				const result = _validate(argsSchema, streamArgs);
				if (!result.ok) {
					const err = { id, ok: false, code: 'VALIDATION', error: result.message };
					/** @type {any} */ (err).issues = result.issues;
					return err;
				}
				if (Array.isArray(result.data)) streamArgs = result.data;
			}

			if (/** @type {any} */ (fn).__isGated) {
				const predicate = /** @type {any} */ (fn).__gatePredicate;
				if (!predicate(ctx, ...streamArgs)) {
					return { id, ok: true, data: null, gated: true };
				}
			}

			const rawTopic = /** @type {any} */ (fn).__streamTopic;
			const topic = typeof rawTopic === 'function' ? _callTopicFn(rawTopic, ctx, streamArgs) : rawTopic;
			if (typeof topic === 'string' && topic.startsWith('__')) {
				return { id, ok: false, code: 'INVALID_REQUEST', error: 'Reserved topic prefix' };
			}
			const streamOpts = /** @type {any} */ (fn).__streamOptions;
			const replayOpts = /** @type {any} */ (fn).__replay;

			const streamFilter = /** @type {any} */ (fn).__streamFilter;
			if (streamFilter && !streamFilter(ctx, ...streamArgs)) {
				const code = ctx.user ? 'FORBIDDEN' : 'UNAUTHENTICATED';
				return { id, ok: false, code, error: code === 'UNAUTHENTICATED' ? 'Authentication required' : 'Access denied' };
			}

			const classOfService = /** @type {any} */ (fn).__classOfService;
			if (classOfService && _admissionConfig) {
				try {
					if (_shouldShed(platform, classOfService)) {
						return { id, ok: false, code: 'OVERLOADED', error: `Stream class '${classOfService}' shed under pressure` };
					}
				} catch (err) {
					return { id, ok: false, code: 'INVALID_REQUEST', error: /** @type {Error} */ (err).message };
				}
			}

			try { ws.subscribe(topic); } catch { return { id, ok: false, code: 'CONNECTION_CLOSED', error: 'WebSocket closed' }; }
			_trackStreamSub(ws, topic, fn);
			_subscribedStreamTopic = topic;

			if (/** @type {any} */ (fn).__onSubscribe) {
				try { await /** @type {any} */ (fn).__onSubscribe(ctx, topic); } catch {}
			}

			if (/** @type {any} */ (fn).__isDerived && !_activateDerivedCalled && !_warnedActivateDerived) {
				if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
					_warnedActivateDerived = true;
					console.warn('[svelte-realtime] live.derived() subscribed but _activateDerived(platform) was never called. Derived streams will not receive live updates.\n  Call _activateDerived(platform) in your WebSocket open hook.\n  See: https://svti.me/derived');
				}
			}

			// Channel fast-path
			if (/** @type {any} */ (fn).__isChannel) {
				const emptyValue = streamOpts.merge === 'set' ? null : [];
				return { id, ok: true, data: emptyValue, topic, merge: streamOpts.merge, key: streamOpts.key, max: streamOpts.max, channel: true };
			}

			// Delta sync
			const deltaOpts = /** @type {any} */ (fn).__delta;
			const clientVersion = msg.version;
			if (deltaOpts && clientVersion !== undefined && deltaOpts.version && deltaOpts.diff) {
				try {
					const currentVersion = await deltaOpts.version();
					if (currentVersion === clientVersion) {
						return { id, ok: true, data: [], topic, merge: streamOpts.merge, key: streamOpts.key, prepend: streamOpts.prepend, max: streamOpts.max, unchanged: true, version: currentVersion };
					}
					const diff = await deltaOpts.diff(clientVersion);
					if (diff !== null && diff !== undefined) {
						return { id, ok: true, data: diff, topic, merge: streamOpts.merge, key: streamOpts.key, prepend: streamOpts.prepend, max: streamOpts.max, delta: true, version: currentVersion };
					}
				} catch {}
			}

			// Replay (bounded recent buffer)
			if (replayOpts && typeof clientSeq === 'number' && platform.replay) {
				try {
					const missed = await platform.replay.since(topic, clientSeq);
					if (missed) {
						const currentSeq = await platform.replay.seq(topic);
						return { id, ok: true, data: missed, topic, merge: streamOpts.merge, key: streamOpts.key, prepend: streamOpts.prepend, max: streamOpts.max, seq: currentSeq, replay: true };
					}
				} catch {}
			}

			// Seq-delta (user-provided bridge for older-than-buffer reconnects)
			if (deltaOpts && typeof deltaOpts.fromSeq === 'function' && typeof clientSeq === 'number') {
				try {
					const events = await deltaOpts.fromSeq(clientSeq);
					if (Array.isArray(events)) {
						let respSeq;
						if (events.length > 0) {
							const last = events[events.length - 1];
							if (last && typeof last.seq === 'number') respSeq = last.seq;
						}
						if (respSeq === undefined && platform.replay) {
							try { respSeq = await platform.replay.seq(topic); } catch {}
						}
						const deltaResp = {
							id, ok: true, data: events, topic,
							merge: streamOpts.merge, key: streamOpts.key,
							prepend: streamOpts.prepend, max: streamOpts.max,
							replay: true
						};
						if (respSeq !== undefined) deltaResp.seq = respSeq;
						return deltaResp;
					}
				} catch {}
			}

			const result = await fn(ctx, ...streamArgs);

			const isPaginated = result && typeof result === 'object' && !Array.isArray(result) && 'data' in result && 'hasMore' in result;
			let resultData = isPaginated ? result.data : result;

			// Apply transform to initial data: per-item for arrays
			// (crud/latest/presence/cursor merge), whole-value for non-arrays
			// (set merge). Live-event transforms run separately at publish time.
			const initTransform = /** @type {any} */ (fn).__streamTransform;
			if (initTransform && resultData != null) {
				resultData = _applyInitTransform(initTransform, resultData);
			}

			// Schema migration
			const serverVersion = /** @type {any} */ (fn).__streamVersion;
			const migrateFns = /** @type {any} */ (fn).__streamMigrate;
			if (serverVersion !== undefined && migrateFns && typeof clientSchemaVersion === 'number' && clientSchemaVersion < serverVersion) {
				resultData = _migrateData(resultData, clientSchemaVersion, serverVersion, migrateFns);
			}

			const response = {
				id, ok: true, data: resultData, topic, merge: streamOpts.merge,
				key: streamOpts.key, prepend: streamOpts.prepend, max: streamOpts.max,
				hasMore: undefined, cursor: undefined, seq: undefined,
				version: undefined, schemaVersion: undefined, replay: undefined,
				derived: /** @type {any} */ (fn).__isDerived || undefined
			};

			if (isPaginated) {
				response.hasMore = result.hasMore;
				if (result.cursor !== undefined) response.cursor = result.cursor;
			}
			if (replayOpts && platform.replay) {
				try { response.seq = await platform.replay.seq(topic); } catch {}
			}
			if (typeof clientSeq === 'number') response.replay = false;
			if (deltaOpts && deltaOpts.version) {
				try { response.version = await deltaOpts.version(); } catch {}
			}
			if (serverVersion !== undefined) response.schemaVersion = serverVersion;

			return response;
		} else {
			const result = await fn(ctx, ...args);
			return { id, ok: true, data: result };
		}
		}); // end _runWithMiddleware
		_recordRpcMetrics(path, (_result && _result.ok === false) ? (_result.code || 'UNKNOWN') : '', _metricsStart);
		return _result;
	} catch (err) {
		if (_subscribedStreamTopic) _rollbackStreamSubscribe(ws, _subscribedStreamTopic, fn, ctx);
		_recordRpcMetrics(path, err instanceof LiveError ? err.code : 'INTERNAL_ERROR', _metricsStart);
		if (err instanceof LiveError) {
			/** @type {any} */
			const result = { id, ok: false, code: err.code, error: err.message };
			if (/** @type {any} */ (err).issues) result.issues = /** @type {any} */ (err).issues;
			return result;
		}
		if (options?.onError) {
			try { options.onError(path, err, ctx); } catch {}
		}
		if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
			console.warn(
				`[svelte-realtime] '${path}' threw a non-LiveError:`,
				err,
				'\nUse throw new LiveError(code, message) for client-visible errors. Raw errors are hidden from clients.\n  See: https://svti.me/errors'
			);
			console.error(`[svelte-realtime] Error in '${path}':`, err);
		}
		return { id, ok: false, code: 'INTERNAL_ERROR', error: 'Internal server error' };
	}
}

/**
 * Execute a binary RPC call.
 *
 * @param {any} ws
 * @param {{ rpc: string, id: string, args?: any[] }} header
 * @param {ArrayBuffer} payload - Raw binary data
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ beforeExecute?: Function, onError?: Function }} [options]
 */
async function _executeBinaryRpc(ws, header, payload, platform, options) {
	const { rpc: path, id, args: extraArgs } = header;
	const _metricsStart = _metricsInstruments ? Date.now() : 0;

	if (!_validPathRe.test(path)) {
		_recordRpcMetrics('__invalid__', 'INVALID_REQUEST', _metricsStart);
		_respond(ws, platform, id, { ok: false, code: 'INVALID_REQUEST', error: 'Invalid path' });
		return;
	}

	if (extraArgs !== undefined && !Array.isArray(extraArgs)) {
		_recordRpcMetrics(path, 'INVALID_REQUEST', _metricsStart);
		_respond(ws, platform, id, { ok: false, code: 'INVALID_REQUEST', error: 'args must be an array' });
		return;
	}

	if (!_lazyResolved) await _resolveAllLazy();
	const fn = await _resolveRegistryEntry(path);
	if (!fn) {
		_recordRpcMetrics(path, 'NOT_FOUND', _metricsStart);
		_respond(ws, platform, id, { ok: false, code: 'NOT_FOUND', error: 'Not found' });
		return;
	}

	if (!/** @type {any} */ (fn).__isBinary) {
		_recordRpcMetrics(path, 'INVALID_REQUEST', _metricsStart);
		_respond(ws, platform, id, { ok: false, code: 'INVALID_REQUEST', error: 'Not a binary endpoint' });
		return;
	}

	const maxBinarySize = /** @type {any} */ (fn).__maxBinarySize || 10485760;
	if (payload.byteLength > maxBinarySize) {
		_recordRpcMetrics(path, 'PAYLOAD_TOO_LARGE', _metricsStart);
		_respond(ws, platform, id, { ok: false, code: 'PAYLOAD_TOO_LARGE', error: 'Binary payload exceeds size limit' });
		return;
	}

	const _h = _getCtxHelpers(platform);
	const ctx = _buildCtx(ws.getUserData(), ws, platform, _h, null);

	try {
		await _runWithMiddleware(ctx, async () => {
			const modulePath = /** @type {any} */ (fn).__modulePath || path.substring(0, path.lastIndexOf('/'));
			const guardFn = await _resolveGuard(modulePath);
			if (guardFn) await _runGuard(guardFn, ctx);

			if (options?.beforeExecute) {
				await options.beforeExecute(ws, path, [payload, ...(extraArgs || [])]);
			}

			const result = await fn(ctx, payload, ...(extraArgs || []));
			_respond(ws, platform, id, { ok: true, data: result });
		});
		_recordRpcMetrics(path, '', _metricsStart);
	} catch (err) {
		_recordRpcMetrics(path, err instanceof LiveError ? err.code : 'INTERNAL_ERROR', _metricsStart);
		if (err instanceof LiveError) {
			_respond(ws, platform, id, { ok: false, code: err.code, error: err.message });
		} else {
			if (options?.onError) {
				try { options.onError(path, err, ctx); } catch {}
			}
			if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
				console.error(`[svelte-realtime] Error in binary '${path}':`, err);
			}
			_respond(ws, platform, id, { ok: false, code: 'INTERNAL_ERROR', error: 'Internal server error' });
		}
	}
}

/**
 * Run global middleware chain, then call `handler`.
 * If no middleware is registered, calls handler directly (zero overhead).
 * @param {any} ctx
 * @param {() => Promise<any>} handler
 * @returns {Promise<any>}
 */
function _runWithMiddleware(ctx, handler) {
	if (_globalMiddleware.length === 0) return handler();

	let idx = 0;
	function next() {
		if (idx < _globalMiddleware.length) {
			return _globalMiddleware[idx++](ctx, next);
		}
		return handler();
	}
	return next();
}

// -- Throttle / Debounce infrastructure ----------------------------------------

/** Hard cap on throttle/debounce entries to prevent memory exhaustion */
const _THROTTLE_DEBOUNCE_MAX = 5000;

/** @type {Map<string, { timer: ReturnType<typeof setTimeout>, lastData: any, lastEvent: string, platform: any, lastRun: number }>} */
const _throttles = new Map();

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const _debounces = new Map();

/**
 * Throttle a publish to a topic. Sends at most once per `ms` milliseconds.
 * The last value always arrives (trailing edge).
 *
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {string} topic
 * @param {string} event
 * @param {any} data
 * @param {number} ms - Throttle interval in milliseconds
 */
function _throttlePublish(platform, topic, event, data, ms) {
	const entityKey = data && typeof data === 'object' && data.key !== undefined ? '\0' + data.key : '';
	const key = topic + '\0' + event + entityKey;
	const existing = _throttles.get(key);
	const now = Date.now();

	if (!existing) {
		if (_throttles.size >= _THROTTLE_DEBOUNCE_MAX) {
			// At capacity -- publish immediately without a trailing-edge timer
			// so data is never silently dropped
			platform.publish(topic, event, data);
			return;
		}
		platform.publish(topic, event, data);
		_throttles.set(key, {
			timer: setTimeout(() => {
				const entry = _throttles.get(key);
				if (entry && entry.lastData !== undefined) {
					platform.publish(topic, event, entry.lastData);
				}
				_throttles.delete(key);
			}, ms),
			lastData: undefined,
			lastEvent: event,
			lastRun: now
		});
		return;
	}

	// Subsequent calls within the window -- store for trailing edge
	existing.lastData = data;
	existing.lastEvent = event;
}

/**
 * Debounce a publish to a topic. Only sends after `ms` milliseconds of silence.
 *
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {string} topic
 * @param {string} event
 * @param {any} data
 * @param {number} ms - Debounce interval in milliseconds
 */
function _debouncePublish(platform, topic, event, data, ms) {
	const entityKey = data && typeof data === 'object' && data.key !== undefined ? '\0' + data.key : '';
	const key = topic + '\0' + event + entityKey;
	const existing = _debounces.get(key);
	if (existing) clearTimeout(existing);

	if (!existing && _debounces.size >= _THROTTLE_DEBOUNCE_MAX) {
		// At capacity -- publish immediately instead of evicting an active timer
		platform.publish(topic, event, data);
		return;
	}

	_debounces.set(key, setTimeout(() => {
		_debounces.delete(key);
		platform.publish(topic, event, data);
	}, ms));
}

/**
 * Send an RPC response to a single client.
 * @param {any} ws
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {string} correlationId
 * @param {Record<string, any>} payload
 */
/**
 * Apply schema migration functions to data.
 * Chains migrations from clientVersion to serverVersion.
 * @param {any} data
 * @param {number} fromVersion
 * @param {number} toVersion
 * @param {Record<number, (item: any) => any>} migrateFns
 * @returns {any}
 */
function _migrateData(data, fromVersion, toVersion, migrateFns) {
	if (Array.isArray(data)) {
		return data.map(item => _migrateItem(item, fromVersion, toVersion, migrateFns));
	}
	return _migrateItem(data, fromVersion, toVersion, migrateFns);
}

/**
 * Apply chained migrations to a single item.
 * @param {any} item
 * @param {number} fromVersion
 * @param {number} toVersion
 * @param {Record<number, (item: any) => any>} migrateFns
 * @returns {any}
 */
function _migrateItem(item, fromVersion, toVersion, migrateFns) {
	let result = item;
	for (let v = fromVersion; v < toVersion; v++) {
		const fn = migrateFns[v];
		if (fn) {
			result = fn(result);
		} else if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
			console.warn(`[svelte-realtime] Missing migration function for version ${v} -> ${v + 1}\n  See: https://svti.me/schema`);
		}
	}
	return result;
}

function _respond(ws, platform, correlationId, payload) {
	if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
		// Estimate size without double-serialization.
		const data = payload.data;
		if ((Array.isArray(data) && data.length > 100) || (typeof data === 'string' && data.length > 12000)) {
			console.warn(
				`[svelte-realtime] RPC response for '${correlationId}' contains ${data.length} items -- ` +
				'large responses may exceed maxPayloadLength (16KB). Increase maxPayloadLength in adapter config if needed.\n  See: https://svti.me/adapter-config'
			);
		}
	}
	try {
		const result = platform.send(ws, '__rpc', correlationId, payload);
		if (result === 0 && typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
			console.warn(
				`[svelte-realtime] RPC response was not delivered (backpressure or closed connection)`
			);
		}
	} catch (err) {
		// uWS throws when accessing a closed WebSocket -- expected during mid-RPC disconnect.
		if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
			console.warn(`[svelte-realtime] RPC response for '${correlationId}' could not be delivered (client likely disconnected)`);
		}
	}
}

/**
 * Execute a live function directly (in-process), without WebSocket.
 * Used by SSR load functions to call live functions server-side.
 *
 * @param {string} path - RPC path (e.g. 'chat/messages')
 * @param {any[]} args - Arguments to pass (excluding ctx)
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {{ user?: any }} [options]
 * @returns {Promise<any>}
 */
export async function __directCall(path, args, platform, options) {
	if (!_lazyResolved) await _resolveAllLazy();
	const fn = await _resolveRegistryEntry(path);
	if (!fn) {
		throw new LiveError('NOT_FOUND', `Live function '${path}' not found`);
	}

	// Distinguish "user explicitly passed (even as null)" from "user omitted".
	// Omitted + guarded stream is almost always a load() bug -- throw a
	// descriptive Error so the SSR overlay surfaces the fix immediately.
	const userExplicit = options ? ('user' in options) : false;
	const userValue = userExplicit ? options.user : null;

	const _h = _getCtxHelpers(platform);
	const ctx = _buildCtx(userValue, null, platform, _h, null);

	// Run global middleware chain, then guard, then execution
	return _runWithMiddleware(ctx, async () => {
	// Run module guard
	const modulePath = /** @type {any} */ (fn).__modulePath || path.substring(0, path.lastIndexOf('/'));
	const guardFn = await _resolveGuard(modulePath);
	if (guardFn) {
		if (!userExplicit) {
			throw new Error(
				`[svelte-realtime] '${path}' has a guard but .load() was called without a user.\n` +
				`  Pass it explicitly:    stream.load(platform, { user: locals.user })\n` +
				`  Or opt into anonymous: stream.load(platform, { user: null })\n` +
				`  See: https://svti.me/ssr`
			);
		}
		await _runGuard(guardFn, ctx);
	}

	if (/** @type {any} */ (fn).__isStream) {
		const argsSchema = /** @type {any} */ (fn).__streamArgs;
		if (argsSchema) {
			const result = _validate(argsSchema, args);
			if (!result.ok) {
				const err = new LiveError('VALIDATION', result.message);
				/** @type {any} */ (err).issues = result.issues;
				throw err;
			}
			args = Array.isArray(result.data) ? result.data : args;
		}

		if (/** @type {any} */ (fn).__isGated) {
			const predicate = /** @type {any} */ (fn).__gatePredicate;
			if (!predicate(ctx, ...args)) return null;
		}
		const streamFilter = /** @type {any} */ (fn).__streamFilter;
		if (streamFilter && !streamFilter(ctx, ...args)) {
			const code = ctx.user ? 'FORBIDDEN' : 'UNAUTHENTICATED';
			throw new LiveError(code, code === 'UNAUTHENTICATED' ? 'Authentication required' : 'Access denied');
		}
		let result = await fn(ctx, ...args);
		const initTransform = /** @type {any} */ (fn).__streamTransform;
		if (initTransform && result != null) {
			// Match the WS subscribe path: paginated responses transform .data only.
			if (result && typeof result === 'object' && !Array.isArray(result) && 'data' in result && 'hasMore' in result) {
				result = { ...result, data: _applyInitTransform(initTransform, result.data) };
			} else {
				result = _applyInitTransform(initTransform, result);
			}
		}
		return result;
	}

	return fn(ctx, ...args);
	});
}

/**
 * Handle a WebSocket close event. Fires onUnsubscribe lifecycle hooks
 * for any stream functions that define them.
 *
 * Call this from your `close` hook in hooks.ws.js:
 * ```js
 * export { close } from 'svelte-realtime/server';
 * ```
 *
 * @param {any} ws
 * @param {{ platform: import('svelte-adapter-uws').Platform }} ctx
 */
/**
 * Subscribe a WebSocket to its user's signal topic.
 * Call this in your `open` hook to enable `ctx.signal()` delivery.
 *
 * @param {any} ws - The WebSocket connection
 * @param {{ idField?: string }} [options] - Options (defaults to `ws.getUserData().id`)
 */
export function enableSignals(ws, options) {
	const idField = options?.idField || 'id';
	const userData = ws.getUserData();
	const userId = userData?.[idField];
	if (userId !== undefined && userId !== null) {
		ws.subscribe('__signal:' + userId);
	}
}

/**
 * Handle a real-time topic unsubscribe event. Fires onUnsubscribe lifecycle
 * hooks for the stream function that owns the topic.
 *
 * The adapter 0.4.0 calls this when a client's topic reference count reaches zero.
 * Export from hooks.ws.js:
 * ```js
 * export { unsubscribe } from 'svelte-realtime/server';
 * ```
 *
 * @param {any} ws
 * @param {string} topic
 * @param {{ platform: import('svelte-adapter-uws').Platform }} ctx
 */
export function unsubscribe(ws, topic, { platform }) {
	const topicMap = _wsStreamOwners.get(ws);
	if (!topicMap) return;
	const owners = topicMap.get(topic);
	if (!owners || owners.length === 0) return;

	const user = ws.getUserData();
	const unsubCtx = { user, ws, platform, publish: _getCtxHelpers(platform).publish, cursor: null };

	// Drain every logical subscriber for this topic
	for (const entry of owners) {
		for (let i = 0; i < entry.count; i++) {
			if (_metricsInstruments) _metricsInstruments.streamGauge.dec();
			if (/** @type {any} */ (entry.fn).__onUnsubscribe) {
				Promise.resolve().then(() => /** @type {any} */ (entry.fn).__onUnsubscribe(unsubCtx, topic)).catch(() => {});
			}
		}
	}
	topicMap.delete(topic);
	_unregisterCoalesce(ws, topic);
	_unregisterTransform(ws, topic);

	let fired = _firedUnsubscribes.get(ws);
	if (!fired) { fired = new Set(); _firedUnsubscribes.set(ws, fired); }
	fired.add(topic);
}

/** @type {WeakMap<object, Set<string>>} Topics whose hooks already fired via unsubscribe() */
const _firedUnsubscribes = new WeakMap();

export function close(ws, { platform, subscriptions }) {
	const topicMap = _wsStreamOwners.get(ws);
	const alreadyFired = _firedUnsubscribes.get(ws);

	const user = ws.getUserData();
	const closeCtx = { user, ws, platform, publish: _getCtxHelpers(platform).publish, cursor: null };

	// Drain tracked stream subscriptions (from the RPC subscribe path)
	if (topicMap) {
		for (const [topic, owners] of topicMap) {
			_unregisterCoalesce(ws, topic);
			_unregisterTransform(ws, topic);
			if (alreadyFired && alreadyFired.has(topic)) continue;
			for (const entry of owners) {
				for (let i = 0; i < entry.count; i++) {
					if (_metricsInstruments) _metricsInstruments.streamGauge.dec();
					if (/** @type {any} */ (entry.fn).__onUnsubscribe) {
						Promise.resolve().then(() => /** @type {any} */ (entry.fn).__onUnsubscribe(closeCtx, topic)).catch(() => {});
					}
				}
			}
		}
	}

	// Also check static-topic streams for manually subscribed topics not tracked via RPC
	const subscribedTopics = subscriptions || (typeof ws.getTopics === 'function' ? ws.getTopics() : null);
	if (subscribedTopics && _streamsWithUnsubscribe.size > 0) {
		const subSet = subscribedTopics instanceof Set ? subscribedTopics : new Set(subscribedTopics);
		for (const fn of [..._streamsWithUnsubscribe]) {
			const rawTopic = /** @type {any} */ (fn).__streamTopic;
			if (typeof rawTopic !== 'string') continue;
			if (!subSet.has(rawTopic)) continue;
			if (alreadyFired && alreadyFired.has(rawTopic)) continue;
			if (topicMap && topicMap.has(rawTopic)) continue; // already handled above
			Promise.resolve().then(() => /** @type {any} */ (fn).__onUnsubscribe(closeCtx, rawTopic)).catch(() => {});
		}
	}

	_wsStreamOwners.delete(ws);
	_firedUnsubscribes.delete(ws);
}

/**
 * Ready-made message hook. Re-export from hooks.ws.js for zero-config RPC routing.
 *
 * Signature matches the adapter's message hook exactly.
 *
 * @param {any} ws
 * @param {{ data: ArrayBuffer, platform: import('svelte-adapter-uws').Platform }} ctx
 */
export function message(ws, { data, platform }) {
	handleRpc(ws, data, platform);
}

/**
 * Create a custom message hook with options baked in.
 *
 * @param {{ platform?: (p: import('svelte-adapter-uws').Platform) => import('svelte-adapter-uws').Platform, beforeExecute?: (ws: any, rpcPath: string, args: any[]) => Promise<void> | void, onError?: (path: string, error: unknown, ctx: any) => void, onUnhandled?: (ws: any, data: ArrayBuffer, platform: import('svelte-adapter-uws').Platform) => void }} [options]
 * @returns {(ws: any, ctx: { data: ArrayBuffer, platform: import('svelte-adapter-uws').Platform }) => void}
 */
export function createMessage(options) {
	if (!options) return message;

	const { platform: transformPlatform, beforeExecute, onError, onUnhandled } = options;

	/** @type {any} */
	const rpcOpts = {};
	if (beforeExecute) rpcOpts.beforeExecute = beforeExecute;
	if (onError) rpcOpts.onError = onError;
	const hasRpcOpts = beforeExecute || onError;

	return function customMessage(ws, { data, platform }) {
		const p = transformPlatform ? transformPlatform(platform) : platform;
		const handled = handleRpc(ws, data, p, hasRpcOpts ? rpcOpts : undefined);
		if (!handled && onUnhandled) {
			onUnhandled(ws, data, p);
		}
	};
}
