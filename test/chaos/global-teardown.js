// Multi-instance chaos teardown: reaps in-memory child handles with bounded
// TERM -> KILL escalation and uses authenticated self-shutdown for persisted
// records, then proves docker-compose is empty before deleting the evidence.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateChild, terminateOwnedProcess } from './process-lifecycle.js';
import { chaosRun, composeArgs, readContext, removeRun } from './run-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const run = chaosRun();
const ctxFile = run.context;

export default async function globalTeardown() {
	// A rejected duplicate run identifier never grants cleanup ownership.
	if (globalThis.__chaosOwner !== run.id || !existsSync(run.marker)) return;
	const ctx = globalThis.__chaosCtx;
	let persisted = null;
	const errors = [];
	if (existsSync(ctxFile)) {
		try {
			persisted = readContext(run);
		} catch (error) {
			errors.push(new Error('could not parse chaos cleanup context', { cause: error }));
		}
	}
	if (ctx && Array.isArray(ctx.instances)) {
		await Promise.all(ctx.instances.map((proc) =>
			terminateChild(proc).catch((error) => errors.push(error))
		));
	}
	const ownedProcesses = new Map(
		(persisted?.ownedProcesses || []).map((record) => [record.pid, record])
	);
	await Promise.all([...ownedProcesses.values()].map((record) =>
		terminateOwnedProcess(record).catch((error) => errors.push(error))
	));
	try {
		const env = {
			...process.env,
			CHAOS_REDIS_PORT: String(persisted?.redisPort || ctx?.redisPort || 0)
		};
		execFileSync('docker', composeArgs(run, ['down', '-v', '--remove-orphans']), {
			cwd: __dirname,
			stdio: 'pipe',
			env
		});
		const remaining = execFileSync('docker', composeArgs(run, ['ps', '-q']), {
			cwd: __dirname,
			stdio: 'pipe',
			encoding: 'utf-8',
			env
		}).trim();
		if (remaining) throw new Error('compose resources remain after teardown: ' + remaining);
	} catch (error) {
		errors.push(error);
	}
	if (errors.length > 0) {
		throw new AggregateError(errors, 'chaos teardown could not prove all resources exited');
	}
	removeRun(run);
	delete globalThis.__chaosCtx;
	delete globalThis.__chaosOwner;
}
