// @ts-check
import { state } from './state.js';

/** Valid pressure reasons accepted in admission rules. Mirrors the adapter's PressureReason enum. */
const _PRESSURE_REASONS = new Set(['NONE', 'PUBLISH_RATE', 'SUBSCRIBERS', 'MEMORY']);

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
const _liveAdmission = function admission(config) {
	if (config === null || config === undefined) { state.admissionConfig = null; return; }
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
	state.admissionConfig = { classes };
};

/**
 * Reset the admission configuration. Tests only.
 * @internal
 */
export function _resetAdmission() {
	state.admissionConfig = null;
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
export function _shouldShed(platform, className) {
	if (!state.admissionConfig) return false;
	const rule = state.admissionConfig.classes[className];
	if (rule === undefined) {
		const known = Object.keys(state.admissionConfig.classes).join(', ') || '<none>';
		throw new Error(`[svelte-realtime] ctx.shed: unknown class '${className}'. Configured: ${known}`);
	}
	const snapshot = platform && platform.pressure;
	if (!snapshot) return false;
	if (typeof rule === 'function') return !!rule(snapshot);
	return rule.includes(snapshot.reason);
}

export function installAdmission(live) { live.admission = _liveAdmission; }
