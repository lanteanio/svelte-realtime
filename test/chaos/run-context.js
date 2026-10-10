import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(suiteDir, '../..');
const sourceFixture = path.join(repository, 'test/fixture');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The config sets one identifier before Playwright forks setup and workers. */
export function chaosRun(env = process.env) {
	const id = env.REALTIME_CHAOS_RUN_ID ||= randomUUID();
	if (!uuid.test(id)) throw new Error('Invalid REALTIME_CHAOS_RUN_ID');
	const directory = path.join(tmpdir(), 'svelte-realtime-chaos-' + id);
	return {
		id, directory,
		fixture: path.join(directory, 'fixture'),
		context: path.join(directory, 'context.json'),
		marker: path.join(directory, 'owner.json'),
		project: 'realtime-chaos-' + id,
		results: path.join(suiteDir, 'test-results', id)
	};
}

export function composeArgs(run, args) {
	return ['compose', '--project-name', run.project, '--file', path.join(suiteDir, 'docker-compose.yml'), ...args];
}

/** Refuse an existing run directory rather than taking over its resources. */
export function initializeRun(run) {
	mkdirSync(run.directory);
	writeFileSync(run.marker, JSON.stringify({ id: run.id, repository }), { flag: 'wx' });
}

/** Each invocation compiles its own source, generated types, and build output. */
export function prepareFixture(run, fixtureSource = sourceFixture) {
	const dependencies = path.join(fixtureSource, 'node_modules');
	if (!existsSync(dependencies)) throw new Error('Install chaos fixture dependencies first: npm ci --prefix test/fixture');
	cpSync(fixtureSource, run.fixture, {
		recursive: true,
		filter(source) {
			const name = path.basename(source);
			return !['node_modules', 'build', '.svelte-kit', '.vite', '$types.d.ts'].includes(name);
		}
	});
	symlinkSync(dependencies, path.join(run.fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
}

export function readContext(run = chaosRun()) {
	const context = JSON.parse(readFileSync(run.context, 'utf8'));
	if (context.runId !== run.id) throw new Error('Chaos context belongs to another run');
	return context;
}

/** Delete only this invocation's UUID directory after proving ownership. */
export function removeRun(run) {
	const directory = path.resolve(run.directory);
	const expected = path.join(path.resolve(tmpdir()), 'svelte-realtime-chaos-' + run.id);
	if (!uuid.test(run.id) || directory !== expected) throw new Error('Refusing to remove an unowned chaos directory');
	const owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8'));
	if (owner.id !== run.id || owner.repository !== repository) throw new Error('Chaos directory ownership does not match');
	const dependencies = path.join(directory, 'fixture', 'node_modules');
	if (existsSync(dependencies) && lstatSync(dependencies).isSymbolicLink()) unlinkSync(dependencies);
	rmSync(directory, { recursive: true, force: true });
}

/** The parallel self-test opens both gates only after both servers are ready. */
export async function awaitStartGate(run, timeoutMs = 120_000) {
	if (process.env.REALTIME_CHAOS_WAIT_FOR_START !== '1') return;
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path.join(run.directory, 'start'))) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for the parallel chaos start gate');
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
