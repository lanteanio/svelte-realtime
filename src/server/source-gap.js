// @ts-check
import { SOURCE_GAP_EVENT } from '../shared/source-gap.js';

/**
 * Tell mounted streams that an external change source lost delivery.
 * @param {import('svelte-adapter-uws').Platform} platform
 * @param {string} topic
 * @param {{ source: string, reason?: string, jitterMs?: number }} options
 */
export function sourceGap(platform, topic, options) {
	if (!platform || typeof platform.publish !== 'function') throw new TypeError('sourceGap requires a platform with publish()');
	if (typeof topic !== 'string' || topic.length === 0 || topic.startsWith('__')) throw new TypeError('sourceGap topic must be a non-empty application topic');
	if (!options || typeof options.source !== 'string' || options.source.trim().length === 0) throw new TypeError('sourceGap source must be a non-empty string');
	if (options.reason !== undefined && typeof options.reason !== 'string') throw new TypeError('sourceGap reason must be a string');
	if (options.jitterMs !== undefined && (typeof options.jitterMs !== 'number' || !Number.isFinite(options.jitterMs) || options.jitterMs < 0 || options.jitterMs > 60000)) {
		throw new TypeError('sourceGap jitterMs must be a finite number in [0, 60000]');
	}
	const data = { source: options.source };
	if (options.reason !== undefined) data.reason = options.reason;
	const publishOptions = { seq: false };
	if (options.jitterMs !== undefined) publishOptions.jitterMs = options.jitterMs;
	return platform.publish(topic, SOURCE_GAP_EVENT, data, publishOptions);
}
