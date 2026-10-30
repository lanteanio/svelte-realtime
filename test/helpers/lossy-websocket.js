// A WebSocket in front of the platform one that lets a test lose, repeat and
// reorder inbound frames between a real server and the real client. The test
// sets `link.inbound(event, deliver, socket)` to decide what reaches the
// client's onmessage handler; without it every frame passes through. Text
// frames the client sends are kept, parsed, in `link.sent`.

/**
 * Install the lossy socket as the global WebSocket.
 * @returns {{ link: { inbound: null | ((event: any, deliver: (event?: any) => void, socket: any) => void), sockets: any[], sent: any[] }, Native: typeof WebSocket, restore: () => void }}
 */
export function installLossyWebSocket() {
	const Native = globalThis.WebSocket;
	const link = { inbound: null, sockets: [], sent: [] };
	class LossyWebSocket extends Native {
		constructor(...args) {
			super(...args);
			link.sockets.push(this);
		}

		send(data) {
			if (typeof data === 'string') {
				try {
					const frame = JSON.parse(data);
					link.sent.push(...(Array.isArray(frame.batch) ? frame.batch : [frame]));
				} catch { /* not JSON */ }
			}
			super.send(data);
		}

		get onmessage() {
			return super.onmessage;
		}

		set onmessage(handler) {
			if (typeof handler !== 'function') {
				super.onmessage = handler;
				return;
			}
			super.onmessage = (event) => {
				const deliver = (e = event) => handler.call(this, e);
				if (link.inbound) link.inbound(event, deliver, this);
				else deliver();
			};
		}
	}
	globalThis.WebSocket = LossyWebSocket;
	return { link, Native, restore() { globalThis.WebSocket = Native; } };
}

/**
 * The topic of an inbound frame: the JSON envelope's topic, or `null` for a
 * binary frame (resolve those by what the test sends on the wire).
 * @param {any} event
 */
export function frameTopic(event) {
	if (typeof event.data !== 'string') return null;
	try {
		const msg = JSON.parse(event.data);
		return typeof msg.topic === 'string' ? msg.topic : null;
	} catch {
		return null;
	}
}
