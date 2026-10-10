import { terminateChild } from '../chaos/process-lifecycle.js';

export default async function globalTeardown() {
	const servers = globalThis.__e2eServers || [];
	const results = await Promise.allSettled(servers.map(async (proc) => {
		if (proc.exitCode !== null || proc.signalCode !== null) return;
		await new Promise((resolve, reject) => {
			let timedOut = false;
			// Allow the realtime drain plus the adapter's default shutdown budget.
			const timeout = setTimeout(async () => {
				timedOut = true;
				try {
					await terminateChild(proc);
					reject(new Error('E2E server did not finish graceful shutdown within 40s'));
				} catch (error) { reject(error); }
			}, 40_000);
			proc.once('exit', (code) => {
				clearTimeout(timeout);
				if (timedOut) reject(new Error('E2E server exceeded the graceful shutdown budget'));
				else if (code === 0) resolve();
				else reject(new Error('E2E server exited during teardown with code ' + code));
			});
			proc.stdin.end();
		});
	}));
	const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
	if (errors.length) throw new AggregateError(errors, 'E2E server teardown failed');
}
