import { describe, it, expect } from 'vitest';
import { spawnSync, PROCESS_TEST_TIMEOUT } from './process-fixtures.js';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli-utils.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

describe('scaffold prompt requirements', () => {
	it.each([[], ['sample'], ['--template', 'example']].map((args) => ({ args })))('rejects incomplete piped input $args with an actionable exit', ({ args }) => {
		const result = spawnSync(process.execPath, [cli, ...args], {
			input: '', encoding: 'utf8'
		});
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('--template minimal|example|demo');
		expect(result.stderr).toContain('project name');
	}, PROCESS_TEST_TIMEOUT);

	it('allows missing values to reach prompts on interactive input', () => {
		expect(parseArgs([], { interactive: true })).toEqual({ name: undefined, template: undefined });
		expect(parseArgs(['sample'], { interactive: true })).toEqual({ name: 'sample', template: undefined });
	});

	it('accepts complete arguments without an interactive terminal', () => {
		expect(parseArgs(['sample', '--template', 'example'], { interactive: false }))
			.toEqual({ name: 'sample', template: 'example' });
	});

	it('keeps help available on piped input', () => {
		const result = spawnSync(process.execPath, [cli, '--help'], { input: '', encoding: 'utf8' });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Usage:');
	}, PROCESS_TEST_TIMEOUT);
});
