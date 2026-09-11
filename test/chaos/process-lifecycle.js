const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error) {
	return [error?.message, error?.stdout, error?.stderr]
		.filter((value) => value !== undefined && value !== null)
		.map((value) => Buffer.isBuffer(value) ? value.toString('utf-8') : String(value))
		.join('\n');
}

export function isPortBindCollision(error) {
	const text = errorText(error);
	return /port is already allocated/i.test(text) ||
		/failed to bind host port/i.test(text) ||
		/ports are not available[^\n]*bind/i.test(text) ||
		/bind[^\n]*(?:address already in use|only one usage of each socket address)/i.test(text);
}

export async function retryPortBind(operation, cleanup, options = {}) {
	const maxAttempts = options.maxAttempts ?? 5;
	const retryDelayMs = options.retryDelayMs ?? 100;
	let lastCollision = null;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await operation(attempt);
		} catch (error) {
			try {
				await cleanup(attempt);
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], 'port-bind attempt and cleanup both failed');
			}
			if (!isPortBindCollision(error)) throw error;
			lastCollision = error;
			if (attempt < maxAttempts) await delay(retryDelayMs);
		}
	}
	throw new Error('host port remained allocated after ' + maxAttempts + ' attempts', {
		cause: lastCollision
	});
}

export function isPidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForPidExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) return true;
		await delay(50);
	}
	return !isPidAlive(pid);
}

async function waitForChildExit(proc, timeoutMs) {
	if (proc.exitCode !== null || proc.signalCode !== null || !isPidAlive(proc.pid)) return true;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		proc.once('exit', () => finish(true));
	});
}

export async function terminateChild(proc, options = {}) {
	if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null || !isPidAlive(proc.pid)) return;
	const termTimeoutMs = options.termTimeoutMs ?? 5_000;
	const killTimeoutMs = options.killTimeoutMs ?? 5_000;
	try { proc.kill('SIGTERM'); } catch {}
	if (await waitForChildExit(proc, termTimeoutMs)) return;
	try { proc.kill('SIGKILL'); } catch {}
	if (await waitForChildExit(proc, killTimeoutMs)) return;
	throw new Error('child process ' + proc.pid + ' survived SIGTERM and SIGKILL');
}

export async function terminateOwnedProcess(record, options = {}) {
	if (!isPidAlive(record?.pid)) return;
	if (!Number.isInteger(record?.cleanupPort) || record.cleanupPort <= 0 || !record?.cleanupToken) {
		throw new Error('refusing to signal process ' + record?.pid + ' without cleanup ownership proof');
	}
	let response;
	try {
		response = await fetch('http://127.0.0.1:' + record.cleanupPort + '/__chaos__/shutdown', {
			method: 'POST',
			headers: { 'x-chaos-cleanup-token': record.cleanupToken },
			signal: AbortSignal.timeout(options.requestTimeoutMs ?? 2_000)
		});
	} catch (error) {
		if (!isPidAlive(record.pid)) return;
		throw new Error('could not authenticate ownership of process ' + record.pid, { cause: error });
	}
	if (response.status !== 202) {
		throw new Error(
			'refusing to signal process ' + record.pid + ': cleanup ownership endpoint returned ' + response.status
		);
	}
	if (await waitForPidExit(record.pid, options.shutdownTimeoutMs ?? 5_000)) return;
	throw new Error('owned process ' + record.pid + ' accepted shutdown but did not exit');
}
