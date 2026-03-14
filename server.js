// @ts-check

const textDecoder = new TextDecoder();

/** @type {Map<string, Function>} */
const registry = new Map();

/** @type {Map<string, Function>} */
const guards = new Map();

/** @type {Set<Function>} Streams with onUnsubscribe hooks for fast close() */
const _streamsWithUnsubscribe = new Set();

/** @type {Array<(ctx: any, next: () => Promise<any>) => Promise<any>>} */
const _globalMiddleware = [];

/** @type {WeakMap<any, Function>} Cache bound publish per platform to avoid repeated .bind() */
const _boundPublishCache = new WeakMap();

/**
 * Get a cached bound publish function for a platform.
 * @param {import('svelte-adapter-uws').Platform} platform
 * @returns {Function}
 */
function _getBoundPublish(platform) {
	let bound = _boundPublishCache.get(platform);
	if (!bound) {
		bound = platform.publish.bind(platform);
		_boundPublishCache.set(platform, bound);
	}
	return bound;
}

/** @type {WeakMap<any, { publish: Function, throttle: Function, debounce: Function, signal: Function }>} */
const _ctxHelpersCache = new WeakMap();

/**
 * Get cached ctx helper methods for a platform.
 * Avoids creating new closures on every RPC call.
 * @param {import('svelte-adapter-uws').Platform} platform
 * @returns {{ publish: Function, throttle: Function, debounce: Function, signal: Function }}
 */
function _getCtxHelpers(platform) {
	let helpers = _ctxHelpersCache.get(platform);
	if (!helpers) {
		const publish = _getBoundPublish(platform);
		helpers = {
			publish,
			throttle: (topic, event, data, ms) => _throttlePublish(platform, topic, event, data, ms),
			debounce: (topic, event, data, ms) => _debouncePublish(platform, topic, event, data, ms),
			signal: (userId, event, data) => platform.publish('__signal:' + userId, event, data)
		};
		_ctxHelpersCache.set(platform, helpers);
	}
	return helpers;
}

/**
 * Register a live function in the registry.
 * Called by the Vite-generated registry module.
 * @param {string} path
 * @param {Function} fn
 */
export function __register(path, fn) {
	registry.set(path, fn);
	// Set rate limit path for rate-limited functions
	if (/** @type {any} */ (fn).__isRateLimited) {
		/** @type {any} */ (fn).__rateLimitPath = path;
	}
	if (/** @type {any} */ (fn).__isStream && /** @type {any} */ (fn).__onUnsubscribe) {
		_streamsWithUnsubscribe.add(fn);
	}
}

/**
 * Register a guard for a module.
 * Called by the Vite-generated registry module.
 * @param {string} modulePath
 * @param {Function} fn
 */
