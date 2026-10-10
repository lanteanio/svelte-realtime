import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_PORT, PROD_PORT } from './ports.js';
import teardown from './global-teardown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, '../fixture');

function stripAnsi(str) {
	return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function isReady(text) {
	const clean = stripAnsi(text);
	return clean.includes('localhost:') || clean.includes('Listening on');
}

function startServer(script, port) {
	return new Promise((resolve, reject) => {
		const proc = spawn('node', [path.resolve(__dirname, script), String(port)], {
			cwd: fixtureDir,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env }
		});

		let output = '';
		let resolved = false;

		const timeout = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				proc.kill();
				reject(new Error('Server did not start within 120s.\noutput: ' + output));
			}
		}, 120000);

		function check() {
			if (!resolved && isReady(output)) {
				resolved = true;
				clearTimeout(timeout);
				resolve(proc);
			}
		}

		proc.stdout.on('data', (chunk) => { output += chunk.toString(); check(); });
		proc.stderr.on('data', (chunk) => { output += chunk.toString(); check(); });

		proc.on('error', (err) => {
			if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); }
		});

		proc.on('exit', (code) => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timeout);
				reject(new Error('Server exited with code ' + code + '.\noutput: ' + output));
			}
		});
	});
}

export default async function globalSetup() {
	globalThis.__e2eServers = [];
	try {
		globalThis.__e2eServers.push(await startServer('dev-server.js', DEV_PORT));
		globalThis.__e2eServers.push(await startServer('prod-server.js', PROD_PORT));
	} catch (error) {
		await teardown();
		throw error;
	}
}
