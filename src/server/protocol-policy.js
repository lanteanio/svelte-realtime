// @ts-check

const ACTIONS = new Set(['notify', 'reject']);

/**
 * Validate and freeze the strict protocol policy accepted by
 * `realtime({ protocolVersion: { current, minimum, onMismatch } })`.
 *
 * @param {unknown} value
 * @returns {{ current: number, minimum: number, onMismatch: 'notify' | 'reject' }}
 */
export function normalizeProtocolPolicy(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('[svelte-realtime] realtime({ protocolVersion }): policy must be an object { current, minimum, onMismatch }');
	}
	const { current, minimum, onMismatch } = /** @type {any} */ (value);
	if (!Number.isSafeInteger(current) || current < 0) {
		throw new Error('[svelte-realtime] realtime({ protocolVersion.current }): must be a non-negative safe integer');
	}
	if (!Number.isSafeInteger(minimum) || minimum < 0) {
		throw new Error('[svelte-realtime] realtime({ protocolVersion.minimum }): must be a non-negative safe integer');
	}
	if (minimum > current) {
		throw new Error('[svelte-realtime] realtime({ protocolVersion }): minimum must be less than or equal to current');
	}
	if (!ACTIONS.has(onMismatch)) {
		throw new Error("[svelte-realtime] realtime({ protocolVersion.onMismatch }): must be 'notify' or 'reject'");
	}
	return Object.freeze({ current, minimum, onMismatch });
}

/**
 * Classify one connection advertisement against a normalized policy.
 *
 * @param {{ current: number, minimum: number, onMismatch: 'notify' | 'reject' }} policy
 * @param {boolean} received
 * @param {unknown} advertised
 * @returns {'missing' | 'invalid' | 'too-old' | 'too-new' | null}
 */
export function protocolMismatchReason(policy, received, advertised) {
	if (!received) return 'missing';
	if (!Number.isSafeInteger(advertised) || /** @type {number} */ (advertised) < 0) return 'invalid';
	if (/** @type {number} */ (advertised) < policy.minimum) return 'too-old';
	if (/** @type {number} */ (advertised) > policy.current) return 'too-new';
	return null;
}

/** @param {'missing' | 'invalid' | 'too-old' | 'too-new'} reason */
export function protocolMismatchMessage(reason) {
	if (reason === 'missing') return 'Client protocol version was not advertised';
	if (reason === 'invalid') return 'Client protocol version is invalid';
	if (reason === 'too-old') return 'Client protocol version is below the server minimum';
	return 'Client protocol version is newer than this server';
}