export function __registerGuard(modulePath, fn) {
	guards.set(modulePath, fn);
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
 * @param {{ merge?: 'crud' | 'latest' | 'set' | 'presence' | 'cursor', key?: string, prepend?: boolean, max?: number, replay?: boolean | { size?: number } }} [options]
 * @returns {Function}
 */
live.stream = function stream(topic, initFn, options) {
	const { replay, onSubscribe, onUnsubscribe, filter, access, delta, version, migrate, ...rest } = options || {};
	const merged = { merge: 'crud', key: 'id', ...rest };
	if (replay) /** @type {any} */ (initFn).__replay = typeof replay === 'object' ? replay : {};
	if (delta) /** @type {any} */ (initFn).__delta = delta;
	/** @type {any} */ (initFn).__isStream = true;
	/** @type {any} */ (initFn).__isLive = true;
	/** @type {any} */ (initFn).__streamTopic = topic;
	/** @type {any} */ (initFn).__streamOptions = merged;
	if (onSubscribe) /** @type {any} */ (initFn).__onSubscribe = onSubscribe;
	if (onUnsubscribe) /** @type {any} */ (initFn).__onUnsubscribe = onUnsubscribe;
	// Per-connection filter: (ctx, event, data) => boolean
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
live.binary = function binary(fn) {
	/** @type {any} */ (fn).__isLive = true;
	/** @type {any} */ (fn).__isBinary = true;
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
 * Declarative access control helpers for stream filtering.
 * These return filter functions compatible with `live.stream({ access: ... })`.
 */
live.access = {
	/**
	 * Only allow events where `data[field]` matches `ctx.user.id`.
	 * @param {string} field - The field on the event data to check
	 * @returns {(ctx: any, event: string, data: any) => boolean}
	 */
	owner(field) {
		return (ctx, _event, data) => data && data[field] === ctx.user?.id;
	},

	/**
	 * Role-based access: map role names to filter predicates.
	 * @param {Record<string, true | ((ctx: any, data: any) => boolean)>} map
	 * @returns {(ctx: any, event: string, data: any) => boolean}
	 */
	role(map) {
		return (ctx, _event, data) => {
			const role = ctx.user?.role;
			if (!role || !(role in map)) return false;
			const rule = map[role];
			return rule === true ? true : rule(ctx, data);
		};
	},

	/**
	 * Only allow events where `data[field]` matches `ctx.user.teamId`.
	 * @param {string} field - The field on the event data to check
	 * @returns {(ctx: any, event: string, data: any) => boolean}
	 */
	team(field) {
		return (ctx, _event, data) => data && data[field] === ctx.user?.teamId;
	},

	/**
	 * OR logic: any predicate returning true allows the event.
	 * @param {...((ctx: any, event: string, data: any) => boolean)} predicates
	 * @returns {(ctx: any, event: string, data: any) => boolean}
	 */
	any(...predicates) {
		return (ctx, event, data) => predicates.some(p => p(ctx, event, data));
	},

	/**
	 * AND logic: all predicates must return true to allow the event.
	 * @param {...((ctx: any, event: string, data: any) => boolean)} predicates
	 * @returns {(ctx: any, event: string, data: any) => boolean}
	 */
	all(...predicates) {
		return (ctx, event, data) => predicates.every(p => p(ctx, event, data));
	}
};

/** @type {Map<string, { prev: number, curr: number, windowStart: number }>} */
const _rateLimits = new Map();

/** @type {number} */
let _rateLimitLastSweep = Date.now();

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
	const keyFn = config.key || ((ctx) => ctx.user?.id || 'anon');

	const wrapper = async function rateLimitedWrapper(ctx, ...args) {
		const userKey = keyFn(ctx);
		const bucketKey = /** @type {any} */ (wrapper).__rateLimitPath + '\0' + userKey;
		const now = Date.now();

		// Lazy sweep: prune stale entries, but limit work per sweep
		if (now - _rateLimitLastSweep > 60000) {
			_rateLimitLastSweep = now;
			if (_rateLimits.size > 0) {
				const maxSweep = Math.max(200, _rateLimits.size >> 2);
				let swept = 0;
				for (const [k, bucket] of _rateLimits) {
					if (now - bucket.windowStart >= windowMs * 2) {
						_rateLimits.delete(k);
					}
					if (++swept >= maxSweep) break;
				}
			}
		}

		let bucket = _rateLimits.get(bucketKey);
		if (!bucket) {
			bucket = { prev: 0, curr: 0, windowStart: now };
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
	return wrapper;
};

/**
 * Mark a function as RPC-callable with schema validation.
 * Validates args[0] against the schema before calling fn.
 * Supports Zod (.safeParse method on schema) and Valibot (safeParse as standalone).
 *
 * @param {any} schema - Zod or Valibot schema
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
	return wrapper;
};

/**
 * Validate input against a Zod or Valibot schema.
 * @param {any} schema
 * @param {any} input
 * @returns {{ ok: true, data: any } | { ok: false, message: string, issues: Array<{ path: string[], message: string }> }}
 */
function _validate(schema, input) {
	// Zod-style: schema has .safeParse method
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

	// Valibot-style: schema is passed to a standalone safeParse
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

	// Unknown schema type - pass through unchanged
	return { ok: true, data: input };
}

/** @type {Map<string, { schedule: number[], fn: Function, topic: string }>} */
const cronRegistry = new Map();

/** @type {ReturnType<typeof setInterval> | null} */
let _cronInterval = null;

/** @type {import('svelte-adapter-uws').Platform | null} */
let _cronPlatform = null;

/** @type {((path: string, error: unknown) => void) | null} */
let _cronErrorHandler = null;

/**
 * Set a global error handler for cron job failures.
 * Without this, cron errors are logged in dev and silently swallowed in production.
 * @param {(path: string, error: unknown) => void} handler
 */
export function onCronError(handler) {
	_cronErrorHandler = handler;
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
 * @param {string[]} sources - Topic names to watch
 * @param {Function} fn - Async function that computes the derived value
 * @param {{ merge?: string, debounce?: number }} [options]
 * @returns {Function}
 */
live.derived = function derived(sources, fn, options) {
	const topic = /** @type {any} */ (fn).__derivedTopic || ('__derived:' + (_derivedIdCounter++));
	const merge = options?.merge || 'set';
	const debounce = options?.debounce || 0;

	/** @type {any} */ (fn).__isDerived = true;
	/** @type {any} */ (fn).__isStream = true;
	/** @type {any} */ (fn).__isLive = true;
	/** @type {any} */ (fn).__streamTopic = topic;
	/** @type {any} */ (fn).__streamOptions = { merge, key: 'id' };
	/** @type {any} */ (fn).__derivedSources = sources;
	/** @type {any} */ (fn).__derivedDebounce = debounce;
	return fn;
};

let _derivedIdCounter = 0;

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
		// If aggregate is active, return current state; otherwise return init state
		const entry = _aggregateByTopic.get(topic);
		if (entry) {
			const computed = _computeAggregateState(entry.state, reducers);
			return computed;
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
	const source = /** @type {any} */ (fn).__aggregateSource;
	const reducers = /** @type {any} */ (fn).__aggregateReducers;
	const topic = /** @type {any} */ (fn).__streamTopic;
	const initState = /** @type {any} */ (fn).__aggregateInitState;
	const snapshot = /** @type {any} */ (fn).__aggregateSnapshot;
	const debounce = /** @type {any} */ (fn).__aggregateDebounce || 0;
	if (!source || !topic) return;
	const entry = { source, reducers, topic, state: { ...initState }, snapshot, debounce, timer: null };
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

	// Copy all metadata from the original function
	/** @type {any} */ (wrapper).__isStream = /** @type {any} */ (fn).__isStream;
	/** @type {any} */ (wrapper).__isLive = /** @type {any} */ (fn).__isLive;
	/** @type {any} */ (wrapper).__streamTopic = /** @type {any} */ (fn).__streamTopic;
	/** @type {any} */ (wrapper).__streamOptions = /** @type {any} */ (fn).__streamOptions;
	/** @type {any} */ (wrapper).__isGated = true;
	/** @type {any} */ (wrapper).__gatePredicate = predicate;
	if (/** @type {any} */ (fn).__replay) /** @type {any} */ (wrapper).__replay = /** @type {any} */ (fn).__replay;
	if (/** @type {any} */ (fn).__delta) /** @type {any} */ (wrapper).__delta = /** @type {any} */ (fn).__delta;
	if (/** @type {any} */ (fn).__onSubscribe) /** @type {any} */ (wrapper).__onSubscribe = /** @type {any} */ (fn).__onSubscribe;
	if (/** @type {any} */ (fn).__onUnsubscribe) /** @type {any} */ (wrapper).__onUnsubscribe = /** @type {any} */ (fn).__onUnsubscribe;
	if (/** @type {any} */ (fn).__streamFilter) /** @type {any} */ (wrapper).__streamFilter = /** @type {any} */ (fn).__streamFilter;

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

	// Copy all metadata from the original stream
	/** @type {any} */ (wrapper).__isStream = /** @type {any} */ (stream).__isStream;
	/** @type {any} */ (wrapper).__isLive = /** @type {any} */ (stream).__isLive;
	/** @type {any} */ (wrapper).__streamTopic = /** @type {any} */ (stream).__streamTopic;
	/** @type {any} */ (wrapper).__streamOptions = /** @type {any} */ (stream).__streamOptions;
	if (/** @type {any} */ (stream).__replay) /** @type {any} */ (wrapper).__replay = /** @type {any} */ (stream).__replay;
	if (/** @type {any} */ (stream).__delta) /** @type {any} */ (wrapper).__delta = /** @type {any} */ (stream).__delta;
	if (/** @type {any} */ (stream).__onSubscribe) /** @type {any} */ (wrapper).__onSubscribe = /** @type {any} */ (stream).__onSubscribe;
	if (/** @type {any} */ (stream).__onUnsubscribe) /** @type {any} */ (wrapper).__onUnsubscribe = /** @type {any} */ (stream).__onUnsubscribe;
	if (/** @type {any} */ (stream).__isGated) {
		/** @type {any} */ (wrapper).__isGated = true;
		/** @type {any} */ (wrapper).__gatePredicate = /** @type {any} */ (stream).__gatePredicate;
	}

	// Build a composite filter from any pipe.filter transforms + existing filter
	const existingFilter = /** @type {any} */ (stream).__streamFilter;
	const eventFilters = transforms
		.filter(t => t.transformEvent)
		.map(t => t.transformEvent);

	if (eventFilters.length > 0 || existingFilter) {
		/** @type {any} */ (wrapper).__streamFilter = (ctx, event, data) => {
			if (existingFilter && !existingFilter(ctx, event, data)) return false;
			for (const f of eventFilters) {
				if (!f(ctx, event, data)) return false;
			}
			return true;
		};
	} else if (/** @type {any} */ (stream).__streamFilter) {
		/** @type {any} */ (wrapper).__streamFilter = /** @type {any} */ (stream).__streamFilter;
	}

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

	// The room is exposed as a collection of live functions that the Vite plugin
	// will detect and register. We return an object with __isRoom = true and
	// the necessary metadata for the Vite plugin to generate correct client stubs.
	const roomExport = {};

	// Data stream
	const dataStream = live.stream(topicFn, async function roomInit(ctx, ...args) {
		if (guardFn) await guardFn(ctx, ...args);
		if (onJoin) {
			try { await onJoin(ctx, ...args); } catch {}
		}
		return initFn(ctx, ...args);
	}, {
		merge: mergeMode,
		key: keyField,
		onSubscribe: presenceFn ? (ctx, topic) => {
			const presenceData = presenceFn(ctx);
			if (presenceData) {
				ctx.publish(topic + ':presence', 'join', { key: ctx.user?.id || 'anon', data: presenceData });
			}
		} : undefined,
		onUnsubscribe: presenceFn ? (ctx, topic) => {
			ctx.publish(topic + ':presence', 'leave', { key: ctx.user?.id || 'anon' });
			if (onLeave) {
				try { onLeave(ctx); } catch {}
			}
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
			async (ctx, ...args) => [],
			{ merge: 'presence' }
		);
	}

	// Cursor stream (if enabled)
	if (cursorConfig) {
		/** @type {any} */ (roomExport).__cursorStream = live.stream(
			(ctx, ...args) => topicFn(ctx, ...args) + ':cursors',
			async (ctx, ...args) => [],
			{ merge: 'cursor' }
		);
	}

	// Room-scoped actions
	if (actions) {
		/** @type {any} */ (roomExport).__actions = {};
		for (const [name, fn] of Object.entries(actions)) {
			const wrappedAction = live(async function roomAction(ctx, ...args) {
				if (guardFn) await guardFn(ctx, ...args);
				// Scope ctx.publish to the room's topic
				const roomTopic = topicFn(ctx, ...args);
				const originalPublish = ctx.publish;
				ctx.publish = (event, data) => originalPublish(roomTopic, event, data);
				try {
					return await fn(ctx, ...args);
				} finally {
					ctx.publish = originalPublish;
				}
			});
			/** @type {any} */ (roomExport).__actions[name] = wrappedAction;
		}
	}

	return roomExport;
};

/**
 * Register a derived stream. Called by the Vite-generated registry module.
 * @param {string} path
 * @param {Function} fn
 */
export function __registerDerived(path, fn) {
	const sources = /** @type {any} */ (fn).__derivedSources;
	const topic = /** @type {any} */ (fn).__streamTopic;
	const debounce = /** @type {any} */ (fn).__derivedDebounce || 0;
	if (!sources || !topic) return;
	derivedRegistry.set(path, { sources, fn, topic, debounce, timer: null });
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
export function _activateDerived(platform) {
	// Only wrap platform.publish if there are actual reactive registrations
	if (_derivedBySource.size === 0 && _effectBySource.size === 0 && _aggregateBySource.size === 0) {
		return;
	}

	const originalPublish = platform.publish.bind(platform);

	platform.publish = function derivedPublish(topic, event, data, opts) {
		const result = originalPublish(topic, event, data, opts);

		if (!_watchedTopics.has(topic)) return result;

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
				for (const [field, reducer] of Object.entries(entry.reducers)) {
					if (reducer.reduce) {
						entry.state[field] = reducer.reduce(entry.state[field], event, data);
					}
				}

				const computed = _computeAggregateState(entry.state, entry.reducers);

				if (entry.debounce > 0) {
					if (entry.timer) clearTimeout(entry.timer);
					entry.timer = setTimeout(() => {
						entry.timer = null;
						originalPublish(entry.topic, 'set', computed);
					}, entry.debounce);
				} else {
					originalPublish(entry.topic, 'set', computed);
				}
			}
		}

		return result;
	};
}

/**
 * Recompute a derived stream and publish the result.
 * @param {{ fn: Function, topic: string }} entry
 * @param {import('svelte-adapter-uws').Platform} platform
 */
async function _recomputeDerived(entry, platform) {
	try {
		const result = await entry.fn();
		platform.publish(entry.topic, 'set', result);
	} catch (err) {
		if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
			console.error(`[svelte-realtime] Derived stream '${entry.topic}' error:`, err);
		}
	}
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
		if (_cronErrorHandler) {
			try { _cronErrorHandler('effect', err); } catch {}
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

function _tickCron() {
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
						console.warn(`[svelte-realtime] Cron '${path}' fired but no platform captured. Call setCronPlatform(platform) in your open hook.`);
					}
					return;
				}
				const result = await entry.fn();
				_cronPlatform.publish(entry.topic, 'set', result);
			} catch (err) {
				if (_cronErrorHandler) {
					_cronErrorHandler(path, err);
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
		throw new Error(`[svelte-realtime] Invalid cron expression '${expr}' -- expected 5 fields (minute hour day month weekday)`);
	}
	return parts.map(_parseCronField);
}

/**
 * Parse a single cron field.
 * Returns null for '*' (match all), or an array/Set of allowed values.
 * For step values, returns { step: N }.
 * @param {string} field
 * @returns {any}
 */
function _parseCronField(field) {
	if (field === '*') return null; // match all

	// Step: */N
	if (field.startsWith('*/')) {
		return { step: parseInt(field.slice(2), 10) };
	}

	// Range: N-M
	if (field.includes('-') && !field.includes(',')) {
		const [a, b] = field.split('-').map(Number);
		const vals = new Set();
		for (let i = a; i <= b; i++) vals.add(i);
		return vals;
	}

	// List: N,M,P
	if (field.includes(',')) {
		return new Set(field.split(',').map(Number));
	}

	// Single value
	return new Set([parseInt(field, 10)]);
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
 * Create a per-module guard. Accepts one or more middleware functions.
 * When multiple are provided, they run in order — if any throws, the chain stops.
 * Earlier middleware can enrich `ctx` for later ones.
 * @param {...Function} fns
 * @returns {Function}
 */
export function guard(...fns) {
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
			} catch {}
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
	const { rpc: path, id, args: rawArgs, stream: isStream, seq: clientSeq, cursor: clientCursor, schemaVersion: clientSchemaVersion } = msg;

	// Validate args
	if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
		_respond(ws, platform, id, { ok: false, code: 'INVALID_REQUEST', error: 'args must be an array' });
		return;
	}

	const args = rawArgs || [];

	// Lookup function in registry
	const fn = registry.get(path);
	if (!fn) {
		if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
			console.warn(`[svelte-realtime] RPC call to '${path}' -- no such live function registered`);
		}
		_respond(ws, platform, id, { ok: false, code: 'NOT_FOUND', error: 'Not found' });
		return;
	}

	// Build context
	const _h = _getCtxHelpers(platform);
	const ctx = {
		user: ws.getUserData(),
		ws,
		platform,
		publish: _h.publish,
		cursor: clientCursor !== undefined ? clientCursor : null,
		throttle: _h.throttle,
		debounce: _h.debounce,
		signal: _h.signal
	};

	try {
		// Run global middleware chain, then guard, then execution
		await _runWithMiddleware(ctx, async () => {
		// Run module guard if registered
		const modulePath = path.substring(0, path.lastIndexOf('/'));
		const guardFn = guards.get(modulePath);
		if (guardFn) await guardFn(ctx);

		// Run beforeExecute hook
		if (options?.beforeExecute) {
			await options.beforeExecute(ws, path, args);
		}

		// Handle stream: subscribe BEFORE loading data (gap-free)
		if (isStream && /** @type {any} */ (fn).__isStream) {
			// Gate check: if predicate returns false, respond with gated no-op
			if (/** @type {any} */ (fn).__isGated) {
				const predicate = /** @type {any} */ (fn).__gatePredicate;
				if (!predicate(ctx, ...args)) {
					_respond(ws, platform, id, { ok: true, data: null, gated: true });
					return;
				}
			}

			const rawTopic = /** @type {any} */ (fn).__streamTopic;
			const topic = typeof rawTopic === 'function' ? rawTopic(ctx, ...args) : rawTopic;
			const streamOpts = /** @type {any} */ (fn).__streamOptions;
			const replayOpts = /** @type {any} */ (fn).__replay;

			// Enforce stream filter/access predicate before subscribing
			const streamFilter = /** @type {any} */ (fn).__streamFilter;
			if (streamFilter && !streamFilter(ctx)) {
				_respond(ws, platform, id, { ok: false, error: 'Access denied' });
				return;
			}

			ws.subscribe(topic);

			// Fire onSubscribe lifecycle hook
			if (/** @type {any} */ (fn).__onSubscribe) {
				try { await /** @type {any} */ (fn).__onSubscribe(ctx, topic); } catch {}
			}

			// Channel fast-path: no database, respond immediately with empty data
			if (/** @type {any} */ (fn).__isChannel) {
				const emptyValue = streamOpts.merge === 'set' ? null : [];
				_respond(ws, platform, id, {
					ok: true,
					data: emptyValue,
					topic,
					merge: streamOpts.merge,
					key: streamOpts.key,
					max: streamOpts.max
				});
				return;
			}

			// Delta sync: if client sent a version and delta is configured, try to send only changes
			const deltaOpts = /** @type {any} */ (fn).__delta;
			const clientVersion = msg.version;
			if (deltaOpts && clientVersion !== undefined && deltaOpts.version && deltaOpts.diff) {
				try {
					const currentVersion = await deltaOpts.version();
					if (currentVersion === clientVersion) {
						// Nothing changed -- respond with unchanged flag
						_respond(ws, platform, id, {
							ok: true,
							data: [],
							topic,
							merge: streamOpts.merge,
							key: streamOpts.key,
							prepend: streamOpts.prepend,
							max: streamOpts.max,
							unchanged: true,
							version: currentVersion
						});
						return;
					}
					// Version differs -- try to get diff
					const diff = await deltaOpts.diff(clientVersion);
					if (diff !== null && diff !== undefined) {
						_respond(ws, platform, id, {
							ok: true,
							data: diff,
							topic,
							merge: streamOpts.merge,
							key: streamOpts.key,
							prepend: streamOpts.prepend,
							max: streamOpts.max,
							delta: true,
							version: currentVersion
						});
						return;
					}
					// diff returned null/undefined -- fall through to full refetch
				} catch {
					// Delta failed -- fall through to full refetch
				}
			}

			// Replay: if client sent a seq and replay is enabled, try to send only missed events
			if (replayOpts && typeof clientSeq === 'number' && platform.replay) {
				try {
					const missed = await platform.replay.since(topic, clientSeq);
					if (missed) {
						const currentSeq = await platform.replay.seq(topic);
						_respond(ws, platform, id, {
							ok: true,
							data: missed,
							topic,
							merge: streamOpts.merge,
							key: streamOpts.key,
							prepend: streamOpts.prepend,
							max: streamOpts.max,
							seq: currentSeq,
							replay: true
						});
						return;
					}
				} catch {
					// Fallback to full refetch below
				}
			}

			const result = await fn(ctx, ...args);

			// Support paginated responses: initFn can return { data, hasMore, cursor }
			const isPaginated = result && typeof result === 'object' && !Array.isArray(result) && 'data' in result && 'hasMore' in result;
			let resultData = isPaginated ? result.data : result;

			// Schema migration: apply migration functions if client version is behind server
			const serverVersion = /** @type {any} */ (fn).__streamVersion;
			const migrateFns = /** @type {any} */ (fn).__streamMigrate;
			if (serverVersion !== undefined && migrateFns && typeof clientSchemaVersion === 'number' && clientSchemaVersion < serverVersion) {
				resultData = _migrateData(resultData, clientSchemaVersion, serverVersion, migrateFns);
			}

			if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
				if (streamOpts.merge === 'crud' && !Array.isArray(resultData)) {
					console.warn(
						`[svelte-realtime] live.stream '${topic}' initFn returned ${typeof resultData} but merge:'crud' expects an array`
					);
				}
			}

			/** @type {any} */
			const response = {
				ok: true,
				data: resultData,
				topic,
				merge: streamOpts.merge,
				key: streamOpts.key,
				prepend: streamOpts.prepend,
				max: streamOpts.max
			};

			// Include pagination info
			if (isPaginated) {
				response.hasMore = result.hasMore;
				if (result.cursor !== undefined) response.cursor = result.cursor;
			}

			// Include seq for replay-enabled streams
			if (replayOpts && platform.replay) {
				try {
					response.seq = await platform.replay.seq(topic);
				} catch {}
			}
			if (typeof clientSeq === 'number') {
				response.replay = false; // Full refetch fallback
			}

			// Include version for delta-enabled streams (full refetch path)
			if (deltaOpts && deltaOpts.version) {
				try {
					response.version = await deltaOpts.version();
				} catch {}
			}

			// Include schema version in response
			if (serverVersion !== undefined) {
				response.schemaVersion = serverVersion;
			}

			_respond(ws, platform, id, response);
		} else {
			// Regular RPC
			const result = await fn(ctx, ...args);
			_respond(ws, platform, id, { ok: true, data: result });
		}
		}); // end _runWithMiddleware
	} catch (err) {
		if (err instanceof LiveError) {
			/** @type {any} */
			const response = { ok: false, code: err.code, error: err.message };
			if (/** @type {any} */ (err).issues) response.issues = /** @type {any} */ (err).issues;
			_respond(ws, platform, id, response);
		} else {
			if (options?.onError) {
				try { options.onError(path, err, ctx); } catch {}
			}
			if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
				console.warn(
					`[svelte-realtime] '${path}' threw a non-LiveError:`,
					err,
					'\nUse throw new LiveError(code, message) for client-visible errors. Raw errors are hidden from clients.'
				);
				console.error(`[svelte-realtime] Error in '${path}':`, err);
			}
			_respond(ws, platform, id, { ok: false, code: 'INTERNAL_ERROR', error: 'Internal server error' });
		}
	}
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

	if (batch.length > 50) {
		_respond(ws, platform, '__batch', {
			batch: [{ id: '', ok: false, code: 'INVALID_REQUEST', error: 'Batch exceeds maximum of 50 calls' }]
		});
		return;
	}

	/** @type {Array<{ id: string, ok: boolean, data?: any, code?: string, error?: string }>} */
	const results = [];

	if (sequential) {
		for (const call of batch) {
			if (!call || typeof call.rpc !== 'string' || typeof call.id !== 'string') {
				results.push({ id: call?.id || '', ok: false, code: 'INVALID_REQUEST', error: 'Each batch entry requires rpc and id' });
				continue;
			}
			results.push(await _executeSingleRpc(ws, call, platform, options));
		}
	} else {
		const promises = batch.map((call) => {
			if (!call || typeof call.rpc !== 'string' || typeof call.id !== 'string') {
				return Promise.resolve({ id: call?.id || '', ok: false, code: 'INVALID_REQUEST', error: 'Each batch entry requires rpc and id' });
			}
			return _executeSingleRpc(ws, call, platform, options);
		});
		results.push(...(await Promise.all(promises)));
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
	const { rpc: path, id, args: rawArgs, stream: isStream } = msg;

	if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
		return { id, ok: false, code: 'INVALID_REQUEST', error: 'args must be an array' };
	}

	const args = rawArgs || [];
	const fn = registry.get(path);
	if (!fn) {
		return { id, ok: false, code: 'NOT_FOUND', error: 'Not found' };
	}

	const _h = _getCtxHelpers(platform);
	const ctx = {
		user: ws.getUserData(),
		ws,
		platform,
		publish: _h.publish,
		throttle: _h.throttle,
		debounce: _h.debounce
	};

	try {
		return await _runWithMiddleware(ctx, async () => {
		const modulePath = path.substring(0, path.lastIndexOf('/'));
		const guardFn = guards.get(modulePath);
		if (guardFn) await guardFn(ctx);

		if (options?.beforeExecute) {
			await options.beforeExecute(ws, path, args);
		}

		if (isStream && /** @type {any} */ (fn).__isStream) {
			// Gate check: if predicate returns false, respond with gated no-op
			if (/** @type {any} */ (fn).__isGated) {
				const predicate = /** @type {any} */ (fn).__gatePredicate;
				if (!predicate(ctx, ...args)) {
					return { id, ok: true, data: null, gated: true };
				}
			}

			const rawTopic = /** @type {any} */ (fn).__streamTopic;
			const topic = typeof rawTopic === 'function' ? rawTopic(ctx, ...args) : rawTopic;
			const streamOpts = /** @type {any} */ (fn).__streamOptions;

			// Enforce stream filter/access predicate before subscribing
			const streamFilter = /** @type {any} */ (fn).__streamFilter;
			if (streamFilter && !streamFilter(ctx)) {
				return { id, ok: false, error: 'Access denied' };
			}

			ws.subscribe(topic);
			const result = await fn(ctx, ...args);
			return {
				id, ok: true, data: result, topic, merge: streamOpts.merge,
				key: streamOpts.key, prepend: streamOpts.prepend, max: streamOpts.max
			};
		} else {
			const result = await fn(ctx, ...args);
			return { id, ok: true, data: result };
		}
		}); // end _runWithMiddleware
	} catch (err) {
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
				'\nUse throw new LiveError(code, message) for client-visible errors. Raw errors are hidden from clients.'
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

	const fn = registry.get(path);
	if (!fn) {
		_respond(ws, platform, id, { ok: false, code: 'NOT_FOUND', error: 'Not found' });
		return;
	}

	if (!/** @type {any} */ (fn).__isBinary) {
		_respond(ws, platform, id, { ok: false, code: 'INVALID_REQUEST', error: 'Not a binary endpoint' });
		return;
	}

	const _h = _getCtxHelpers(platform);
	const ctx = {
		user: ws.getUserData(),
		ws,
		platform,
		publish: _h.publish,
		cursor: null,
		throttle: _h.throttle,
		debounce: _h.debounce
	};

	try {
		await _runWithMiddleware(ctx, async () => {
			const modulePath = path.substring(0, path.lastIndexOf('/'));
			const guardFn = guards.get(modulePath);
			if (guardFn) await guardFn(ctx);

			if (options?.beforeExecute) {
				await options.beforeExecute(ws, path, [payload, ...(extraArgs || [])]);
			}

			const result = await fn(ctx, payload, ...(extraArgs || []));
			_respond(ws, platform, id, { ok: true, data: result });
		});
	} catch (err) {
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
	const key = topic + '\0' + event;
	const existing = _throttles.get(key);
	const now = Date.now();

	if (!existing) {
		// First call -- publish immediately, set up trailing edge
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
			platform,
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
	const key = topic + '\0' + event;
	const existing = _debounces.get(key);
	if (existing) clearTimeout(existing);

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
			console.warn(`[svelte-realtime] Missing migration function for version ${v} -> ${v + 1}`);
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
				'large responses may exceed maxPayloadLength (16KB). Increase maxPayloadLength in adapter config if needed.'
			);
		}
	}
	const result = platform.send(ws, '__rpc', correlationId, payload);
	if (result === 0 && typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
		console.warn(
			`[svelte-realtime] RPC response was not delivered (backpressure or closed connection)`
		);
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
	const fn = registry.get(path);
	if (!fn) {
		throw new LiveError('NOT_FOUND', `Live function '${path}' not found`);
	}

	const _h = _getCtxHelpers(platform);
	const ctx = {
		user: options?.user || null,
		ws: null,
		platform,
		publish: _h.publish,
		cursor: null,
		throttle: _h.throttle,
		debounce: _h.debounce,
		signal: _h.signal
	};

	// Run global middleware chain, then guard, then execution
	return _runWithMiddleware(ctx, async () => {
	// Run module guard
	const modulePath = path.substring(0, path.lastIndexOf('/'));
	const guardFn = guards.get(modulePath);
	if (guardFn) await guardFn(ctx);

	if (/** @type {any} */ (fn).__isStream) {
		// For streams, just call the initFn and return data (no subscribe)
		return fn(ctx, ...args);
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

export function close(ws, { platform }) {
	if (_streamsWithUnsubscribe.size === 0) return;

	const user = ws.getUserData();
	const closeCtx = { user, ws, platform, publish: _getCtxHelpers(platform).publish, cursor: null };

	// Get the actual topics this socket was subscribed to
	const subscribedTopics = typeof ws.getTopics === 'function' ? ws.getTopics() : null;
	/** @type {Set<string> | null} */
	let subscribedSet = null;

	// Separate static and dynamic streams to avoid redundant iteration
	/** @type {Function[]} */
	const dynamicStreams = [];

	for (const fn of _streamsWithUnsubscribe) {
		const rawTopic = /** @type {any} */ (fn).__streamTopic;
		if (typeof rawTopic === 'string') {
			// Static topic: only fire if the socket was actually subscribed
			if (!subscribedTopics) {
				try { /** @type {any} */ (fn).__onUnsubscribe(closeCtx, rawTopic); } catch {}
			} else {
				if (!subscribedSet) subscribedSet = new Set(subscribedTopics);
				if (subscribedSet.has(rawTopic)) {
					try { /** @type {any} */ (fn).__onUnsubscribe(closeCtx, rawTopic); } catch {}
				}
			}
		} else if (typeof rawTopic === 'function') {
			dynamicStreams.push(fn);
		}
	}

	// For dynamic streams, iterate user topics once and fire all matching hooks
	if (dynamicStreams.length > 0 && subscribedTopics) {
		const topics = subscribedSet || new Set(subscribedTopics);
		for (const t of topics) {
			if (t.startsWith('__')) continue;
			for (const fn of dynamicStreams) {
				try { /** @type {any} */ (fn).__onUnsubscribe(closeCtx, t); } catch {}
			}
		}
	}
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
