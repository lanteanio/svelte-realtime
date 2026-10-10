// Spawn one realtime instance for the chaos harness. Reads PORT and
// REDIS_URL from argv / env and loads its private prebuilt fixture.
// Mirrors the existing
// prod-server.js shape so the chaos suite uses the same uWS + adapter
// + svelte-realtime artifact path the production e2e suite uses.
//
// argv[2] = PORT
// argv[3] = REDIS_URL (optional - when set, the fixture's hooks.ws.js
//                     wires the extensions Redis pubsub bus so this
//                     instance fans out publishes to the cluster)
// argv[4] = INSTANCE_ID (optional, for log prefixing)
// argv[5] = CLEANUP_PORT (localhost-only authenticated shutdown endpoint)
// argv[6] = CLEANUP_TOKEN (proves PID ownership before persisted cleanup)

import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const fixtureDir = process.env.REALTIME_CHAOS_FIXTURE;
if (!fixtureDir || !path.isAbsolute(fixtureDir)) throw new Error('Chaos instance requires its isolated fixture path');

const port = process.argv[2] || process.env.PORT;
const redisUrl = process.argv[3] || process.env.REDIS_URL;
const instanceId = process.argv[4] || process.env.INSTANCE_ID || 'inst';
const cleanupPort = Number(process.argv[5]);
const cleanupToken = process.argv[6];

if (!port || !Number.isInteger(cleanupPort) || cleanupPort <= 0 || !cleanupToken) {
	console.error('chaos instance-server: pass PORT, CLEANUP_PORT, and CLEANUP_TOKEN');
	process.exit(1);
}

const cleanupServer = createServer((request, response) => {
	if (request.method !== 'POST' || request.url !== '/__chaos__/shutdown') {
		response.writeHead(404).end();
		return;
	}
	if (request.headers['x-chaos-cleanup-token'] !== cleanupToken) {
		response.writeHead(403).end();
		return;
	}
	response.writeHead(202, { 'content-type': 'text/plain' });
	response.end('shutting down');
	setTimeout(() => process.exit(0), 25).unref();
});
await new Promise((resolve, reject) => {
	cleanupServer.once('error', reject);
	cleanupServer.listen(cleanupPort, '127.0.0.1', resolve);
});

const buildIndex = path.join(fixtureDir, 'build', 'index.js');
if (!existsSync(buildIndex)) {
	throw new Error('Chaos fixture must be built before starting an instance');
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
