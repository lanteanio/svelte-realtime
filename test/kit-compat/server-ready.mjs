export async function waitForFixture({ child, origin, token, WebSocket, timeoutMs = 30000 }) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) throw new Error('Server exited before becoming ready');
		const matched = await new Promise(resolve => {
			const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/ws');
			const id = 'ready-' + token;
			let settled = false;
			const timer = setTimeout(() => finish(false), Math.min(1000, deadline - Date.now()));
			function finish(result) {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (typeof socket.terminate === 'function') socket.terminate();
				else socket.close();
				resolve(result);
			}
			socket.addEventListener('open', () => {
				if (!settled) socket.send(JSON.stringify({ rpc: 'counter/readiness', id, args: [] }));
			});
			socket.addEventListener('message', event => {
				let frame;
				try { frame = JSON.parse(String(event.data)); } catch { return; }
				if (frame.topic !== '__rpc' || frame.event !== id) return;
				finish(frame.data?.ok === true && frame.data.data?.token === token && frame.data.data?.pid === child.pid);
			});
			socket.addEventListener('error', () => finish(false));
			socket.addEventListener('close', () => finish(false));
		});
		if (matched && child.exitCode === null && child.signalCode === null) return;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error('Fixture did not become ready');
}
