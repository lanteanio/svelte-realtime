import { afterEach, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testRoot = fileURLToPath(new URL('./', import.meta.url));
let temporary;
afterEach(() => {
	if (!temporary) return;
	if (dirname(resolve(temporary)) !== resolve(testRoot) || !basename(temporary).startsWith('.e2e-discovery-')) throw Error('Unexpected e2e fixture path');
	rmSync(temporary, { recursive: true, force: true });
	temporary = null;
});

it('discovers a newly added browser spec in both dev and production projects', () => {
	temporary = mkdtempSync(join(testRoot, '.e2e-discovery-'));
	const fixture = join(temporary, 'e2e');
	mkdirSync(fixture);
	for (const file of ['playwright.config.js', 'ports.js']) cpSync(join(testRoot, 'e2e', file), join(fixture, file));
	for (const hook of ['global-setup.js', 'global-teardown.js']) writeFileSync(join(fixture, hook), 'export default async function () {}\n');
	writeFileSync(join(fixture, 'new-feature.spec.js'), "import { test } from '@playwright/test';\ntest('new browser behavior', () => {});\n");
	const cli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));
	const result = spawnSync(process.execPath, [cli, 'test', '--list', '--config', join(fixture, 'playwright.config.js')], {
		cwd: temporary, encoding: 'utf8', timeout: 30000, windowsHide: true
	});
	expect(result.error).toBeUndefined();
	expect(result.status, result.stdout + result.stderr).toBe(0);
	expect(result.stdout).toContain('[new-feature-dev]');
	expect(result.stdout).toContain('[new-feature-prod]');
	expect(result.stdout).toContain('Total: 2 tests in 1 file');
}, 40000);
