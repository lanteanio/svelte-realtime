import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseArgs, detectAgent } from '../src/cli-utils.js';

const _here = dirname(fileURLToPath(import.meta.url));
const _cliSrc = readFileSync(resolve(_here, '..', 'src', 'cli.js'), 'utf8');

// - parseArgs (in-process) ---------------------------------------------------

describe('parseArgs', () => {
	it('returns help flag for --help', () => {
		expect(parseArgs(['--help'])).toEqual({ help: true });
	});

	it('returns help flag for -h', () => {
		expect(parseArgs(['-h'])).toEqual({ help: true });
	});

	it('rejects invalid project names', () => {
		const result = parseArgs(['my app', '--template', 'minimal']);
		expect(result.error).toContain('Invalid project name');
	});

	it('rejects names with path traversal', () => {
		const result = parseArgs(['../evil', '--template', 'minimal']);
		expect(result.error).toContain('Invalid project name');
	});

	it('rejects names with dots', () => {
		const result = parseArgs(['my.app', '--template', 'minimal']);
		expect(result.error).toContain('Invalid project name');
	});

	it('rejects unknown template values', () => {
		const result = parseArgs(['test-app', '--template', 'bogus']);
		expect(result.error).toContain('Unknown template');
	});

	it('rejects --template=bogus', () => {
		const result = parseArgs(['test-app', '--template=bogus']);
		expect(result.error).toContain('Unknown template');
	});

	it('accepts valid names with hyphens and underscores', () => {
		const result = parseArgs(['my-cool_app123', '--template', 'minimal']);
		expect(result.error).toBeUndefined();
		expect(result.name).toBe('my-cool_app123');
		expect(result.template).toBe('minimal');
	});

	it('accepts --template=minimal', () => {
		const result = parseArgs(['test-min', '--template=minimal']);
		expect(result.error).toBeUndefined();
		expect(result.template).toBe('minimal');
	});

	it('accepts --template example', () => {
		const result = parseArgs(['test-ex', '--template', 'example']);
		expect(result.error).toBeUndefined();
		expect(result.template).toBe('example');
	});

	it('detects existing directory', () => {
		const result = parseArgs(['existing'], { dirExists: () => true });
		expect(result.error).toContain('already exists');
	});

	it('returns name and template when both provided', () => {
		const result = parseArgs(['myapp', '--template', 'demo']);
		expect(result).toEqual({ name: 'myapp', template: 'demo' });
	});

	it('returns undefined name when none provided', () => {
		const result = parseArgs([]);
		expect(result.name).toBeUndefined();
		expect(result.error).toBeUndefined();
	});

	it('--template with no name does not treat template value as name', () => {
		const result = parseArgs(['--template', 'minimal']);
		expect(result.name).toBeUndefined();
		expect(result.template).toBe('minimal');
	});

	it('--template before name parses both correctly', () => {
		const result = parseArgs(['--template', 'demo', 'my-app']);
		expect(result.name).toBe('my-app');
		expect(result.template).toBe('demo');
	});

	it('name before --template parses both correctly', () => {
		const result = parseArgs(['my-app', '--template', 'example']);
		expect(result.name).toBe('my-app');
		expect(result.template).toBe('example');
	});

	it('--template=demo before name parses both correctly', () => {
		const result = parseArgs(['--template=demo', 'my-app']);
		expect(result.name).toBe('my-app');
		expect(result.template).toBe('demo');
	});

	it('--template with no value returns error', () => {
		const result = parseArgs(['--template']);
		expect(result.error).toContain('requires a value');
	});

	it('--template followed by --help returns help', () => {
		const result = parseArgs(['--template', '--help']);
		expect(result).toEqual({ help: true });
	});

	it('--template followed by another flag returns error', () => {
		const result = parseArgs(['--template', '--verbose']);
		expect(result.error).toContain('requires a value');
	});

	it('--template= with empty value returns error', () => {
		const result = parseArgs(['--template=']);
		expect(result.error).toContain('requires a value');
	});
});

// - detectAgent (in-process) -------------------------------------------------

describe('detectAgent', () => {
	it('detects pnpm', () => {
		expect(detectAgent('pnpm/8.0.0 node/v20.0.0')).toBe('pnpm');
	});

	it('detects yarn', () => {
		expect(detectAgent('yarn/4.0.0 node/v20.0.0')).toBe('yarn');
	});

	it('detects bun', () => {
		expect(detectAgent('bun/1.0.0')).toBe('bun');
	});

	it('defaults to npm', () => {
		expect(detectAgent('')).toBe('npm');
	});

	it('defaults to npm for undefined', () => {
		expect(detectAgent(undefined)).toBe('npm');
	});
});

// - Scaffolded hooks.ws.ts carries a security warning header --------------

