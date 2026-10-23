import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync, PROCESS_TEST_TIMEOUT, removeFixture } from './process-fixtures.js';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isBuiltin } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

const fixtures = [];
const testRoot = resolve(import.meta.dirname);
const cli = pathToFileURL(join(testRoot, '../src/cli.js')).href;

afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		removeFixture(fixture, '.cli-node-floor-', testRoot);
	}
});

function runCli(version, args, env = process.env) {
	const fixture = mkdtempSync(join(testRoot, '.cli-node-floor-'));
	fixtures.push(fixture);
	const source = `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });
// A failing prerequisite must never reach sv, git or a package manager.
childProcess.execFileSync = (file, args, options) => {
	console.log('EXTERNAL_COMMAND_REACHED ' + JSON.stringify({ file, args, env: Object.keys(options?.env ?? {}).filter(key => /^(npm_config_|node_env$)/i.test(key)).sort() }));
	throw new Error('EXTERNAL_COMMAND_REACHED');
};
syncBuiltinESMExports();
process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(args)}];
await import(${JSON.stringify(cli)});`;
	const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
		cwd: fixture, encoding: 'utf8', env
	});
	expect(result.error).toBeUndefined();
	expect(readdirSync(fixture)).toEqual([]);
	return { ...result, output: result.stdout + result.stderr };
}

describe('scaffold Node prerequisite', () => {
	it('keeps dependency resolution behind the Node prerequisite', () => {
		const entry = parse(readFileSync(new URL(cli), 'utf8'), { sourceType: 'module' });
		const dependencies = entry.program.body.filter(node => node.type === 'ImportDeclaration').map(node => node.source.value);
		expect(dependencies.filter(specifier => !isBuiltin(specifier))).toEqual([]);
	});

	it.each(['18.0.0', '20.0.0', '20.11.1', '20.19.0', '22.0.0', '22.11.0', '22.12.0', '22.16.9', '23.11.0'])('rejects Node %s before prompts or external commands', version => {
		const result = runCli(version, ['example-app', '--template', 'example']);
		expect(result.status).toBe(1);
		expect(result.output).toContain('Node 22.17+ on 22.x, or Node 24+');
		expect(result.output).toContain(version);
		expect(result.output).not.toContain('EXTERNAL_COMMAND_REACHED');
		expect(result.output).not.toContain('Creating SvelteKit project');
	}, PROCESS_TEST_TIMEOUT);

	it.each(['22.17.0', '22.18.0', '24.0.0', '24.13.1'])('accepts Node %s at the prerequisite boundary', version => {
		const result = runCli(version, ['--help']);
		expect(result.status).toBe(0);
		expect(result.output).toContain('Usage: npx svelte-realtime');
	}, PROCESS_TEST_TIMEOUT);

	it('keeps npm exec package selection out of the nested sv create', () => {
		// On Windows the CLI looks npx up through PATH; a placeholder npx.cmd keeps
		// the result independent of the machine. execFileSync is stubbed, so it never runs.
		const bin = mkdtempSync(join(tmpdir(), 'realtime-floor-bin-'));
		let result;
		try {
			writeFileSync(join(bin, 'npx.cmd'), '');
			const env = {};
			for (const [key, value] of Object.entries(process.env)) if (!/^path(ext)?$/i.test(key)) env[key] = value;
			result = runCli('24.13.1', ['example-app', '--template', 'example'], {
				...env,
				PATH: bin,
				PATHEXT: '.COM;.EXE;.BAT;.CMD',
				npm_config_package: 'svelte-realtime@0.0.0',
				npm_config_call: 'svelte-realtime',
				npm_config_registry: 'http://127.0.0.1:9/',
				NODE_ENV: 'production'
			});
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
		const reached = JSON.parse(result.output.match(/EXTERNAL_COMMAND_REACHED (\{[^\r\n]+\})/)[1]);
		// A .cmd shim on Windows runs as one command line in place of an args array.
		expect([reached.file, ...reached.args].join(' ').split(' ')).toContain('sv@1.1.1');
		const shim = join(bin, 'npx.cmd');
		if (process.platform === 'win32') expect([shim, '"' + shim + '"'].some(prefix => reached.file.startsWith(prefix + ' '))).toBe(true);
		expect(reached.env).toContain('npm_config_registry');
		expect(reached.env).not.toContain('npm_config_package');
		expect(reached.env).not.toContain('npm_config_call');
		expect(reached.env).not.toContain('NODE_ENV');
	}, PROCESS_TEST_TIMEOUT);
});
