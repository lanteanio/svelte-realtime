import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { inventoryMarkdown } from '../scripts/check-doc-code.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let temp;
let consumer;
let installed;
beforeAll(() => {
	temp = mkdtempSync(join(tmpdir(), 'realtime-readme-'));
	const npm = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
	const packed = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--json', '--pack-destination', temp], { cwd: root, encoding: 'utf8', timeout: 120000 }));
	consumer = join(temp, 'consumer');
	installed = join(consumer, 'node_modules/svelte-realtime');
	mkdirSync(installed, { recursive: true });
	execFileSync('tar', ['-xzf', join(temp, packed[0].filename), '-C', installed, '--strip-components=1'], { timeout: 120000 });
	writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
	// Reuse installed dependencies; the package under test is always the tarball.
	for (const entry of readdirSync(join(root, 'node_modules'))) {
		if (entry.startsWith('.') || entry === 'svelte-realtime') continue;
		symlinkSync(join(root, 'node_modules', entry), join(consumer, 'node_modules', entry), 'junction');
	}
}, 180000);
afterAll(() => { if (temp) rmSync(temp, { recursive: true, force: true }); });

it('executes every runnable README fence through packed public exports', () => {
	const manifest = JSON.parse(readFileSync(join(installed, 'docs/code-blocks.v1.json'), 'utf8'));
	const fences = new Map(inventoryMarkdown(readFileSync(join(installed, 'README.md'), 'utf8')).map((block) => [`${block.fingerprint}:${block.occurrence}`, block]));
	const executable = manifest.blocks.filter((block) => block.classification === 'executed');
	expect(executable.length).toBeGreaterThan(0);
	const failures = [];
	for (const record of executable) {
		const block = fences.get(`${record.fingerprint}:${record.occurrence}`);
		expect(block, 'packed README fence matches manifest').toBeDefined();
		const file = join(consumer, `example-${block.line}.mjs`);
		const source = block.language === 'ts' ? ts.transpileModule(block.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText : block.content;
		writeFileSync(file, source);
		try { execFileSync(process.execPath, [file], { cwd: consumer, encoding: 'utf8', timeout: 10000, stdio: 'pipe' }); }
		catch (error) { failures.push(`README.md:${block.line} ${block.section}: ${(error.stderr || error.message).toString().slice(0, 1200)}`); }
	}
	expect(failures, failures.join('\n\n')).toEqual([]);
}, 180000);
