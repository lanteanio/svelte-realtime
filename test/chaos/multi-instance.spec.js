import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tier-4 chaos: two svelte-realtime instances connected to a shared
// Redis pubsub bus. Each browser context picks one of the two host
// ports so `connection A` and `connection B` may land on different
// instances. The bus relays publishes across instances so a
// subscriber on instance A still receives events that originated on
// instance B's RPC handler.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _ctx = JSON.parse(readFileSync(path.join(__dirname, '.chaos-ctx.json'), 'utf-8'));

function urlA() { return 'http://127.0.0.1:' + _ctx.portA; }
function urlB() { return 'http://127.0.0.1:' + _ctx.portB; }

async function openOn(browser, baseURL, identity, route) {
	const u = new URL(baseURL);
	const ctx = await browser.newContext({ baseURL });
	await ctx.addCookies([{ name: 'user', value: identity, domain: u.hostname, path: '/' }]);
	const page = await ctx.newPage();
	await page.goto(route);
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.ready ? window.__test.ready() : null);
	return { ctx, page };
}

test('cross-instance channel publish: A on instance-A publishes; B on instance-B receives', async ({ browser }) => {
	const a = await openOn(browser, urlA(), 'alice', '/channels');
	const b = await openOn(browser, urlB(), 'bob', '/channels');
	try {
		// Reset only on instance A; the reset publishes refreshed:[] to
		// the lobby topic, which fans out via Redis to instance B.
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitLobby([]));

		// A's instance-A handler publishes 'created' on the lobby topic.
		// The bus relays to instance B; B's subscriber sees it.
		await a.page.evaluate(() => window.__test.sendLobby('hello-from-A-instance'));
		// Each instance assigns ids from its own _seq counter, so just
		// match on text + by; ids may collide across instances.
		await b.page.evaluate(() =>
			window.__test.waitLobby([
				{ id: 'msg-1', text: 'hello-from-A-instance', by: 'alice' }
			])
		);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

test('cross-instance reverse: B on instance-B publishes; A on instance-A receives', async ({ browser }) => {
	const a = await openOn(browser, urlA(), 'alice', '/channels');
	const b = await openOn(browser, urlB(), 'bob', '/channels');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitLobby([]));

		await b.page.evaluate(() => window.__test.sendLobby('hello-from-B-instance'));
		await a.page.evaluate(() =>
			window.__test.waitLobby([
				{ id: 'msg-1', text: 'hello-from-B-instance', by: 'bob' }
			])
		);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

test('cross-instance todo crud: B publishes via instance-B; A on instance-A receives the created event', async ({ browser }) => {
	const a = await openOn(browser, urlA(), 'alice', '/qr');
	const b = await openOn(browser, urlB(), 'bob', '/qr');
	try {
		await a.page.evaluate(() => window.__test.reset());
		// Wait until both contexts observe an empty todos list (cross-
		// instance fan-out of refreshed:[]).
		await a.page.evaluate(() => window.__test.waitTodos([]));
		await b.page.evaluate(() => window.__test.waitTodos([]));

		// B publishes externally on instance-B.
		await b.page.evaluate(() => window.__test.publish({ event: 'created', id: 'cx1', name: 'remote-from-B' }));
		await a.page.evaluate(() =>
			window.__test.waitTodos([{ id: 'cx1', name: 'remote-from-B' }])
		);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

test('same-instance baseline: A and B both on instance-A still see each other (no regression)', async ({ browser }) => {
	const a = await openOn(browser, urlA(), 'alice', '/channels');
	const b = await openOn(browser, urlA(), 'bob', '/channels');
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitLobby([]));

		await a.page.evaluate(() => window.__test.sendLobby('same-instance'));
		await b.page.evaluate(() =>
			window.__test.waitLobby([
				{ id: 'msg-1', text: 'same-instance', by: 'alice' }
			])
		);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// Sanity check that the bus-wrap does not break local-only flows that
// publish without ever crossing instances. Confirms the wrap installs
// idempotently across messages.
test('local-only flow still works under bus-wrap (lock + ordered RPCs)', async ({ browser }) => {
	const a = await openOn(browser, urlA(), 'alice', '/lock');
	try {
		const log = await a.page.evaluate(() => window.__test.fireThreeOrdered());
		expect(Array.isArray(log)).toBe(true);
		expect(log.length).toBeGreaterThanOrEqual(3);
	} finally {
		await a.ctx.close();
	}
});
