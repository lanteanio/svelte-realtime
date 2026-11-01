// Wait until the spawned fixture answers its readiness route with this run's
// token and the child's PID. The route is plain HTTP and loads no live module,
// so the first WebSocket RPC a run makes still meets a cold server.
// The .json suffix keeps Vite from attempting a client-module transform before
// the first page starts its dependency crawl.
export async function waitForFixture({ child, origin, token, timeoutMs = 30000 }) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) throw new Error('Server exited before becoming ready');
		let matched = false;
		try {
			const response = await fetch(origin + '/readiness.json', { signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))) });
			if (response.ok) {
				const body = await response.json();
				matched = body?.token === token && body?.pid === child.pid;
			} else await response.body?.cancel();
		} catch {}
		if (matched && child.exitCode === null && child.signalCode === null) return;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error('Fixture did not become ready');
}
