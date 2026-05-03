// Spawn one realtime instance for the chaos harness. Reads PORT and
// REDIS_URL from argv / env, builds the fixture once if a build/ tree
// is missing, then loads `build/index.js`. Mirrors the existing
// prod-server.js shape so the chaos suite uses the same uWS + adapter
// + svelte-realtime artifact path the production e2e suite uses.
//
// argv[2] = PORT
// argv[3] = REDIS_URL (optional - when set, the fixture's hooks.ws.js
//                     wires the extensions Redis pubsub bus so this
//                     instance fans out publishes to the cluster)
// argv[4] = INSTANCE_ID (optional, for log prefixing)

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, '../fixture');

const port = process.argv[2] || process.env.PORT;
const redisUrl = process.argv[3] || process.env.REDIS_URL;
const instanceId = process.argv[4] || process.env.INSTANCE_ID || 'inst';

if (!port) {
	console.error('chaos instance-server: pass a port via argv[2] or PORT env');
	process.exit(1);
}

const buildIndex = path.join(fixtureDir, 'build', 'index.js');
if (!existsSync(buildIndex)) {
	console.error('[chaos/' + instanceId + '] building fixture...');
	execSync('npx vite build', { cwd: fixtureDir, stdio: 'inherit' });
}

process.env.PORT = String(port);
process.env.HOST = '127.0.0.1';
if (redisUrl) process.env.REDIS_URL = redisUrl;
process.env.CHAOS_INSTANCE_ID = instanceId;

await import('file:///' + buildIndex.replace(/\\/g, '/'));

process.stdin.resume();
process.stdin.on('end', () => {
	process.exit(0);
});
