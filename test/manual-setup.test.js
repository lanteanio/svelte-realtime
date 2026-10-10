import { execFileSync, PROCESS_TEST_TIMEOUT, removeFixture } from './process-fixtures.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveNpmCli } from '../scripts/npm-cli.js';

const fixtures = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) removeFixture(fixture, 'manual-npm-'); });

it.each([
	['Windows Node installation', 'node.exe', 'node_modules/npm/bin/npm-cli.js'],
	['setup-node on Linux', 'bin/node', 'lib/node_modules/npm/bin/npm-cli.js']
])('runs the npm CLI from a direct node invocation on %s', (_name, nodePath, cliPath) => {
	const fixture = mkdtempSync(join(tmpdir(), 'manual-npm-'));
	fixtures.push(fixture);
	const target = join(fixture, cliPath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, 'process.stdout.write("npm cli reached");');
	const cli = resolveNpmCli({ execPath: join(fixture, nodePath), npmExecPath: null });
	expect(execFileSync(process.execPath, [cli], { encoding: 'utf8' })).toBe('npm cli reached');
}, PROCESS_TEST_TIMEOUT);

it('reports a missing npm installation before creating an app', () => {
	const fixture = mkdtempSync(join(tmpdir(), 'manual-npm-'));
	fixtures.push(fixture);
	expect(() => resolveNpmCli({ execPath: join(fixture, 'node'), npmExecPath: null })).toThrow('Cannot locate npm-cli.js');
});
