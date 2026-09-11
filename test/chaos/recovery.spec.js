import { test, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateOwnedProcess } from './process-lifecycle.js';

// Fault-clear acceptance pass. The happy-path suite proves ordinary relay;
// these tests prove that loss does not masquerade as resilience: traffic flows
// during a real Redis/instance outage, then an authoritative refreshed snapshot
// and a post-recovery event must leave both replicas with the exact same state.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, '../fixture');
const ctxFile = path.join(__dirname, '.chaos-ctx.json');
const _ctx = JSON.parse(readFileSync(ctxFile, 'utf-8'));

function urlA() { return 'http://127.0.0.1:' + _ctx.portA; }
function urlB() { return 'http://127.0.0.1:' + _ctx.portB; }

function compose(...args) {
	return execFileSync('docker', ['compose', ...args], {
		cwd: __dirname,
		stdio: 'pipe',
		encoding: 'utf-8',
		env: { ...process.env, CHAOS_REDIS_PORT: String(_ctx.redisPort) }
	});
}

function mappedRedisPort() {
	const line = compose('port', 'redis', '6379').trim();
	const match = line.match(/:(\d+)$/);
	return match ? Number(match[1]) : null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pickPort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = /** @type {any} */ (server.address()).port;
			server.close(() => resolve(port));
		});
	});
}

async function waitRedisReady() {
	const deadline = Date.now() + 30_000;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			const pong = compose('exec', '-T', 'redis', 'redis-cli', 'ping').trim();
			if (pong === 'PONG') return;
		} catch (error) {
			lastError = error;
		}
		await delay(250);
	}
	throw new Error('Redis did not recover within 30s' + (lastError ? ': ' + lastError.message : ''));
}

async function waitHttp(baseURL, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(baseURL + '/channels', {
				signal: AbortSignal.timeout(2_000)
			});
			if (response.ok) return;
		} catch (error) {
			lastError = error;
		}
		await delay(250);
	}
	throw new Error('replacement instance did not start' + (lastError ? ': ' + lastError.message : ''));
}

async function waitHttpDown(baseURL) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			await fetch(baseURL + '/channels', { signal: AbortSignal.timeout(500) });
		} catch {
			return;
		}
		await delay(100);
	}
	throw new Error('instance B HTTP endpoint did not stop within 10s');
}

async function openOn(browser, baseURL, identity) {
	const url = new URL(baseURL);
	const context = await browser.newContext({ baseURL });
	await context.addCookies([{ name: 'user', value: identity, domain: url.hostname, path: '/' }]);
	const page = await context.newPage();
	for (let attempt = 0; attempt < 2; attempt++) {
		await page.goto('/channels');
		try {
			await page.waitForFunction(() => window.__test, null, { timeout: 10_000 });
			break;
		} catch (error) {
			if (attempt === 1) throw error;
		}
	}
	await page.evaluate(() => window.__test.ready());
	return { context, page };
}

async function waitForRelay(pageA, pageB, prefix) {
	for (let attempt = 0; attempt < 120; attempt++) {
		const text = prefix + '-' + attempt;
		await pageA.evaluate((value) => window.__test.sendLobby(value), text);
		await delay(250);
		const seen = await pageB.evaluate((value) =>
			window.__test.readLobby().some((entry) => entry.text === value), text);
		if (seen) return;
	}
	throw new Error('cross-instance relay did not recover within 30s');
}

async function expectLobbyLength(page, length) {
	await expect.poll(
		() => page.evaluate(() => window.__test.readLobby().length),
		{ timeout: 10_000 }
	).toBe(length);
}

async function assertAuthoritativeRecovery(pageA, pageB, text) {
	await pageA.evaluate(() => window.__test.reset());
	await pageB.evaluate(() => window.__test.waitLobby([]));

	const recovered = await pageA.evaluate((value) => window.__test.sendLobby(value), text);
	const expected = [recovered];
	await Promise.all([
		pageA.evaluate((value) => window.__test.waitLobby(value), expected),
		pageB.evaluate((value) => window.__test.waitLobby(value), expected)
	]);
	expect(await pageA.evaluate(() => window.__test.readLobby())).toEqual(expected);
	expect(await pageB.evaluate(() => window.__test.readLobby())).toEqual(expected);
}

