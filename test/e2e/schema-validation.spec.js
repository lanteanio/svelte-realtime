import { test, expect } from '@playwright/test';
import { DEV_PORT, PROD_PORT } from './ports.js';

// Schema-validation e2e: proves `live.validated(schema, fn)` rejects
// invalid payloads with `VALIDATION` + structured issues, accepts valid
// ones, and isolates per-call failures across concurrent contexts.

async function openSchema(browser, baseURL) {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto('/schema');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.ready());
	return { ctx, page };
}

function baseURLFromProject(testInfo) {
	const isProd = testInfo.project.name.endsWith('-prod');
	return 'http://localhost:' + (isProd ? PROD_PORT : DEV_PORT);
}

test.beforeEach(async ({ page }) => {
	await page.goto('/schema');
	await page.waitForFunction(() => window.__test);
	await page.evaluate(() => window.__test.ready());
});

// 1 -- valid flat payload succeeds with the server's response -------------

test('valid flat payload succeeds and echoes the received fields', async ({ page }) => {
	const r = await page.evaluate(() => window.__test.submitFlat({ text: 'hi', count: 3 }));
	expect(r.ok).toBe(true);
	expect(r.v.received).toEqual({ text: 'hi', count: 3 });
	expect(typeof r.v.at).toBe('number');
});

// 2 -- missing required field rejects with VALIDATION + path -------------

test('missing required field rejects with VALIDATION code and path issue', async ({ page }) => {
	const r = await page.evaluate(() => window.__test.submitFlat({ text: 'hi' }));
	expect(r.ok).toBe(false);
	expect(r.code).toBe('VALIDATION');
	expect(Array.isArray(r.issues)).toBe(true);
	const paths = r.issues.map((iss) => iss.path.join('.'));
	expect(paths).toContain('count');
});

// 3 -- wrong type rejects with VALIDATION + multiple issues --------------

test('wrong type for both fields rejects with VALIDATION and surfaces every issue', async ({ page }) => {
	const r = await page.evaluate(() =>
		window.__test.submitFlat({ text: 42, count: 'not-a-number' })
	);
	expect(r.ok).toBe(false);
	expect(r.code).toBe('VALIDATION');
	const paths = r.issues.map((iss) => iss.path.join('.'));
	expect(paths).toContain('text');
	expect(paths).toContain('count');
});

// 4 -- out-of-range value rejects with VALIDATION ----------------------

test('out-of-range count rejects with VALIDATION', async ({ page }) => {
	const r = await page.evaluate(() => window.__test.submitFlat({ text: 'hi', count: -1 }));
	expect(r.ok).toBe(false);
	expect(r.code).toBe('VALIDATION');
	expect(r.issues.map((iss) => iss.path.join('.'))).toContain('count');
});

// 5 -- nested schema surfaces a deep path on failure -------------------

test('nested schema rejects with the deep path in issues', async ({ page }) => {
	const r = await page.evaluate(() =>
		window.__test.submitNested({ user: { name: 42 }, items: ['a', 'b'] })
	);
	expect(r.ok).toBe(false);
	expect(r.code).toBe('VALIDATION');
	const paths = r.issues.map((iss) => iss.path.join('.'));
	expect(paths).toContain('user.name');
});

// 6 -- nested array element failure surfaces the element index --------

test('nested array element failure surfaces items.<index> in issues', async ({ page }) => {
	const r = await page.evaluate(() =>
		window.__test.submitNested({ user: { name: 'alice' }, items: ['ok', 42, 'also-ok'] })
	);
	expect(r.ok).toBe(false);
	expect(r.code).toBe('VALIDATION');
	const paths = r.issues.map((iss) => iss.path.join('.'));
	expect(paths).toContain('items.1');
});

// 7 -- valid nested payload succeeds with full echo -------------------

test('valid nested payload succeeds', async ({ page }) => {
	const r = await page.evaluate(() =>
		window.__test.submitNested({ user: { name: 'alice' }, items: ['x', 'y'] })
	);
	expect(r.ok).toBe(true);
	expect(r.v.received).toEqual({ user: { name: 'alice' }, items: ['x', 'y'] });
});

// 8 -- cross-client isolation: A's invalid does not affect B's valid --

test('cross-client: A submits invalid, B submits valid; both outcomes correct', async ({ browser }, testInfo) => {
	const baseURL = baseURLFromProject(testInfo);
	const a = await openSchema(browser, baseURL);
	const b = await openSchema(browser, baseURL);
	try {
		const [aRes, bRes] = await Promise.all([
			a.page.evaluate(() => window.__test.submitFlat({ text: 'hi' })),
			b.page.evaluate(() => window.__test.submitFlat({ text: 'ok', count: 7 }))
		]);
		expect(aRes.ok).toBe(false);
		expect(aRes.code).toBe('VALIDATION');
		expect(bRes.ok).toBe(true);
		expect(bRes.v.received).toEqual({ text: 'ok', count: 7 });
	} finally {
		await a.ctx.close();
		await b.ctx.close();
	}
});

// 9 -- non-object body rejects with VALIDATION at root path ----------

test('null body rejects with VALIDATION at root path', async ({ page }) => {
	const r = await page.evaluate(() => window.__test.submitFlat(null));
	expect(r.ok).toBe(false);
	expect(r.code).toBe('VALIDATION');
});
