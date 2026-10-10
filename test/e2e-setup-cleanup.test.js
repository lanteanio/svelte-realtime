import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
import setup from './e2e/global-setup.js';
import teardown from './e2e/global-teardown.js';

afterEach(() => { vi.clearAllMocks(); delete globalThis.__e2eServers; });
function processFixture() {
	const child = new EventEmitter();
	child.exitCode = null;
	child.signalCode = null;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = { end: vi.fn(() => { child.exitCode = 0; child.emit('exit', 0); }) };
	child.kill = vi.fn();
	return child;
}
it('stops the running dev server when production startup fails', async () => {
	const dev = processFixture();
	const prod = processFixture();
	spawn.mockImplementationOnce(() => { queueMicrotask(() => dev.stdout.emit('data', 'Listening on localhost:3456')); return dev; });
	spawn.mockImplementationOnce(() => { queueMicrotask(() => { prod.exitCode = 1; prod.emit('exit', 1); }); return prod; });
	await expect(setup()).rejects.toThrow('Server exited with code 1');
	expect(dev.stdin.end).toHaveBeenCalledOnce();
	expect(dev.kill).not.toHaveBeenCalled();
});
it('does not wait for an already exited server', async () => {
	const child = processFixture();
	child.exitCode = 1;
	globalThis.__e2eServers = [child];
	await teardown();
	expect(child.stdin.end).not.toHaveBeenCalled();
});
