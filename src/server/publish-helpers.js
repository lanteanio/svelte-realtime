// @ts-check
import { now as runtimeNow, setTimer, clearTimer } from '../shared/runtime.js';
import { LiveError } from './live-error.js';
import { _IS_DEV } from './env.js';

// Dev-warn dedup flags for the publish helpers below (one-shot per category).
/** Dev-warn dedup: per-helper bad-args warning. Keys: 'publishThrottled', 'publishDebounced', 'throttle', 'debounce'. */
/** @type {Record<string, boolean>} */
const _publishHelperBadArgsWarned = Object.create(null);
/** Dev-warn dedup: one-time "ctx.skip gate map at capacity" warning. */
let _skipGateCapWarned = false;

// - Throttle / Debounce infrastructure ----------------------------------------

/** Hard cap on throttle/debounce entries to prevent memory exhaustion */
const _THROTTLE_DEBOUNCE_MAX = 5000;

/** @type {Map<string, { timer: ReturnType<typeof setTimeout>, lastData: any, lastEvent: string, platform: any, lastRun: number }>} */
export const _throttles = new Map();

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
export const _debounces = new Map();

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
export function _throttlePublish(platform, topic, event, data, ms) {
	const entityKey = data && typeof data === 'object' && data.key !== undefined ? '\0' + data.key : '';
	const key = topic + '\0' + event + entityKey;
	const existing = _throttles.get(key);
	const now = runtimeNow();

	if (!existing) {
		if (_throttles.size >= _THROTTLE_DEBOUNCE_MAX) {
			// At capacity - publish immediately without a trailing-edge timer
			// so data is never silently dropped
			platform.publish(topic, event, data);
			return;
		}
		platform.publish(topic, event, data);
		_throttles.set(key, {
			timer: setTimer(() => {
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

	// Subsequent calls within the window - store for trailing edge
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
export function _debouncePublish(platform, topic, event, data, ms) {
	const entityKey = data && typeof data === 'object' && data.key !== undefined ? '\0' + data.key : '';
	const key = topic + '\0' + event + entityKey;
	const existing = _debounces.get(key);
	if (existing) clearTimer(existing);

	if (!existing && _debounces.size >= _THROTTLE_DEBOUNCE_MAX) {
		// At capacity - publish immediately instead of evicting an active timer
		platform.publish(topic, event, data);
		return;
	}

	_debounces.set(key, setTimer(() => {
		_debounces.delete(key);
		platform.publish(topic, event, data);
	}, ms));
}

/**
 * Per-key gate state. Each entry is a setTimeout handle that self-deletes
 * the key when its cooldown window elapses. Shape mirrors `_throttles` /
 * `_debounces` so memory accounting and cap semantics are uniform.
 *
 * @type {Map<string, ReturnType<typeof setTimeout>>}
 */
const _skipGates = new Map();

/**
 * Per-key rate gate. Returns `true` to skip the call (key is within its
 * cooldown window), `false` to run it (no entry, or window elapsed). The
 * caller pairs this with an early `return` inside an RPC handler:
 *
 *     export const moveNote = live(async (ctx, noteId, x, y) => {
 *       if (ctx.skip(`move:${noteId}`, 16)) return;  // drop calls within 16ms
 *       await dbUpdateNote(noteId, x, y);
 *       ctx.publish(TOPICS.notes, 'updated', { noteId, x, y });
 *     });
 *
 * Pairs with `ctx.shed` semantically (both return `true` to early-return),
 * so call sites read uniformly. Different from `ctx.publishThrottled` /
 * `ctx.publishDebounced` which schedule outbound publishes - `ctx.skip`
 * gates the inbound handler body.
 *
 * **Memory:** capped at `_THROTTLE_DEBOUNCE_MAX` (5000) entries. When the
 * cap is hit, the gate fails open (returns `false`, does NOT stamp a new
 * entry) so a runaway dynamic-key generator (e.g. spraying unique keys to
 * exhaust the map) cannot silently start blocking legitimate calls. The
 * first cap-hit fires a one-shot dev warning so operators see the issue.
 *
 * **Cluster:** state is per-replica. Each replica that received an RPC
 * call evaluates `ctx.skip` against its local map; the gate is a CPU/DB
 * shed, not a cluster-wide ratelimit. For cross-replica gating use
 * `live.rateLimit({ store: 'redis' })` or `redis/ratelimit`.
 *
 * @param {string} key
 * @param {number} ms
 * @returns {boolean} `true` to skip the call; `false` to run it
 */
export function _skipGate(key, ms) {
	if (typeof key !== 'string') {
		throw new LiveError('INVALID_ARG', 'ctx.skip: key must be a string (got ' + (typeof key) + ')');
	}
	if (typeof ms !== 'number' || !(ms > 0) || !Number.isFinite(ms)) {
		throw new LiveError('INVALID_ARG', 'ctx.skip: ms must be a positive finite number (got ' + String(ms) + ')');
	}
	if (_skipGates.has(key)) return true;
	if (_skipGates.size >= _THROTTLE_DEBOUNCE_MAX) {
		if (_IS_DEV && !_skipGateCapWarned) {
			_skipGateCapWarned = true;
			console.warn(
				'[svelte-realtime] ctx.skip: gate map at capacity (' + _THROTTLE_DEBOUNCE_MAX + ' entries). ' +
				'Falling open - calls are no longer being gated. Check for runaway dynamic-key generation ' +
				'(e.g. unique-per-request keys).\n' +
				'  See: https://svti.me/skip-gate'
			);
		}
		return false;
	}
	_skipGates.set(key, setTimer(() => { _skipGates.delete(key); }, ms));
	return false;
}

/**
 * Dev-only sanity check for `ctx.publishThrottled` / `ctx.publishDebounced`
 * (and the deprecated `ctx.throttle` / `ctx.debounce` aliases). Logs a
 * one-time warning per helper name when args don't match the publish-
 * helper shape `(topic: string, event: string, data: any, ms: number > 0)`.
 *
 * The misuse pattern is calling `ctx.throttle('move:id', 50)` thinking it
 * gates a handler - it doesn't, it's a 4-arg publish helper. The warning
 * points at `ctx.skip(key, ms)` as the actual gate primitive.
 *
 * Production silently continues (no throw) so existing buggy deployments
 * don't crash on adapter upgrade; the dev warning surfaces the issue at
 * code-change time, not at runtime.
 *
 * @param {string} name - bare helper name (e.g. `'publishThrottled'`)
 * @param {ReadonlyArray<unknown>} args - the call's argument list
 */
export function _checkPublishHelperArgs(name, args) {
	if (!_IS_DEV) return;
	if (_publishHelperBadArgsWarned[name]) return;
	const ok = args.length >= 4
		&& typeof args[0] === 'string'
		&& typeof args[1] === 'string'
		&& typeof args[3] === 'number'
		&& /** @type {number} */ (args[3]) > 0
		&& Number.isFinite(/** @type {number} */ (args[3]));
	if (ok) return;
	_publishHelperBadArgsWarned[name] = true;
	console.warn(
		'[svelte-realtime] ctx.' + name + ' called with bad args -- expected ' +
		'(topic: string, event: string, data: any, ms: number > 0). Got ' +
		'argc=' + args.length + ', topic=' + (typeof args[0]) +
		', event=' + (typeof args[1]) +
		', ms=' + (typeof args[3] === 'number' ? String(args[3]) : typeof args[3]) + '. ' +
		'ctx.' + name + ' is a publish helper, not a handler gate. ' +
		'For per-key handler gating use ctx.skip(key, ms); for handler-wide rate ' +
		'limiting use live.rateLimit().\n' +
		'  See: https://svti.me/publish-helper-args'
	);
}
