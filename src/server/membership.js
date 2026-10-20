// @ts-check
import { trackedSubscribe, trackedUnsubscribe, releaseSubscription } from 'svelte-adapter-uws/subscriptions';

export { trackedUnsubscribe, releaseSubscription };

/**
 * Subscribe a socket to a topic the server owns, outside the adapter's
 * `platform.subscribe` admission (signals, or a platform that does not expose
 * it). Membership goes through the adapter's registry, so it counts against the
 * per-connection subscription cap and is reached by per-subscriber publish
 * walks, which a bare `ws.subscribe` skips.
 * @param {any} ws
 * @param {string} topic
 * @returns {null | 'RATE_LIMITED' | 'CONNECTION_CLOSED'} null when subscribed
 */
export function _subscribeTracked(ws, topic) {
	if (trackedSubscribe(ws, topic)) return null;
	try { ws.getUserData(); } catch { return 'CONNECTION_CLOSED'; }
	return 'RATE_LIMITED';
}
