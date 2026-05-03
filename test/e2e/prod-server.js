// Build the fixture once and start the production server. The built
// server reads PORT/HOST from env. Exits cleanly when stdin closes
// (Playwright teardown). Port arrives as argv[2] from global-setup.

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, '../fixture');

execSync('npx vite build', { cwd: fixtureDir, stdio: 'pipe' });

const port = process.argv[2] || process.env.E2E_PROD_PORT;
if (!port) {
	console.error('prod-server: pass a port via argv[2] or E2E_PROD_PORT env');
	process.exit(1);
}
process.env.PORT = port;
process.env.HOST = '127.0.0.1';

await import('file:///' + path.join(fixtureDir, 'build', 'index.js').replace(/\\/g, '/'));

process.stdin.resume();
process.stdin.on('end', () => {
	process.exit(0);
});
