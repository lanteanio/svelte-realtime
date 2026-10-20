import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, rename, unlink, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
	const index = args.indexOf(name);
	return index < 0 ? fallback : args[index + 1];
}
const kit = option('--kit', '3');
const mode = option('--mode', 'dev');
assert.ok(['2', '3'].includes(kit), '--kit must be 2 or 3');
assert.ok(['dev', 'production'].includes(mode), '--mode must be dev or production');
const hmr = args.includes('--hmr');
assert.ok(!hmr || mode === 'dev', '--hmr requires --mode dev');
const devtools = !args.includes('--no-devtools');
const adapterMode = option('--adapter', 'default');
assert.ok(['default', 'wrapped', 'none'].includes(adapterMode), 'Unknown adapter mode');
assert.ok(adapterMode === 'default' || (kit === '3' && mode === 'dev'), 'Adapter variants require Kit 3 dev');
const driveCase = option('--drive-case', 'as-invoked');
assert.ok(['as-invoked', 'lower'].includes(driveCase), '--drive-case must be lower');
assert.ok(driveCase === 'as-invoked' || (process.platform === 'win32' && kit === '3'), '--drive-case requires Windows and Kit 3');
const fixture = path.join(root, 'test', 'fixtures', 'kit' + kit);
// Vite 8 realpaths its root, which on Windows upper-cases the drive letter,
// while SvelteKit keeps the working directory as spelled.
const workdir = driveCase === 'lower' ? fixture.replace(/^[A-Za-z]:/, drive => drive.toLowerCase()) : fixture;
const requireFixture = createRequire(path.join(fixture, 'package.json'));
const { WebSocket } = requireFixture('ws');
// npm scripts start Vite under the same spelling as the working directory.
const vite = path.join(workdir, 'node_modules', 'vite', 'bin', 'vite.js');
const reportPath = path.resolve(option('--report', path.join(root, 'test-results',
	'kit-compat-' + kit + '-' + mode + (devtools ? '' : '-no-devtools') + '.json')));
const report = { kit, mode, devtools, hmr, adapterMode, driveCase, checks: [] };
const env = { ...process.env, KIT_COMPAT_SECRET: 'fixture-secret', KIT_COMPAT_DEVTOOLS: String(devtools), KIT_COMPAT_ADAPTER: adapterMode, KIT_COMPAT_REPORT_ROOT: String(driveCase !== 'as-invoked') };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let output = '';
let child;
let browser;
let socket;
let originalSource;
let originalRoute;
const routeFile = path.join(fixture, 'src/routes/state/+server.js');
const addedFile = path.join(fixture, 'src/live/extra.js');
let ownsAddedFile = false;
const liveFile = path.join(fixture, 'src', 'live', 'counter.js');

async function check(name, fn) {
	try {
		await fn();
		report.checks.push({ name, status: 'passed' });
		console.log('PASS ' + name);
	} catch (error) {
		report.checks.push({ name, status: 'failed', error: error.stack || String(error) });
		throw error;
	}
}

function start(argv, extraEnv = {}) {
	const proc = spawn(process.execPath, argv, {
		cwd: workdir, env: { ...env, ...extraEnv }, windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	proc.stdout.on('data', value => { output += value.toString(); });
	proc.stderr.on('data', value => { output += value.toString(); });
	proc.on('error', error => { output += '\n' + error.stack; });
	return proc;
}

async function availablePort() {
	const server = createServer();
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const port = server.address().port;
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	return port;
}

async function ready(port) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error('Server exited: ' + output);
		const listening = await new Promise(resolve => {
			const probe = createConnection({ host: '127.0.0.1', port });
			probe.setTimeout(500);
			probe.on('connect', () => { probe.destroy(); resolve(true); });
			probe.on('error', () => resolve(false));
			probe.on('timeout', () => { probe.destroy(); resolve(false); });
		});
		if (listening) return;
		await pause(50);
	}
	throw new Error('Server did not listen: ' + output);
}

async function connectSocket(origin) {
	socket?.terminate();
	socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Origin: origin } });
	await once(socket, 'open', { signal: AbortSignal.timeout(10000) });
}