describe('init scaffold security', () => {
	it('writes hooks.ws.ts with a SECURITY warning above the no-auth upgrade()', () => {
		// The scaffold's hooks.ws.ts assigns every connection a random
		// UUID - there is no authentication. Apps that ship this to the
		// public internet without replacing the upgrade hook would have
		// no identity guarantee at all. The warning header tells the
		// developer at the call site rather than relying on docs that
		// may never get read.
		expect(_cliSrc).toContain('// SECURITY:');
		expect(_cliSrc).toContain('replace this hook with one of');
		expect(_cliSrc).toContain('Returning false from upgrade() rejects the connection');
	});

	it('the SECURITY block precedes the upgrade() function in the scaffold template', () => {
		const securityIdx = _cliSrc.indexOf('// SECURITY:');
		const upgradeIdx = _cliSrc.indexOf('export function upgrade()');
		expect(securityIdx).toBeGreaterThan(0);
		expect(upgradeIdx).toBeGreaterThan(securityIdx);
	});

	it('the SECURITY block lists the three real auth patterns the developer should pick from', () => {
		// A multi-line comment that names cookie sessions, bearer tokens,
		// and signed query tokens is more actionable than a vague
		// "replace this!" - it tells the developer concretely what to
		// reach for next. A regression that softens the comment back to
		// "replace this!" would fail these substring checks.
		expect(_cliSrc).toContain('Cookie session');
		expect(_cliSrc).toContain('Bearer token');
		expect(_cliSrc).toContain('Signed query token');
	});

	it('the scaffolded upgrade() emits a runtime console.warn while the placeholder marker is present', () => {
		// The placeholder is a single-line const the developer deletes
		// when they replace the hook with real auth. As long as it
		// remains, every accepted connection logs a warning - loud
		// enough to surface in dev terminals, log aggregators, and
		// stderr-tailing operators in prod. Deletion is the explicit
		// opt-out, not a comment toggle that decays over time.
		expect(_cliSrc).toContain('const SCAFFOLD_PLACEHOLDER = true;');
		expect(_cliSrc).toContain('if (SCAFFOLD_PLACEHOLDER)');
		expect(_cliSrc).toContain('console.warn');
		expect(_cliSrc).toContain('[svelte-realtime] upgrade() is the scaffold default');
	});

	it('the warning message references the file path so the developer can jump straight to it', () => {
		expect(_cliSrc).toContain('Edit src/hooks.ws.ts before deploying');
	});

	it('the same scaffolded hook is written for both minimal and example templates', () => {
		// Both templates open the scaffold to the same identity surface
		// (UUID-assigning permissive default). The runtime warn handles
		// the security signal; template choice only governs whether the
		// counter example files get written alongside the hook. A
		// regression that branches the hook on template would fail this
		// check.
		const writeCalls = _cliSrc.match(/writeFileSync\s*\(\s*join\(\s*dest\s*,\s*'src'\s*,\s*'hooks\.ws\.ts'\s*\)\s*,\s*([^)]+)\)/);
		expect(writeCalls).not.toBeNull();
		expect(writeCalls?.[1]).toContain('UPGRADE_HOOK_SCAFFOLD');
		expect(writeCalls?.[1]).not.toMatch(/template\s*===/);
	});
});

// - run() helper uses execFileSync with arg arrays (no template-string shells)

describe('run() helper', () => {
	it('imports execFileSync (not execSync)', () => {
		expect(_cliSrc).toMatch(/import\s+\{\s*execFileSync\s*\}\s+from\s+['"]child_process['"]/);
		expect(_cliSrc).not.toMatch(/import\s+\{\s*execSync\s*\}\s+from\s+['"]child_process['"]/);
		expect(_cliSrc).not.toMatch(/\bexecSync\(/);
	});

	it('every run() invocation passes args as an explicit array, not an interpolated template string', () => {
		// Match any `run(` call. The first argument must NOT be a template
		// literal (backtick-delimited). A regression would surface as a
		// template-literal first arg whose middle contains a `${...}`
		// placeholder - exactly the shell-injection class this refactor
		// closed.
		const runCalls = _cliSrc.match(/\brun\(([^)]*)/g) || [];
		// Exclude the function declaration itself: `function run(`.
		const invocations = runCalls.filter((m) => !/function\s+run\s*\(/.test(m));
		expect(invocations.length).toBeGreaterThan(0);
		for (const call of invocations) {
			expect(call).not.toMatch(/run\(\s*`/);
		}
	});

	it('git clone is invoked with arg array, not interpolated template', () => {
		expect(_cliSrc).toMatch(/run\(\s*'git'\s*,\s*\[\s*'clone'/);
	});

	it('sv create is invoked with arg array including the validated name as a separate element', () => {
		// The name parameter must reach execFileSync as its own array element,
		// not concatenated into a single shell-style string. If a future
		// edit re-introduces template-string interpolation here, the regex
		// for the array-shape call will stop matching.
		expect(_cliSrc).toMatch(/run\(\s*bin\('npx'\)\s*,\s*\[\s*'-y'\s*,\s*'sv'\s*,\s*'create'\s*,\s*name\s*,/);
	});

	it('bin() helper is defined and resolves package-manager binaries to .cmd on Windows', () => {
		expect(_cliSrc).toMatch(/function\s+bin\s*\(/);
		expect(_cliSrc).toMatch(/IS_WIN\s*&&\s*name\s*!==\s*'git'/);
	});
});
