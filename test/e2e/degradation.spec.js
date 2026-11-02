import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.beforeEach(async ({ page }) => {
	await page.goto('/degradation');
	await page.waitForFunction(() => window.degradationHarness);
});

test('announces transitions once in the persistent status region', async ({ page }) => {
	const status = page.getByRole('status');
	await expect(status).toBeEmpty();
	await expect(page.locator('#retry-deadline')).toHaveCount(0);
	await page.evaluate(() => window.degradationHarness.degraded());
	await expect(status).toHaveText('Updates paused for Redis.');
	await expect(page.locator('#degradation-reason')).toHaveText('Updates paused for Redis.');
	expect(await page.evaluate(() => window.degradationHarness.announcements())).toEqual(['Updates paused for Redis.']);
	await page.evaluate(() => window.degradationHarness.degraded());
	await page.evaluate(() => window.degradationHarness.recovered());
	await expect(status).toHaveText('Updates restored.');
	await page.evaluate(() => window.degradationHarness.recovered());
	expect(await page.evaluate(() => window.degradationHarness.announcements())).toEqual([
		'Updates paused for Redis.',
		'Updates restored.'
	]);
});

test('gates actions, keeps a stable retry deadline, and recovers without moving focus', async ({ page }) => {
	const action = page.locator('#update-action');
	await expect(action).toBeEnabled();
	await page.locator('#focus-target').focus();
	await page.evaluate(() => window.degradationHarness.degraded({ bannerCopy: 'Service unavailable.', retryAfterMs: 60000 }));
	expect(await action.evaluate(button => button.disabled)).toBe(false);
	await expect(action).toHaveAttribute('aria-disabled', 'true');
	await expect(action).toHaveAttribute('aria-describedby', 'degradation-reason');
	const deadline = await page.locator('#retry-deadline time').getAttribute('datetime');
	await page.waitForTimeout(100);
	await expect(page.locator('#retry-deadline time')).toHaveAttribute('datetime', deadline);
	// A repeated notice during the same outage keeps the original deadline.
	await page.evaluate(() => window.degradationHarness.degraded({ bannerCopy: 'Service unavailable.', retryAfterMs: 60000 }));
	await expect(page.locator('#retry-deadline time')).toHaveAttribute('datetime', deadline);
	await expect(page.getByRole('status')).not.toContainText('Retry at');
	await page.evaluate(() => window.degradationHarness.recovered());
	await expect(action).toBeEnabled();
	await expect(action).toHaveAttribute('aria-disabled', 'false');
	await expect(action).not.toHaveAttribute('aria-describedby');
	await expect(page.locator('#retry-deadline')).toHaveCount(0);
	await expect(page.locator('#focus-target')).toBeFocused();
});

test('keeps a focused unavailable action focusable and refuses every submission', async ({ page }) => {
	const action = page.locator('#update-action');
	await action.focus();
	await page.evaluate(() => window.degradationHarness.degraded());
	await expect(action).toBeFocused();
	expect(await action.evaluate(button => button.disabled)).toBe(false);
	await expect(action).toHaveAttribute('aria-disabled', 'true');
	await action.click({ force: true });
	await page.keyboard.press('Enter');
	await page.keyboard.press('Space');
	await page.locator('#update-form').evaluate(form => form.requestSubmit());
	expect(await page.evaluate(() => window.degradationHarness.submissions())).toBe(0);
	await expect(action).toBeFocused();
	await page.evaluate(() => window.degradationHarness.recovered());
	await expect(action).toBeFocused();
	await expect(action).toHaveAttribute('aria-disabled', 'false');
	await page.keyboard.press('Enter');
	expect(await page.evaluate(() => window.degradationHarness.submissions())).toBe(1);
});

