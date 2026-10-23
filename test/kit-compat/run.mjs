import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, readdir, writeFile, mkdir, rename, unlink, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect as baseExpect } from '@playwright/test';
import { waitForFixture } from './server-ready.mjs';
import { matchKnown, RELOAD, SPLIT } from './known-failures.mjs';

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
const viteMajor = option('--vite', 'locked');
assert.ok(['locked', '5'].includes(viteMajor), '--vite must be 5');
assert.ok(viteMajor === 'locked' || kit === '2', '--vite 5 requires Kit 2');
// Checks the matrix expects to fail on the installed adapter, passed as JSON
// in --known-adapter-failures: [{ checks, signature, restart }]. A failure is
// known only when its check is listed (or checks is null for any check) and
// its error matches the signature. "restart" starts a fresh server after the
// failure, because the adapter left this one in a state later checks cannot
// use. Every check still runs.
const knownFailures = JSON.parse(option('--known-adapter-failures', '[]'));
for (const entry of knownFailures) {
	assert.ok(entry.checks === null || (Array.isArray(entry.checks) && entry.checks.length), 'A known adapter failure names its checks or null');
	assert.ok(typeof entry.signature === 'string' && entry.signature, 'A known adapter failure needs an error signature');
}
const driveCase = option('--drive-case', 'as-invoked');
assert.ok(['as-invoked', 'lower'].includes(driveCase), '--drive-case must be lower');
assert.ok(driveCase === 'as-invoked' || (process.platform === 'win32' && kit === '3'), '--drive-case requires Windows and Kit 3');
const fixture = path.join(root, 'test', 'fixtures', 'kit' + kit + (viteMajor === '5' ? '-vite5' : ''));
// Vite 8 realpaths its root, which on Windows upper-cases the drive letter,
// while SvelteKit keeps the working directory as spelled.
const workdir = driveCase === 'lower' ? fixture.replace(/^[A-Za-z]:/, drive => drive.toLowerCase()) : fixture;
const requireFixture = createRequire(path.join(fixture, 'package.json'));
const { WebSocket } = requireFixture('ws');
// npm scripts start Vite under the same spelling as the working directory.
const vite = path.join(workdir, 'node_modules', 'vite', 'bin', 'vite.js');
const reportPath = path.resolve(option('--report', path.join(root, 'test-results',
	'kit-compat-' + kit + (viteMajor === '5' ? '-vite5' : '') + '-' + mode + (devtools ? '' : '-no-devtools') + '.json')));