async function stopInstanceB() {
	const owned = _ctx.ownedProcesses?.find((record) => record.label === 'B');
	if (!owned) throw new Error('instance B has no persisted cleanup ownership record');
	await terminateOwnedProcess(owned);
	await waitHttpDown(urlB());
}

async function startInstanceB() {
	const cleanupPort = /** @type {number} */ (await pickPort());
	const cleanupToken = randomUUID();
	const replacement = spawn(process.execPath, [
		path.join(__dirname, 'instance-server.js'),
		String(_ctx.portB),
		_ctx.redisUrl,
		'B-restarted',
		String(cleanupPort),
		cleanupToken
	], {
		cwd: fixtureDir,
		// instance-server keeps its lifecycle tied to stdin. A null stdin emits
		// EOF immediately, so retain a pipe exactly as global-setup does.
		stdio: ['pipe', 'inherit', 'inherit'],
		env: { ...process.env }
	});
	replacement.unref();
	replacement.stdin?.unref?.();

	const persisted = JSON.parse(readFileSync(ctxFile, 'utf-8'));
	persisted.ownedProcesses = [
		...(persisted.ownedProcesses || []),
		{ pid: replacement.pid, cleanupPort, cleanupToken, label: 'B-restarted' }
	];
	writeFileSync(ctxFile, JSON.stringify(persisted));
	const exited = new Promise((_, reject) => {
		replacement.once('error', reject);
		replacement.once('exit', (code, signal) => reject(new Error(
			'replacement instance exited before readiness (code=' + code + ', signal=' + signal + ')'
		)));
	});
	await Promise.race([waitHttp(urlB(), 30_000), exited]);
}

test('Redis stop/start under load recovers to an authoritative complete state', async ({ browser }) => {
	const a = await openOn(browser, urlA(), 'alice');
	const b = await openOn(browser, urlB(), 'bob');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitLobby([]));

		compose('stop', 'redis');
		await Promise.all(Array.from({ length: 12 }, (_, index) =>
			a.page.evaluate((value) => window.__test.sendLobby(value), 'during-redis-stop-' + index)
		));
		await expectLobbyLength(a.page, 12);
		await delay(300);
		expect(await b.page.evaluate(() => window.__test.readLobby())).toEqual([]);

		compose('start', 'redis');
		await waitRedisReady();
		expect(mappedRedisPort()).toBe(_ctx.redisPort);
		await waitForRelay(a.page, b.page, 'redis-recovery-probe');
		await assertAuthoritativeRecovery(a.page, b.page, 'after-redis-recovery');
	} finally {
		try { compose('start', 'redis'); await waitRedisReady(); } catch {}
		await a.context.close();
		await b.context.close();
	}
});

test('instance kill/restart under load recovers to an authoritative complete state', async ({ browser }) => {
	const a = await openOn(browser, urlA(), 'alice');
	const b = await openOn(browser, urlB(), 'bob');
	let replacementOpened = null;
	let instanceBStopped = false;
	let originalBClosed = false;
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitLobby([]));

		await stopInstanceB();
		instanceBStopped = true;
		await Promise.all(Array.from({ length: 12 }, (_, index) =>
			a.page.evaluate((value) => window.__test.sendLobby(value), 'during-instance-stop-' + index)
		));
		await expectLobbyLength(a.page, 12);
		expect(await b.page.evaluate(() => window.__test.readLobby())).toEqual([]);

		await b.context.close();
		originalBClosed = true;
		await startInstanceB();
		instanceBStopped = false;
		replacementOpened = await openOn(browser, urlB(), 'bob-restarted');
		expect(await replacementOpened.page.evaluate(() => window.__test.readLobby())).toEqual([]);
		await waitForRelay(a.page, replacementOpened.page, 'instance-recovery-probe');
		await assertAuthoritativeRecovery(
			a.page,
			replacementOpened.page,
			'after-instance-recovery'
		);
	} finally {
		if (instanceBStopped) {
			try { await startInstanceB(); } catch {}
		}
		await a.context.close();
		if (replacementOpened) await replacementOpened.context.close();
		else if (!originalBClosed) await b.context.close().catch(() => {});
	}
});
