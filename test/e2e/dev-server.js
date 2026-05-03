// Start the fixture's Vite dev server programmatically. Exits cleanly
// when stdin closes (Playwright teardown). Port arrives as argv[2] from
// global-setup, with E2E_DEV_PORT env as fallback for standalone runs.

import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, '../fixture');

const port = parseInt(process.argv[2] || process.env.E2E_DEV_PORT || '0', 10);
if (!port) {
	console.error('dev-server: pass a port via argv[2] or E2E_DEV_PORT env');
	process.exit(1);
}

const server = await createServer({
	configFile: path.join(fixtureDir, 'vite.config.js'),
	root: fixtureDir,
	server: { port, strictPort: true }
});
await server.listen();
server.printUrls();

process.stdin.resume();
process.stdin.on('end', async () => {
	await server.close();
	process.exit(0);
});
