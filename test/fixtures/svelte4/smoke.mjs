import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const listener = createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
const url = 'http://127.0.0.1:' + port;
let output = '';
const child = spawn(process.execPath, ['build/index.js'], {
	cwd: fileURLToPath(new URL('.', import.meta.url)),
	env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ORIGIN: url },
	stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
});
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
let launchError;
child.on('error', (error) => { launchError = error; });
let browser;
try {
	let html;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (launchError) throw launchError;
		if (child.exitCode !== null) throw new Error('Server exited before startup: ' + output);
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
			if (response.ok) { html = await response.text(); break; }
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(html?.includes('Svelte 4 realtime fixture'), 'SSR did not render: ' + output);
	browser = await chromium.launch({ headless: true });
	const first = await browser.newPage();
	const second = await browser.newPage();
	const errors = [];
	for (const page of [first, second]) page.on('pageerror', (error) => errors.push(error.message));
	await Promise.all([first.goto(url), second.goto(url)]);
	for (const page of [first, second]) await page.locator('#count').filter({ hasText: /^Count: 0$/ }).waitFor();
	await first.getByRole('button', { name: 'Increment', exact: true }).click();
	for (const page of [first, second]) await page.locator('#count').filter({ hasText: /^Count: 1$/ }).waitFor();
	await second.reload();
	await second.locator('#count').filter({ hasText: /^Count: 1$/ }).waitFor();
	await second.getByRole('button', { name: 'Increment', exact: true }).click();
	for (const page of [first, second]) {
		await page.locator('#count').filter({ hasText: /^Count: 2$/ }).waitFor();
		assert.equal(await page.locator('#error').textContent(), '');
	}
	assert.deepEqual(errors, []);
	console.log('Svelte 4 production SSR, browser store updates, RPC and reload passed');
} finally {
	await browser?.close();
	if (child.exitCode === null && !launchError) {
		const exited = once(child, 'exit');
		child.kill('SIGTERM');
		const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
		try { await exited; } finally { clearTimeout(kill); }
	}
}
