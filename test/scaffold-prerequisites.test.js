import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkScaffoldBuild } from '../scripts/check-scaffold-build.js';

const fixtures = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		if (!fixture.startsWith(join(import.meta.dirname, '.scaffold-prerequisite-'))) throw new Error('Unexpected fixture path');
		rmSync(fixture, { recursive: true, force: true });
	}
});

it.each([
	['Node below the supported floor', { nodeVersion: '20.0.0' }, /node.*requires/i],
	['older glibc', { platform: 'linux', arch: 'x64', libc: { name: 'glibc', version: '2.37' } }, /glibc.*2\.38/i],
	['musl', { platform: 'linux', arch: 'x64', libc: { name: 'musl', version: null } }, /musl/i],
	['unsupported architecture', { platform: 'linux', arch: 'ppc64', libc: { name: 'glibc', version: '2.38' } }, /ppc64/i]
])('stops before building on %s using the installed adapter preflight', (_name, profile, expected) => {
	const fixture = mkdtempSync(join(import.meta.dirname, '.scaffold-prerequisite-'));
	fixtures.push(fixture);
	writeFileSync(join(fixture, 'package.json'), '{"private":true,"type":"module"}');
	const logs = [], commands = [];
	expect(() => checkScaffoldBuild({ fixture, log: line => logs.push(line), run(file, args, options) {
		commands.push(args);
		if (args[0].endsWith('preflight.js')) {
			// Execute the installed policy and native import in a fresh process,
			// supplying one unsupported host dimension at its public probe seam.
			const code = `import { runPreflight } from ${JSON.stringify(pathToFileURL(args[0]).href)};
const result = await runPreflight(${JSON.stringify(profile)});
if (!result.ok) process.exitCode = 1;`;
			return spawnSync(file, ['--input-type=module', '-e', code], { ...options, timeout: 10000 });
		}
		throw new Error('The build ran before prerequisites passed');
	} })).toThrow(/Scaffold verification command failed/);
	expect(commands).toHaveLength(1);
	expect(logs.join('\n')).toMatch(expected);
	expect(logs.join('\n')).toContain('preflight FAILED at prerequisite boundary');
	expect(logs.join('\n')).not.toContain('Building the production app');
	expect(existsSync(join(fixture, 'build'))).toBe(false);
});
