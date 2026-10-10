import { execFileSync as execute, spawnSync as spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

export const PROCESS_TEST_TIMEOUT = 120_000;
const processOptions = { timeout: 30_000, windowsHide: true };

export function execFileSync(file, args, options) {
	return execute(file, args, { ...processOptions, ...options });
}

export function spawnSync(file, args, options) {
	return spawn(file, args, { ...processOptions, ...options });
}

export function removeFixture(directory, prefix, parent = tmpdir()) {
	const target = resolve(directory);
	if (dirname(target) !== resolve(parent) || !basename(target).startsWith(prefix)) throw new Error('Unexpected fixture cleanup path');
	rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
