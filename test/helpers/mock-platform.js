/**
 * Create a mock platform that records publish/send calls.
 * Matches the core svelte-adapter-uws Platform interface.
 */
export function mockPlatform() {
	const p = {
		published: [],
		sent: [],
		coalesced: [],
		connections: 0,
		publish(topic, event, data, options) {
			p.published.push({ topic, event, data, options });
			return true;
		},
		send(ws, topic, event, data) {
			p.sent.push({ ws, topic, event, data });
			return 1;
		},
		sendCoalesced(ws, payload) {
			p.coalesced.push({ ws, ...payload });
			return true;
		},
		sendTo(filter, topic, event, data) {
			return 0;
		},
		subscribers(topic) {
			return 0;
		},
		batch(messages) {
			for (const msg of messages) {
				p.publish(msg.topic, msg.event, msg.data, msg.options);
			}
		},
		topic(t) {
			return {
				publish(event, data) { p.publish(t, event, data); },
				created(data) { p.publish(t, 'created', data); },
				updated(data) { p.publish(t, 'updated', data); },
				deleted(data) { p.publish(t, 'deleted', data); },
				set(value) { p.publish(t, 'set', value); },
				increment(amount) { p.publish(t, 'increment', amount); },
				decrement(amount) { p.publish(t, 'decrement', amount); }
			};
		},
		reset() {
			p.published.length = 0;
			p.sent.length = 0;
			p.coalesced.length = 0;
		},
		// Default pressure snapshot. Tests override via _setPressure().
		pressure: { active: false, subscriberRatio: 0, publishRate: 0, memoryMB: 0, reason: 'NONE' },
		_setPressure(snapshot) {
			p.pressure = { active: false, subscriberRatio: 0, publishRate: 0, memoryMB: 0, reason: 'NONE', ...snapshot };
		}
	};
	return p;
}
