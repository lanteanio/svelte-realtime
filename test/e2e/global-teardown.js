export default async function globalTeardown() {
	const servers = globalThis.__e2eServers || [];
	for (const proc of servers) {
		proc.stdin.end();
		await new Promise((resolve) => {
			const timeout = setTimeout(() => { proc.kill(); resolve(); }, 5000);
			proc.on('exit', () => { clearTimeout(timeout); resolve(); });
		});
	}
}
