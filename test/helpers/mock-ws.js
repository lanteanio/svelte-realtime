/**
 * Create a mock WebSocket that mimics the uWS/vite wrapper API.
 * @param {Record<string, any>} [userData]
 */
export function mockWs(userData = {}) {
	const topics = new Set();
	return {
		getUserData: () => userData,
		subscribe: (topic) => { topics.add(topic); return true; },
		unsubscribe: (topic) => { topics.delete(topic); return true; },
		isSubscribed: (topic) => topics.has(topic),
		getTopics: () => [...topics],
		_topics: topics
	};
}
