import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chaosRun, composeArgs, initializeRun, prepareFixture, readContext, removeRun } from './chaos/run-context.js';

const owned = [];
function createRun() {
	const run = chaosRun({});
	initializeRun(run);
	owned.push(run);
	return run;
}
afterEach(() => {
	for (const run of owned.splice(0)) if (existsSync(run.marker)) removeRun(run);
});

describe('parallel chaos ownership', () => {
	it('retains one inherited identity and rejects unsafe identifiers', () => {
		const env = {};
		const first = chaosRun(env);
		expect(chaosRun(env)).toEqual(first);
		expect(() => chaosRun({ REALTIME_CHAOS_RUN_ID: '../other' })).toThrow(/Invalid/);
	});

	it('isolates contexts and compose projects and preserves a neighboring run on cleanup', () => {
		const first = createRun();
		const second = createRun();
		writeFileSync(first.context, JSON.stringify({ runId: first.id, port: 1 }));
		writeFileSync(second.context, JSON.stringify({ runId: second.id, port: 2 }));
		expect(readContext(first).port).toBe(1);
		expect(readContext(second).port).toBe(2);
		expect(composeArgs(first, ['down'])).toContain(first.project);
		expect(composeArgs(first, ['down'])).not.toContain(second.project);
		expect(first.results).not.toBe(second.results);
		removeRun(first);
		expect(readContext(second).port).toBe(2);
	});

	it('rejects reused directories, foreign context records, and unowned deletion', () => {
		const run = createRun();
		expect(() => initializeRun(run)).toThrow();
		writeFileSync(run.context, JSON.stringify({ runId: chaosRun({}).id }));
		expect(() => readContext(run)).toThrow(/another run/);
		expect(() => removeRun({ ...run, directory: path.dirname(run.directory) })).toThrow(/unowned/);
		const marker = readFileSync(run.marker, 'utf8');
		writeFileSync(run.marker, JSON.stringify({ id: run.id, repository: 'another repository' }));
		try { expect(() => removeRun(run)).toThrow(/ownership/); }
		finally { writeFileSync(run.marker, marker); }
	});

	it('does not tear down another invocation after a duplicate identifier is refused', async () => {
		const run = createRun();
		writeFileSync(run.context, JSON.stringify({ runId: run.id, port: 1 }));
		vi.stubEnv('REALTIME_CHAOS_RUN_ID', run.id);
		vi.resetModules();
		try {
			const { default: setup } = await import('./chaos/global-setup.js');
			const { default: teardown } = await import('./chaos/global-teardown.js');
			await expect(setup()).rejects.toThrow();
			await teardown();
			expect(readContext(run).port).toBe(1);
			expect(existsSync(run.marker)).toBe(true);
		} finally { vi.unstubAllEnvs(); }
	});

	it('copies source into separate build roots and never removes shared dependencies', () => {
		const sourceRun = createRun();
		const source = path.join(sourceRun.directory, 'source');
		mkdirSync(path.join(source, 'node_modules'), { recursive: true });
		mkdirSync(path.join(source, 'build'));
		mkdirSync(path.join(source, '.svelte-kit'));
		writeFileSync(path.join(source, 'node_modules', 'sentinel'), 'dependency');
		writeFileSync(path.join(source, 'build', 'stale'), 'old build');
		writeFileSync(path.join(source, '.svelte-kit', 'stale'), 'old generated files');
		writeFileSync(path.join(source, 'source.js'), 'original');
		const first = createRun();
		const second = createRun();
		prepareFixture(first, source);
		prepareFixture(second, source);
		writeFileSync(path.join(first.fixture, 'source.js'), 'first build generation');
		expect(readFileSync(path.join(second.fixture, 'source.js'), 'utf8')).toBe('original');
		expect(existsSync(path.join(second.fixture, 'build'))).toBe(false);
		expect(existsSync(path.join(second.fixture, '.svelte-kit'))).toBe(false);
		removeRun(first);
		expect(readFileSync(path.join(second.fixture, 'node_modules', 'sentinel'), 'utf8')).toBe('dependency');
		removeRun(second);
		expect(readFileSync(path.join(source, 'node_modules', 'sentinel'), 'utf8')).toBe('dependency');
	});
});
