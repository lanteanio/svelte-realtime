// Tier-4 chaos teardown: kills the two instance procs and brings
// docker-compose down. Tolerates missing __chaosCtx so the teardown
// is safe to run twice or after a partial setup.

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function globalTeardown() {
	const ctx = globalThis.__chaosCtx;
	if (ctx && Array.isArray(ctx.instances)) {
		for (const proc of ctx.instances) {
			try { proc.kill(); } catch {}
		}
	}
	try {
		execSync('docker compose down -v --remove-orphans', {
			cwd: __dirname,
			stdio: 'pipe'
		});
	} catch {
		// Compose may have nothing to tear down; ignore.
	}
}