test('switches application catalogs and falls back safely for unknown keys', async ({ page }) => {
	const status = page.getByRole('status');
	await page.evaluate(() => window.degradationHarness.degraded());
	await expect(status).toHaveText('Updates paused for Redis.');
	await page.locator('#notice-locale').selectOption('de');
	await expect(status).toHaveText('Updates paused for Redis.');
	await expect(page.locator('#degradation-reason')).toHaveText('Updates pausiert für Redis.');
	await expect(page.locator('html')).toHaveAttribute('lang', 'de');
	for (const messageKey of ['unknown.key', '__proto__', 'constructor', 'toString']) {
		await page.evaluate((key) => window.degradationHarness.degraded({ messageKey: key, bannerCopy: 'Source English fallback.' }), messageKey);
		await expect(page.locator('#degradation-reason')).toHaveText('Source English fallback.');
	}
	await page.evaluate(() => window.degradationHarness.degraded({ messageKey: 'unknown.key' }));
	await expect(page.locator('#degradation-reason')).toHaveText('Echtzeit-Updates sind vorübergehend nicht verfügbar.');
	expect(await page.evaluate(() => window.degradationHarness.announcements())).toEqual(['Updates paused for Redis.']);
	await page.evaluate(() => window.degradationHarness.recovered());
	await expect(status).toHaveText('Updates wiederhergestellt.');
	expect(await page.evaluate(() => window.degradationHarness.announcements())).toEqual([
		'Updates paused for Redis.',
		'Updates wiederhergestellt.'
	]);
});

test('has no detectable accessibility violations while degraded or recovered', async ({ page }) => {
	await page.evaluate(() => window.degradationHarness.degraded());
	const degraded = await new AxeBuilder({ page }).analyze();
	expect(degraded.violations).toEqual([]);
	await page.evaluate(() => window.degradationHarness.recovered());
	const recovered = await new AxeBuilder({ page }).analyze();
	expect(recovered.violations).toEqual([]);
});

for (const [locale, paused, restored, known] of [
	['en', 'Updates paused for Redis.', 'Real-time updates are available again.', 'Updates restored.'],
	['de', 'Updates pausiert für Redis.', 'Echtzeit-Updates sind wieder verfügbar.', 'Updates wiederhergestellt.']
]) {
	test(`recovers with accessible fallbacks and stable focus in ${locale}`, async ({ page }) => {
		await page.locator('#notice-locale').selectOption(locale);
		const action = page.locator('#update-action');
		const status = page.getByRole('status');
		const announced = [];
		const recoveries = [
			[null, restored],
			[{ messageKey: 'unknown.recovery' }, restored],
			[{ messageKey: '__proto__' }, restored],
			[{ messageKey: 'constructor' }, restored],
			[{ messageKey: 'toString' }, restored],
			[{ messageKey: 'unknown.recovery', bannerCopy: 'Source English recovery fallback.' }, 'Source English recovery fallback.'],
			[{ messageKey: 'realtime.restored', bannerCopy: 'Unused source fallback.' }, known]
		];
		for (const [index, [notice, text]] of recoveries.entries()) {
			await action.focus();
			await page.evaluate(() => window.degradationHarness.degraded());
			await expect(status).toHaveText(paused);
			await expect(action).toHaveAttribute('aria-disabled', 'true');
			await expect(action).toBeFocused();
			await page.evaluate(value => window.degradationHarness.recovered(value), notice);
			await expect(status).toHaveText(text);
			await expect(action).toHaveAttribute('aria-disabled', 'false');
			await expect(action).not.toHaveAttribute('aria-describedby');
			await expect(action).toBeFocused();
			await expect(page.locator('#retry-deadline')).toHaveCount(0);
			announced.push(paused, text);
			await page.evaluate(() => window.degradationHarness.recovered({ messageKey: 'unknown.recovery', bannerCopy: 'Repeated recovery must stay silent.' }));
			expect(await page.evaluate(() => window.degradationHarness.announcements())).toEqual(announced);
			await page.keyboard.press('Enter');
			expect(await page.evaluate(() => window.degradationHarness.submissions())).toBe(index + 1);
			await expect(action).toBeFocused();
		}
	});
}
