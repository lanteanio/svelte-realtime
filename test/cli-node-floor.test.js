import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync, PROCESS_TEST_TIMEOUT, removeFixture } from './process-fixtures.js';
import { mkdtempSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fixtures = [];
const testRoot = resolve(import.meta.dirname);
const cli = pathToFileURL(join(testRoot, '../src/cli.js')).href;

afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		removeFixture(fixture, '.cli-node-floor-', testRoot);
	}
});

function runCli(version, args) {
	const fixture = mkdtempSync(join(testRoot, '.cli-node-floor-'));
	fixtures.push(fixture);
	const source = `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });
// A failing prerequisite must never reach sv, git or a package manager.
childProcess.execFileSync = () => { throw new Error('EXTERNAL_COMMAND_REACHED'); };
syncBuiltinESMExports();
process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(args)}];
await import(${JSON.stringify(cli)});`;
	const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
		cwd: fixture, encoding: 'utf8'
	});
	expect(result.error).toBeUndefined();
	expect(readdirSync(fixture)).toEqual([]);
	return { ...result, output: result.stdout + result.stderr };
}

describe('scaffold Node prerequisite', () => {
	it.each(['20.19.0', '22.0.0', '22.11.0'])('rejects Node %s before prompts or external commands', version => {
		const result = runCli(version, ['example-app', '--template', 'example']);
		expect(result.status).toBe(1);
		expect(result.output).toContain('Node 22.12 or newer');
		expect(result.output).toContain(version);
		expect(result.output).not.toContain('EXTERNAL_COMMAND_REACHED');
		expect(result.output).not.toContain('Creating SvelteKit project');
	}, PROCESS_TEST_TIMEOUT);

	it.each(['22.12.0', '24.13.1'])('accepts Node %s at the prerequisite boundary', version => {
		const result = runCli(version, ['--help']);
		expect(result.status).toBe(0);
		expect(result.output).toContain('Usage: npx svelte-realtime');
	}, PROCESS_TEST_TIMEOUT);
});
