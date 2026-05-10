import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseArgs, detectAgent } from '../cli-utils.js';

const _here = dirname(fileURLToPath(import.meta.url));
const _cliSrc = readFileSync(resolve(_here, '..', 'cli.js'), 'utf8');

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
		expect(_cliSrc).toContain('replace this with a real authentication step');
		expect(_cliSrc).toContain('Returning false from upgrade() rejects the connection');
	});

	it('the SECURITY block precedes the upgrade() function in the scaffold template', () => {
		const securityIdx = _cliSrc.indexOf('// SECURITY:');
		const upgradeIdx = _cliSrc.indexOf('export function upgrade()');
		expect(securityIdx).toBeGreaterThan(0);
		expect(upgradeIdx).toBeGreaterThan(securityIdx);
	});
});
