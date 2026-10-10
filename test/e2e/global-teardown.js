export default async function globalTeardown() {
	const servers = globalThis.__e2eServers || [];
	for (const proc of servers) {
		if (proc.exitCode !== null || proc.signalCode !== null) continue;
		await new Promise((resolve) => {
			const timeout = setTimeout(() => { proc.kill(); resolve(); }, 5000);
			proc.once('exit', () => { clearTimeout(timeout); resolve(); });
			proc.stdin.end();
		});
	}
}
