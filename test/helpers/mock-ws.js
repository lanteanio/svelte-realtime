/**
 * Create a mock WebSocket that mimics the uWS/vite wrapper API.
 * Injects __subscriptions and remoteAddress into userData to match adapter 0.4.0.
 * @param {Record<string, any>} [userData]
 */
export function mockWs(userData = {}) {
	const topics = new Map(); // topic -> refcount
	const topicSet = new Set(); // for __subscriptions compat
	userData.__subscriptions = topicSet;
	userData.remoteAddress = '127.0.0.1';
	return {
		getUserData: () => userData,
		subscribe: (topic) => {
			const rc = (topics.get(topic) || 0) + 1;
			topics.set(topic, rc);
			topicSet.add(topic);
			return true;
		},
		unsubscribe: (topic) => {
			const rc = (topics.get(topic) || 1) - 1;
			if (rc <= 0) { topics.delete(topic); topicSet.delete(topic); }
			else topics.set(topic, rc);
			return true;
		},
		isSubscribed: (topic) => topics.has(topic),
		getTopics: () => [...topics.keys()],
		_topics: topicSet
	};
}
