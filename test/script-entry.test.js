import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = fileURLToPath(new URL('../', import.meta.url));
let temporary;
afterEach(() => {
	if (!temporary) return;
	const parent = resolve(tmpdir());
	if (dirname(resolve(temporary)) !== parent || !basename(temporary).startsWith('realtime-script-entry-')) throw Error('Unexpected fixture cleanup path');
	rmSync(temporary, { recursive: true, force: true });
	temporary = null;
});

function fixture() {
	temporary = mkdtempSync(join(tmpdir(), 'realtime-script-entry-'));
	const actual = join(temporary, 'actual'), linked = join(temporary, 'linked');
	for (const dir of ['scripts', 'src', 'docs']) mkdirSync(join(actual, dir), { recursive: true });
	writeFileSync(join(actual, 'package.json'), '{"type":"module"}\n');
	writeFileSync(join(actual, 'src/error-registry.js'), 'export const REALTIME_ERROR_REGISTRY = [];\n');
	writeFileSync(join(actual, 'docs/errors.md'), 'deliberately stale\n');
	cpSync(join(repository, 'scripts/generate-error-reference.js'), join(actual, 'scripts/generate-error-reference.js'));
	const helper = join(repository, 'scripts/script-entry.js');
	if (existsSync(helper)) cpSync(helper, join(actual, 'scripts/script-entry.js'));
	symlinkSync(actual, linked, 'junction');
	return { actual, linked };
}

describe('script entry guards', () => {
	it.each([[], ['--preserve-symlinks-main']])('executes a failing gate through a directory link (%j)', (...flags) => {
		const { linked } = fixture();
		const result = spawnSync(process.execPath, [...flags, join(linked, 'scripts/generate-error-reference.js'), '--check'], { encoding: 'utf8', windowsHide: true });
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('docs/errors.md is stale');
	});

	it('keeps an imported gate inert even when the importing entrypoint is linked', () => {
		const { actual, linked } = fixture();
		writeFileSync(join(actual, 'importer.js'), "import './scripts/generate-error-reference.js';\nconsole.log('import-only');\n");
		const result = spawnSync(process.execPath, [join(linked, 'importer.js')], { encoding: 'utf8', windowsHide: true });
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe('import-only');
	});

	it.runIf(process.platform === 'win32')('executes through a drive and filename case alias', () => {
		const { actual } = fixture();
		const path = join(actual.toUpperCase(), 'scripts/generate-error-reference.js');
		const result = spawnSync(process.execPath, [path, '--check'], { encoding: 'utf8', windowsHide: true });
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('docs/errors.md is stale');
	});
});
