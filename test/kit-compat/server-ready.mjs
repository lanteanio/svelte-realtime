// Wait until the spawned fixture itself accepts a WebSocket and identifies
// itself. Its hooks.ws open hook sends this run's token and its process ID.
//
// An accepted TCP connection proves nothing: Vite 8 briefly listens on the port
// to check that it is free, then initializes before it binds for real. So
// attempts are retried only until a socket opens. Once one is open, the
// identity decides; no RPC is made, so the first RPC is left to the caller.
export async function waitForFixture({ child, connect, token, timeoutMs = 30000, identityTimeoutMs = 10000 }) {
	const deadline = Date.now() + timeoutMs;
	let reason = 'no attempt finished';
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) throw new Error('Server exited before becoming ready');
		const result = await attempt(connect, Math.min(1000, deadline - Date.now()), identityTimeoutMs);
		if ('identity' in result) {
			const { identity } = result;
			if (identity.token !== token || identity.pid !== child.pid) {
				throw new Error('Another server answered on the port: ' + JSON.stringify(identity));
			}
			return identity;
		}
		if (result.failure) throw new Error('The server did not identify itself: ' + result.failure);
		reason = result.retry;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error('Fixture did not become ready: ' + reason);
}

function attempt(connect, openTimeoutMs, identityTimeoutMs) {
	return new Promise(resolve => {
		let socket;
		let opened = false;
		let settled = false;
		let timer;
		function finish(result) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (typeof socket?.terminate === 'function') socket.terminate();
			else socket?.close();
			resolve(result);
		}
		try {
			socket = connect();
		} catch (error) {
			resolve({ retry: 'connect threw: ' + error.message });
			return;
		}
		timer = setTimeout(() => finish({ retry: 'socket did not open' }), openTimeoutMs);
		socket.addEventListener('open', () => {
			if (settled) return;
			opened = true;
			clearTimeout(timer);
			timer = setTimeout(() => finish({ failure: 'no identity within ' + identityTimeoutMs + ' ms' }), identityTimeoutMs);
		});
		socket.addEventListener('message', event => {
			let frame;
			try { frame = JSON.parse(String(event.data)); } catch { return; }
			if (frame?.type !== 'kit-compat-identity') return;
			finish({ identity: { token: frame.token, pid: frame.pid } });
		});
		socket.addEventListener('error', event => {
			const detail = event.message || event.error?.message || 'socket error';
			finish(opened ? { failure: detail } : { retry: detail });
		});
		socket.addEventListener('close', event => {
			const detail = 'socket closed (' + event.code + ')';
			finish(opened ? { failure: detail } : { retry: detail });
		});
	});
}