let requestId = 0;
function rpc(name, args = []) {
	const id = 'compat-' + (++requestId);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error('RPC timed out: ' + name)), 10000);
		function finish(error, value) {
			clearTimeout(timer);
			socket.off('message', message);
			socket.off('error', fail);
			socket.off('close', closed);
			if (error) reject(error); else resolve(value);
		}
		function message(bytes) {
			let frame;
			try { frame = JSON.parse(bytes.toString()); } catch { return; }
			if (frame.topic === '__rpc' && frame.event === id) finish(null, frame.data);
		}
		const fail = error => finish(error);
		const closed = () => finish(new Error('WebSocket closed during RPC ' + name));
		socket.on('message', message);
		socket.on('error', fail);
		socket.on('close', closed);
		socket.send(JSON.stringify({ rpc: name.includes('/') ? name : 'counter/' + name, id, args }));
	});
}

try {
	const port = await availablePort();
	const origin = 'http://127.0.0.1:' + port;
	if (mode === 'production') {
		await check('production build', async () => {
			const buildDirectory = path.resolve(fixture, 'build');
			assert.equal(path.relative(fixture, buildDirectory), 'build');
			await rm(buildDirectory, { recursive: true, force: true });
			const build = start([vite, 'build']);
			const deadline = setTimeout(() => build.kill(), 120000);
			let code;
			try { [code] = await once(build, 'exit'); } finally { clearTimeout(deadline); }
			assert.equal(code, 0, output);
			await readFile(path.join(fixture, 'build', 'index.js'));
		});
		child = start(['build/index.js'], { HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin });
	} else {
		child = start([vite, '--force', '--host', '127.0.0.1', '--port', String(port), '--strictPort']);
	}
	await check('server startup', () => ready(port));
	if (driveCase !== 'as-invoked') {
		await check('Vite and SvelteKit spell the root differently', () => {
			const reported = output.match(/\[kit-compat\] vite root (.+)/)?.[1]?.trim();
			assert.ok(reported, 'Vite did not report its root');
			const kitRoot = workdir.split(path.sep).join('/');
			assert.equal(reported.toLowerCase(), kitRoot.toLowerCase(), 'Vite resolved another directory');
			assert.notEqual(reported, kitRoot, 'Vite kept the working directory spelling, so this run proves nothing');
		});
	}
	await check('cold WebSocket RPC before HTTP', async () => {
		await connectSocket(origin);
		const response = await rpc('echo', ['cold-start']);
		assert.equal(response.ok, true, JSON.stringify(response));
		assert.deepEqual(response.data, { value: 'cold-start', token: 'fixture-secret', label: 'initial' });
	});

	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext();
	const pageErrors = [];
	const frames = { sent: [], received: [] };
	const pages = [await context.newPage(), await context.newPage()];
	for (const page of pages) {
		page.setDefaultTimeout(15000);
		page.on('pageerror', error => { pageErrors.push(error.message); output += '\nBrowser error: ' + error.stack; });
		page.on('websocket', ws => {
			if (!new URL(ws.url()).pathname.endsWith('/ws')) return;
			ws.on('framesent', event => frames.sent.push(String(event.payload)));
			ws.on('framereceived', event => frames.received.push(String(event.payload)));
		});
	}
	await check('browser initial live stores', async () => {
		for (const page of pages) {
			const response = await page.goto(origin);
			assert.equal(response.status(), 200);
			await page.waitForFunction(() => window.compat);
			await expect(page.getByTestId('counter')).toHaveText('0');
		}
	});
	await check('browser RPC roundtrip', async () => {
		const response = await pages[0].evaluate(() => window.compat.echo('wire-value'));
		assert.deepEqual(response, { value: 'wire-value', token: 'fixture-secret', label: 'initial' });
		assert.ok(frames.sent.some(frame => frame.includes('counter/echo')), 'RPC request crossed /ws');
		assert.ok(frames.received.some(frame => frame.includes('wire-value')), 'RPC response crossed /ws');
	});
	await check('server-published live stores', async () => {
		assert.equal(await pages[0].evaluate(() => window.compat.increment(2)), 2);
		for (const page of pages) await expect(page.getByTestId('counter')).toHaveText('2');
	});
	await check('HTTP and WebSocket share state', async () => {
		const response = await fetch(origin + '/state', { signal: AbortSignal.timeout(5000) });
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { count: 2 });
	});
	await check('devtools runtime', async () => {
		for (const page of pages) {
			if (mode === 'dev' && devtools) {
				await page.waitForFunction(() => window.__svelte_realtime_devtools);
				await expect(page.locator('#svelte-realtime-devtools')).toHaveCount(1);
				await page.keyboard.press('Control+Shift+L');
				await expect(page.locator('#svelte-realtime-devtools')).toBeVisible();
			} else {
				assert.equal(await page.evaluate(() => typeof window.__svelte_realtime_devtools), 'undefined');
				await expect(page.locator('#svelte-realtime-devtools')).toHaveCount(0);
			}
		}
	});
	if (hmr) {
		await check('HMR replaces and removes handlers', async () => {
			const initial = await rpc('removed');
			assert.equal(initial.ok, true, JSON.stringify(initial));
			assert.equal(initial.data, 'original');
			originalSource = await readFile(liveFile);
			const source = originalSource.toString('utf8');
			const anchor = "export const removed = live(() => 'original');";
			assert.equal(source.split(anchor).length, 2, 'HMR source anchor must occur once');
			const changed = source.replace(anchor, "export const added = live(() => 'replacement');")
				.replace("label: 'initial'", "label: 'updated'");
			await writeFile(liveFile + '.next', changed);
			await rename(liveFile + '.next', liveFile);
			assert.equal((await readFile(liveFile, 'utf8')).includes(anchor), false, 'HMR edit reached disk');
			const deadline = Date.now() + 15000;
			let added;
			let reconnectError;
			while (Date.now() < deadline) {
				try {
					if (socket.readyState !== WebSocket.OPEN) await connectSocket(origin);
					added = await rpc('added');
					if (added.ok === true) break;
				} catch (error) {
					// A shared SSR environment reload can close existing sockets.
					// A timeout on an open socket is a handler failure, not a reconnect.
					if (socket.readyState === WebSocket.OPEN) throw error;
					reconnectError = error;
				}
				await pause(100);
			}
			assert.equal(added?.ok, true, JSON.stringify(added) || reconnectError?.message);
			assert.equal(added.data, 'replacement');
			const removed = await rpc('removed');
			assert.equal(removed.ok, false, JSON.stringify(removed));
			assert.equal(removed.code, 'NOT_FOUND');
			assert.equal((await rpc('echo', ['changed'])).data.label, 'updated');
		});
		await check('live stores after HMR', async () => {
			// A full SSR graph reload may recreate module-scoped state. All
			// reconnected stores must agree with the actual server baseline.
			const response = await fetch(origin + '/state', { signal: AbortSignal.timeout(5000) });
			assert.equal(response.status, 200);
			const baseline = (await response.json()).count;
			assert.equal(typeof baseline, 'number');
			for (const page of pages) {
				await expect(page.getByTestId('counter')).toHaveText(String(baseline));
				await page.waitForFunction(() => window.compat);
			}
			const count = await pages[0].evaluate(() => window.compat.increment(3));
			assert.equal(count, baseline + 3);
			for (const page of pages) await expect(page.getByTestId('counter')).toHaveText(String(count));
			const after = await fetch(origin + '/state', { signal: AbortSignal.timeout(5000) });
			assert.equal(after.status, 200);
			assert.deepEqual(await after.json(), { count });
		});
	}
	if (hmr) {
		await check('route-only HMR shares HTTP and WebSocket state', async () => {
			originalRoute = await readFile(routeFile);
			const route = originalRoute.toString('utf8');
			const anchor = 'Response.json({ count: state.count })';
			assert.equal(route.split(anchor).length, 2, 'Route source anchor must occur once');
			const changed = route.replace(anchor, "Response.json({ count: state.count }, { headers: { 'x-route-version': 'updated' } })");
			await writeFile(routeFile, changed);
			assert.notEqual(hash(await readFile(routeFile)), hash(originalRoute), 'Route edit reached disk');
			const deadline = Date.now() + 15000;
			let response;
			while (Date.now() < deadline) {
				response = await fetch(origin + '/state', { signal: AbortSignal.timeout(5000) });
				if (response.headers.get('x-route-version') === 'updated') break;
				await response.arrayBuffer();
				await pause(100);
			}
			assert.equal(response.headers.get('x-route-version'), 'updated', 'Route HMR executed');
			assert.equal(response.status, 200);
			await response.arrayBuffer();
			// A fresh socket must see the current registry even after route reloads.
			await connectSocket(origin);
			const echoed = await rpc('echo', ['route-reload']);
			assert.equal(echoed.ok, true, JSON.stringify(echoed));
			assert.deepEqual(echoed.data, { value: 'route-reload', token: 'fixture-secret', label: 'updated' });
			const baselineResponse = await fetch(origin + '/state', { signal: AbortSignal.timeout(5000) });
			assert.equal(baselineResponse.status, 200);
			const baseline = (await baselineResponse.json()).count;
			assert.equal(typeof baseline, 'number');
			for (const page of pages) {
				await expect(page.getByTestId('counter')).toHaveText(String(baseline));
				await page.waitForFunction(() => window.compat);
			}
			const count = await pages[0].evaluate(() => window.compat.increment(5));
			assert.equal(count, baseline + 5);
			for (const page of pages) await expect(page.getByTestId('counter')).toHaveText(String(count));
			const after = await fetch(origin + '/state', { signal: AbortSignal.timeout(5000) });
			assert.equal(after.status, 200);
			assert.deepEqual(await after.json(), { count });
		});
	}
	if (hmr) {
		async function waitForRpc(name, accepts) {
			const deadline = Date.now() + 15000;
			let result;
			while (Date.now() < deadline) {
				try {
					if (socket.readyState !== WebSocket.OPEN) await connectSocket(origin);
					result = await rpc(name);
					if (accepts(result)) return result;
				} catch (error) { if (socket.readyState === WebSocket.OPEN) throw error; }
				await pause(100);
			}
			throw new Error('RPC did not reach expected state: ' + name + ' ' + JSON.stringify(result));
		}
		async function sharedStores() {
			const response = await fetch(origin + '/state', { signal: AbortSignal.timeout(5000) });
			assert.equal(response.status, 200);
			const baseline = (await response.json()).count;
			assert.equal(typeof baseline, 'number');
			for (const page of pages) await expect(page.getByTestId('counter')).toHaveText(String(baseline));
			const count = await pages[0].evaluate(() => window.compat.increment(1));
			assert.equal(count, baseline + 1);
			for (const page of pages) await expect(page.getByTestId('counter')).toHaveText(String(count));
			const after = await fetch(origin + '/state', { signal: AbortSignal.timeout(5000) });
			assert.equal(after.status, 200);
			assert.deepEqual(await after.json(), { count });
			return count;
		}
		await check('new live files share HTTP and WebSocket state', async () => {
			await assert.rejects(readFile(addedFile), { code: 'ENOENT' });
			ownsAddedFile = true;
			await writeFile(addedFile, "import { live } from 'svelte-realtime/server';\nimport { state } from '../lib/server/state.js';\nexport const read = live(() => state.count);\n");
			await waitForRpc('extra/read', result => result.ok === true);
			const count = await sharedStores();
			assert.equal((await rpc('extra/read')).data, count);
		});
		await check('removed live files unregister without splitting state', async () => {
			await unlink(addedFile);
			await waitForRpc('extra/read', result => result.ok === false && result.code === 'NOT_FOUND');
			await sharedStores();
		});
	}
	await check('browser has no runtime errors', () => assert.deepEqual(pageErrors, []));
	await check('no unsupported HTML hook warning', () => {
		assert.doesNotMatch(output, /following plugins[\s\S]{0,500}transformIndexHtml/i);
	});
	report.status = 'passed';
} catch (error) {
	report.status = 'failed';
	report.error = error.stack || String(error);
	console.error(report.error + '\n' + output);
	process.exitCode = 1;
} finally {
	try {
		await browser?.close();
		socket?.terminate();
		if (child && child.exitCode === null) {
			const exited = once(child, 'exit');
			child.kill();
			const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
			try { await exited; } finally { clearTimeout(timer); }
		}
	} finally {
		if (originalSource) {
			await unlink(liveFile + '.next').catch(error => {
				if (error.code !== 'ENOENT') throw error;
			});
			await writeFile(liveFile, originalSource);
			assert.equal(hash(await readFile(liveFile)), hash(originalSource), 'HMR source restored byte for byte');
		}
		if (originalRoute) {
			await writeFile(routeFile, originalRoute);
			assert.equal(hash(await readFile(routeFile)), hash(originalRoute), 'Route source restored byte for byte');
		}
		if (ownsAddedFile) {
			await unlink(addedFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
		}
		report.output = output;
		await mkdir(path.dirname(reportPath), { recursive: true });
		await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
		console.log('Report: ' + reportPath);
	}
}