// The fixtures install this checkout as a packed copy (npm ci --install-links),
// so a run must refuse an installed copy whose source differs from the checkout.
async function sourceHash(directory) {
	const digest = createHash('sha256');
	const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
		.filter(entry => entry.isFile())
		.map(entry => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
		.sort();
	for (const file of files) digest.update(file + '\0').update(await readFile(path.join(directory, file))).update('\0');
	return digest.digest('hex');
}
const sourceDigest = await sourceHash(path.join(root, 'src'));
assert.equal(await sourceHash(path.join(fixture, 'node_modules', 'svelte-realtime', 'src')), sourceDigest,
	'The fixture has a stale svelte-realtime copy. Run npm ci --install-links in ' + fixture);
const report = {
	kit, vite: requireFixture('vite/package.json').version, mode, devtools, hmr, adapterMode, driveCase,
	startedAt: new Date().toISOString(),
	sourceHash: sourceDigest,
	checks: []
};
const readinessToken = randomUUID();
const env = { ...process.env, KIT_COMPAT_SECRET: 'fixture-secret', KIT_COMPAT_SESSION: readinessToken, KIT_COMPAT_DEVTOOLS: String(devtools), KIT_COMPAT_ADAPTER: adapterMode, KIT_COMPAT_REPORT_ROOT: String(driveCase !== 'as-invoked') };
// The server masks a call to an unregistered path as FORBIDDEN by default.
const UNREGISTERED = 'FORBIDDEN';
// A shared-state failure carries SPLIT only when HTTP and WebSocket really
// run different instances of the fixture's state module; any other mismatch
// (a store that never renders, a stale value) is an ordinary failure.
async function sharedStateFailure(message, cause) {
	let split = false;
	let detail;
	try {
		const response = await fetch(origin + '/state', { signal: AbortSignal.timeout(5000) });
		const http = (await response.json()).instance;
		if (socket?.readyState !== WebSocket.OPEN) await connectSocket(origin);
		const ws = (await rpc('instance')).data;
		split = typeof http === 'string' && typeof ws === 'string' && http !== ws;
		detail = 'HTTP instance ' + http + ', WebSocket instance ' + ws;
	} catch (error) { detail = 'instance check failed: ' + error.message; }
	return new Error((split ? SPLIT + ': ' : '') + message + ' (' + detail + ')', { cause });
}
async function sameState(actual, expected, what) {
	try { assert.deepEqual(actual, expected); }
	catch (error) { throw await sharedStateFailure(what + ': got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected), error); }
}
// A page store must show the count HTTP reads.
async function showsHttpCount(page, count) {
	try { await expect(page.getByTestId('counter')).toHaveText(String(count)); }
	catch (error) { throw await sharedStateFailure('a page store differs from the HTTP count ' + count + '\n' + error.message, error); }
}
// A dev reload closes sockets with 1012; the client reconnects after its
// jittered backoff (3 s base), so stores need longer than the 5 s default.
const expect = baseExpect.configure({ timeout: 20000 });
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
const hooksFile = path.join(fixture, 'src', 'hooks.ws.js');
let originalHooks;

async function check(name, fn) {
	try {
		await fn();
		report.checks.push({ name, status: 'passed' });
		console.log('PASS ' + name);
	} catch (error) {
		const text = error.stack || String(error);
		const known = matchKnown(knownFailures, name, text);
		report.checks.push({ name, status: known < 0 ? 'failed' : 'known-adapter-failure', known: known < 0 ? undefined : known, error: text });
		if (known < 0) throw error;
		console.log('KNOWN ADAPTER FAILURE ' + name);
		if (knownFailures[known].restart) await restartServer(name);
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

// Close codes of server-initiated closes, so a report shows how a dev reload
// ends existing connections (the client warns only on unexpected codes).
report.serverCloseCodes = [];
async function connectSocket(origin) {
	if (socket) socket.closedByRunner = true;
	socket?.terminate();
	const opened = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Origin: origin } });
	opened.on('close', code => { if (!opened.closedByRunner) report.serverCloseCodes.push(code); });
	socket = opened;
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

let origin;
let launch;
let pages = [];
const navigatedAt = new Map();
async function stopChild() {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, 'exit');
	child.kill();
	const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
	try { await exited; } finally { clearTimeout(timer); }
}
// Start a fresh server on the same port after a known adapter failure left the
// running one unusable, and reload the pages onto it.
async function restartServer(after) {
	report.restarts ??= [];
	report.restarts.push(after);
	console.log('RESTART after ' + after);
	if (socket) socket.closedByRunner = true;
	socket?.terminate();
	await stopChild();
	child = start(...launch);
	await waitForFixture({ child, origin, token: readinessToken });
	await connectSocket(origin);
	// The Vite client reloads its page itself once the server is back, which
	// can abort a navigation started here. Navigate until one completes, then
	// wait until neither page has navigated for a moment.
	for (const page of pages) {
		for (let attempt = 0; ; attempt++) {
			try { await page.goto(origin); break; } catch (error) { if (attempt === 4) throw error; await pause(500); }
		}
	}
	const deadline = Date.now() + 15000;
	for (const page of pages) {
		while (Date.now() - (navigatedAt.get(page) ?? 0) < 1500) {
			assert.ok(Date.now() < deadline, 'A page kept reloading after the restart');
			await pause(100);
		}
		await page.waitForFunction(() => window.compat);
	}
}

try {
	const port = await availablePort();
	origin = 'http://127.0.0.1:' + port;
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
		launch = [['build/index.js'], { HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin }];
	} else {
		launch = [[vite, '--force', '--host', '127.0.0.1', '--port', String(port), '--strictPort']];
	}
	child = start(...launch);
	await check('server startup', () => waitForFixture({ child, origin, token: readinessToken }));
	if (driveCase !== 'as-invoked') {
		await check('Vite and SvelteKit spell the root differently', () => {
			const reported = output.match(/\[kit-compat\] vite root (.+)/)?.[1]?.trim();
			assert.ok(reported, 'Vite did not report its root');
			const kitRoot = workdir.split(path.sep).join('/');
			assert.equal(reported.toLowerCase(), kitRoot.toLowerCase(), 'Vite resolved another directory');
			assert.notEqual(reported, kitRoot, 'Vite kept the working directory spelling, so this run proves nothing');
		});
	}
	await check('cold WebSocket RPC before any page load', async () => {
		await connectSocket(origin);
		const response = await rpc('echo', ['cold-start']);
		assert.equal(response.ok, true, JSON.stringify(response));
		assert.deepEqual(response.data, { value: 'cold-start', token: 'fixture-secret', label: 'initial' });
	});

	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext();
	const pageErrors = [];
	const frames = { sent: [], received: [] };
	pages = [await context.newPage(), await context.newPage()];
	for (const page of pages) {
		page.setDefaultTimeout(15000);
		page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigatedAt.set(page, Date.now()); });
		page.on('pageerror', error => { pageErrors.push(error.message); output += '\nBrowser error: ' + error.stack; });
		page.on('console', message => { output += '\nBrowser console ' + message.type() + ': ' + message.text(); });
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
		await sameState((await response.json()).count, 2, 'HTTP reads another count');
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
	const counterReloads = () => output.match(/Hot-reloaded: src\/live\/counter\b/g)?.length ?? 0;
	let reloadsBeforeEdit = 0;
	if (hmr) {
		await check('HMR replaces and removes handlers', async () => {
			reloadsBeforeEdit = counterReloads();
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
			assert.equal(added?.ok, true, RELOAD + ': ' + (JSON.stringify(added) || reconnectError?.message));
			assert.equal(added.data, 'replacement', RELOAD + ': ' + JSON.stringify(added));
			const removed = await rpc('removed');
			assert.equal(removed.ok, false, RELOAD + ': ' + JSON.stringify(removed));
			assert.equal(removed.code, UNREGISTERED, RELOAD + ': ' + JSON.stringify(removed));
			const relabeled = await rpc('echo', ['changed']);
			assert.equal(relabeled.data?.label, 'updated', RELOAD + ': ' + JSON.stringify(relabeled));
		});
		await check('live stores after HMR', async () => {
			// A full SSR graph reload may recreate module-scoped state. All
			// reconnected stores must agree with the actual server baseline.
			const response = await fetch(origin + '/state', { signal: AbortSignal.timeout(5000) });
			assert.equal(response.status, 200);
			const baseline = (await response.json()).count;
			assert.equal(typeof baseline, 'number');
			for (const page of pages) {
				await showsHttpCount(page, baseline);
				await page.waitForFunction(() => window.compat);
			}
			const count = await pages[0].evaluate(() => window.compat.increment(3));
			await sameState(count, baseline + 3, 'the RPC count differs from the HTTP count');
			for (const page of pages) await expect(page.getByTestId('counter')).toHaveText(String(count));
			const after = await fetch(origin + '/state', { signal: AbortSignal.timeout(5000) });
			assert.equal(after.status, 200);
			await sameState((await after.json()).count, count, 'HTTP reads another count');
		});
		await check('one registry reload per live-file save', () => {
			// Vite can report one save once per spelling of the file's path.
			assert.equal(counterReloads() - reloadsBeforeEdit, 1, 'The single edit reloaded the registry more than once or not at all');
		});
	}
	if (hmr) {
		await check('route-only HMR shares HTTP and WebSocket state', async () => {
			originalRoute = await readFile(routeFile);
			const route = originalRoute.toString('utf8');
			const anchor = 'Response.json({ count: state.count, instance: state.instance })';
			assert.equal(route.split(anchor).length, 2, 'Route source anchor must occur once');
			const changed = route.replace(anchor, "Response.json({ count: state.count, instance: state.instance }, { headers: { 'x-route-version': 'updated' } })");
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
			assert.equal(echoed.ok, true, RELOAD + ': ' + JSON.stringify(echoed));
			assert.deepEqual(echoed.data, { value: 'route-reload', token: 'fixture-secret', label: 'updated' }, RELOAD + ': ' + JSON.stringify(echoed));
			const baselineResponse = await fetch(origin + '/state', { signal: AbortSignal.timeout(5000) });
			assert.equal(baselineResponse.status, 200);
			const baseline = (await baselineResponse.json()).count;
			assert.equal(typeof baseline, 'number');
			for (const page of pages) {
				await showsHttpCount(page, baseline);
				await page.waitForFunction(() => window.compat);
			}
			const count = await pages[0].evaluate(() => window.compat.increment(5));
			await sameState(count, baseline + 5, 'the RPC count differs from the HTTP count');
			for (const page of pages) await expect(page.getByTestId('counter')).toHaveText(String(count));
			const after = await fetch(origin + '/state', { signal: AbortSignal.timeout(5000) });
			assert.equal(after.status, 200);
			await sameState((await after.json()).count, count, 'HTTP reads another count');
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
			throw new Error(RELOAD + ': RPC did not reach expected state: ' + name + ' ' + JSON.stringify(result));
		}
		// Vite 5 answers a new or removed live file with a full page reload.
		// Drive a page only once neither the file event nor a navigation is recent.
		async function settledPages(changedAt) {
			const deadline = Date.now() + 15000;
			for (const page of pages) {
				while (Date.now() - Math.max(changedAt, navigatedAt.get(page) ?? 0) < 1500) {
					assert.ok(Date.now() < deadline, 'The page kept reloading');
					await pause(100);
				}
				await page.waitForFunction(() => window.compat);
			}
		}
		async function sharedStores(changedAt) {
			await settledPages(changedAt);
			const response = await fetch(origin + '/state', { signal: AbortSignal.timeout(5000) });
			assert.equal(response.status, 200);
			const baseline = (await response.json()).count;
			assert.equal(typeof baseline, 'number');
			for (const page of pages) await showsHttpCount(page, baseline);
			const count = await pages[0].evaluate(() => window.compat.increment(1));
			await sameState(count, baseline + 1, 'the RPC count differs from the HTTP count');
			for (const page of pages) await expect(page.getByTestId('counter')).toHaveText(String(count));
			const after = await fetch(origin + '/state', { signal: AbortSignal.timeout(5000) });
			assert.equal(after.status, 200);
			await sameState((await after.json()).count, count, 'HTTP reads another count');
			return count;
		}
		await check('new live files share HTTP and WebSocket state', async () => {
			await assert.rejects(readFile(addedFile), { code: 'ENOENT' });
			ownsAddedFile = true;
			const addedAt = Date.now();
			await writeFile(addedFile, "import { live } from 'svelte-realtime/server';\nimport { state } from '../lib/server/state.js';\nexport const read = live(() => state.count);\n");
			await waitForRpc('extra/read', result => result.ok === true);
			const count = await sharedStores(addedAt);
			await sameState((await rpc('extra/read')).data, count, 'the new live file reads another count');
		});
		await check('removed live files unregister without splitting state', async () => {
			const removedAt = Date.now();
			await unlink(addedFile);
			await waitForRpc('extra/read', result => result.ok === false && result.code === UNREGISTERED);
			await sharedStores(removedAt);
		});
		// Upgrade data is fixed per connection, so each attempt opens a new one.
		async function freshRpc(name, accepts, args = []) {
			const deadline = Date.now() + 20000;
			let result;
			let lastError;
			while (Date.now() < deadline) {
				try {
					await connectSocket(origin);
					result = await rpc(name, args);
					if (accepts(result)) return result;
				} catch (error) { lastError = error; }
				await pause(200);
			}
			throw new Error(RELOAD + ': a new connection did not reach the expected state: ' + name + ' ' + (JSON.stringify(result) ?? lastError?.message));
		}
		// The adapter closes connections when it reloads the hooks, which can
		// land after the reload a check waited for, so each call may reconnect.
		async function registryAnswers(label) {
			const echoed = await freshRpc('echo', result => result.ok === true, ['hooks']);
			assert.deepEqual(echoed.data, { value: 'hooks', token: 'fixture-secret', label }, RELOAD + ': ' + JSON.stringify(echoed));
			const removed = await freshRpc('removed', result => result.ok === false);
			assert.equal(removed.code, UNREGISTERED, RELOAD + ': ' + JSON.stringify(removed));
			const added = await freshRpc('added', result => result.ok === true);
			assert.equal(added.data, 'replacement', RELOAD + ': ' + JSON.stringify(added));
		}
		// The label the live module answers with once the checks above have run.
		let liveLabel = 'updated';
		await check('broken live modules recover without splitting state', async () => {
			const working = await readFile(liveFile, 'utf8');
			assert.equal(working.split("label: 'updated'").length, 2, 'Repair anchor must occur once');
			// A broken save keeps the handlers that are loaded; load this one first.
			await freshRpc('echo', result => result.ok === true && result.data.label === 'updated', ['hooks']);
			const broken = output.length;
			const brokenAt = Date.now();
			await writeFile(liveFile, working + '\nexport const broken = live(() => {;\n');
			try {
				const deadline = Date.now() + 15000;
				while (Date.now() < deadline && !/HMR failed for src\/live\/counter/.test(output.slice(broken))) await pause(100);
				assert.match(output.slice(broken), /HMR failed for src\/live\/counter/, 'The broken save did not report a failed reload');
				// The previous handlers keep serving while the module is broken.
				await freshRpc('echo', result => result.ok === true && result.data.label === 'updated', ['hooks']);
				await sharedStores(brokenAt);
			} catch (error) {
				// Later checks start from the working module, not the broken one.
				await writeFile(liveFile, working);
				throw error;
			}
			const repairedAt = Date.now();
			await writeFile(liveFile, working.replace("label: 'updated'", "label: 'repaired'"));
			await freshRpc('echo', result => result.ok === true && result.data.label === 'repaired', ['hooks']);
			await registryAnswers('repaired');
			liveLabel = 'repaired';
			await sharedStores(repairedAt);
		});
		const hooksAnchor = "return { id: 'compatibility-test' };";
		await check('hooks.ws edits keep live handlers and shared state', async () => {
			originalHooks = await readFile(hooksFile);
			const source = originalHooks.toString('utf8');
			assert.equal(source.split(hooksAnchor).length, 2, 'hooks.ws anchor must occur once');
			assert.equal((await freshRpc('connection', result => result.ok === true)).data, 'compatibility-test');
			const editedAt = Date.now();
			await writeFile(hooksFile, source.replace(hooksAnchor, "return { id: 'compatibility-test-edited' };"));
			await freshRpc('connection', result => result.ok === true && result.data === 'compatibility-test-edited');
			await registryAnswers(liveLabel);
			await sharedStores(editedAt);
		});
		await check('deleted and recreated hooks.ws restore live handlers and shared state', async () => {
			const deleted = output.length;
			await unlink(hooksFile);
			// The deletion must reach the server before the file returns.
			const deadline = Date.now() + 15000;
			while (Date.now() < deadline && !/hooks\.ws/.test(output.slice(deleted))) await pause(100);
			assert.match(output.slice(deleted), /hooks\.ws/, 'The server did not observe the hooks.ws deletion');
			await pause(500);
			const recreatedAt = Date.now();
			await writeFile(hooksFile, originalHooks.toString('utf8').replace(hooksAnchor, "return { id: 'compatibility-test-recreated' };"));
			await freshRpc('connection', result => result.ok === true && result.data === 'compatibility-test-recreated');
			await registryAnswers(liveLabel);
			await sharedStores(recreatedAt);
		});
	}
	await check('browser has no runtime errors', () => assert.deepEqual(pageErrors, []));
	await check('no unsupported HTML hook warning', () => {
		assert.doesNotMatch(output, /following plugins[\s\S]{0,500}transformIndexHtml/i);
	});
	if (hmr) await check('HMR closes sockets with a restart code and no Cloudflare Tunnel warning', () => {
		assert.doesNotMatch(output, /Cloudflare-Tunnel|Set-Cookie on 101|svti\.me\/cf-cookies/i);
		// The reloads above close open sockets; the client treats only 1001 and
		// 1012 as an expected restart.
		assert.ok(report.serverCloseCodes.includes(1012), 'No server close with 1012 during HMR: ' + JSON.stringify(report.serverCloseCodes));
		const unexpected = report.serverCloseCodes.filter(code => code !== 1001 && code !== 1012);
		assert.deepEqual(unexpected, [], 'Server closes used codes the client warns about: ' + JSON.stringify(report.serverCloseCodes));
	});
	report.status = report.checks.some(entry => entry.status === 'known-adapter-failure') ? 'known-adapter-failure' : 'passed';
} catch (error) {
	report.status = 'failed';
	report.error = error.stack || String(error);
	console.error(report.error + '\n' + output);
	process.exitCode = 1;
} finally {
	try {
		await browser?.close();
		if (socket) socket.closedByRunner = true;
		socket?.terminate();
		await stopChild();
	} finally {
		if (originalSource) {
			await unlink(liveFile + '.next').catch(error => {
				if (error.code !== 'ENOENT') throw error;
			});
			await writeFile(liveFile, originalSource);
			assert.equal(hash(await readFile(liveFile)), hash(originalSource), 'HMR source restored byte for byte');
		}
		if (originalHooks) {
			await writeFile(hooksFile, originalHooks);
			assert.equal(hash(await readFile(hooksFile)), hash(originalHooks), 'hooks.ws restored byte for byte');
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
