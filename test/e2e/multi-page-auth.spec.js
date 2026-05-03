import { test, expect } from '@playwright/test';
import { DEV_PORT, PROD_PORT } from './ports.js';

// Per-user auth e2e: each BrowserContext sets `user` and `role`
// cookies BEFORE the page loads, so the WS upgrade hook reads
// distinct identities. Proves:
//   - ctx.user reaches RPC handlers (whoami)
//   - per-user stream isolation (inbox keyed by ctx.user.id)
//   - cross-user routing (sendToInbox addresses by recipient id)
//   - role-gated guards (adminAction throws FORBIDDEN for non-admin)

async function openAuth(browser, baseURL, identity) {
	// `identity` = { user, role? }. Cookies are scoped to the test
	// server's host so the WS upgrade hook reads them.
	const url = new URL(baseURL);
	const ctx = await browser.newContext();
	const cookies = [{ name: 'user', value: identity.user, domain: url.hostname, path: '/' }];
	if (identity.role) {
		cookies.push({ name: 'role', value: identity.role, domain: url.hostname, path: '/' });
	}
	await ctx.addCookies(cookies);
	const page = await ctx.newPage();
	await page.goto('/auth');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.ready());
	return { ctx, page };
}

function baseURLFromProject(testInfo) {
	// Map project name to its baseURL since each project has a different one.
	const isProd = testInfo.project.name.endsWith('-prod');
	return 'http://localhost:' + (isProd ? PROD_PORT : DEV_PORT);
}

// 1 -- whoami returns each context's distinct user identity ----------------

test('whoami returns each context distinct identity', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openAuth(browser, baseURL, { user: 'alice' });
	const b = await openAuth(browser, baseURL, { user: 'bob' });
	try {
		const aId = await a.page.evaluate(() => window.__test.whoami());
		const bId = await b.page.evaluate(() => window.__test.whoami());
		expect(aId).toEqual({ id: 'alice', role: 'user' });
		expect(bId).toEqual({ id: 'bob', role: 'user' });
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 2 -- Per-user inbox isolation: A's inbox topic is not B's ---------------

test('per-user inbox: A sends to A, B does NOT see', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openAuth(browser, baseURL, { user: 'alice' });
	const b = await openAuth(browser, baseURL, { user: 'bob' });
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitInbox([]));

		// Alice sends to alice (self).
		const msg = await a.page.evaluate(() => window.__test.send({ to: 'alice', text: 'hello self' }));
		expect(msg.from).toBe('alice');

		// Alice sees the message in her inbox.
		await a.page.evaluate(
			(m) => window.__test.waitInbox([{ id: m.id, from: 'alice', text: 'hello self' }]),
			msg
		);

		// Bob does NOT see it -- separate topic.
		await b.page.waitForTimeout(150);
		const bobInbox = await b.page.evaluate(() => window.__test.inbox());
		expect(bobInbox).toEqual([]);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 3 -- Cross-user routing: A sends to B, B sees, A does NOT ---------------

test('cross-user routing: A sends to B, only B sees', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openAuth(browser, baseURL, { user: 'alice' });
	const b = await openAuth(browser, baseURL, { user: 'bob' });
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitInbox([]));

		const msg = await a.page.evaluate(() => window.__test.send({ to: 'bob', text: 'hi bob' }));
		await b.page.evaluate(
			(m) => window.__test.waitInbox([{ id: m.id, from: 'alice', text: 'hi bob' }]),
			msg
		);

		// Alice does NOT see the message (it went to bob's topic).
		await a.page.waitForTimeout(150);
		const aInbox = await a.page.evaluate(() => window.__test.inbox());
		expect(aInbox).toEqual([]);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 4 -- Both directions: A->B and B->A, each sees only their own inbox ------

test('cross-user routing: bidirectional messages, each inbox isolated', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openAuth(browser, baseURL, { user: 'alice' });
	const b = await openAuth(browser, baseURL, { user: 'bob' });
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitInbox([]));

		const m1 = await a.page.evaluate(() => window.__test.send({ to: 'bob', text: 'A->B' }));
		const m2 = await b.page.evaluate(() => window.__test.send({ to: 'alice', text: 'B->A' }));

		await a.page.evaluate(
			(m) => window.__test.waitInbox([{ id: m.id, from: 'bob', text: 'B->A' }]),
			m2
		);
		await b.page.evaluate(
			(m) => window.__test.waitInbox([{ id: m.id, from: 'alice', text: 'A->B' }]),
			m1
		);
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 5 -- Role guard: regular user gets FORBIDDEN, admin user gets through ----

test('admin guard: non-admin gets FORBIDDEN, admin succeeds', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const u = await openAuth(browser, baseURL, { user: 'alice', role: 'user' });
	const adm = await openAuth(browser, baseURL, { user: 'root', role: 'admin' });
	try {
		const userResult = await u.page.evaluate(() => window.__test.callAdmin());
		expect(userResult.ok).toBe(false);
		expect(userResult.code).toBe('FORBIDDEN');

		const adminResult = await adm.page.evaluate(() => window.__test.callAdmin());
		expect(adminResult.ok).toBe(true);
		expect(adminResult.v).toEqual({ ok: true, by: 'root' });
	} finally {
		await u.ctx.close();
		await adm.ctx.close();
	}
});

// 6 -- Three users, mesh: A->B, A->C, B->C; each inbox isolated -----------

test('three-user mesh: each inbox contains only its own messages', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openAuth(browser, baseURL, { user: 'alice' });
	const b = await openAuth(browser, baseURL, { user: 'bob' });
	const c = await openAuth(browser, baseURL, { user: 'carol' });
	try {
		await a.page.evaluate(() => window.__test.reset());
		await b.page.evaluate(() => window.__test.waitInbox([]));
		await c.page.evaluate(() => window.__test.waitInbox([]));

		const mAB = await a.page.evaluate(() => window.__test.send({ to: 'bob', text: 'A->B' }));
		const mAC = await a.page.evaluate(() => window.__test.send({ to: 'carol', text: 'A->C' }));
		const mBC = await b.page.evaluate(() => window.__test.send({ to: 'carol', text: 'B->C' }));

		// Alice's inbox empty (no one sent her anything).
		await a.page.waitForTimeout(150);
		expect(await a.page.evaluate(() => window.__test.inbox())).toEqual([]);

		// Bob has A->B only.
		await b.page.evaluate(
			(m) => window.__test.waitInbox([{ id: m.id, from: 'alice', text: 'A->B' }]),
			mAB
		);

		// Carol has A->C and B->C.
		await c.page.evaluate((args) => window.__test.waitInbox([
			{ id: args.mAC.id, from: 'alice', text: 'A->C' },
			{ id: args.mBC.id, from: 'bob', text: 'B->C' }
		]), { mAC, mBC });
	} finally {
		await a.ctx.close();
		await b.ctx.close();
		await c.ctx.close();
	}
});
