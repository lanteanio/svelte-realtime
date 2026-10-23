import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
it.each(['development', 'production'])('checks real dispatch outcomes and reports %s execution', mode => {
	const output = execFileSync(process.execPath, ['bench/rpc.mjs', '--check'], {
		cwd: root, encoding: 'utf8', timeout: 30_000,
		env: { ...process.env, NODE_ENV: mode, VITEST: '' }
	});
	expect(output).toContain(`Mode: ${mode}`);
	expect(output).toMatch(/Runtime: Node v/);
	expect(output).toContain('Dispatch model: CPU microbenchmark; closed loop; one request in flight.');
	expect(output).toContain(`CPU: ${JSON.stringify(cpus()[0]?.model ?? 'unknown')}; logical cores: ${cpus().length}`);
	const command = JSON.parse(output.match(/^Command argv: (.+)$/m)?.[1] ?? 'null');
	expect(command).toEqual([process.execPath, fileURLToPath(new URL('../bench/rpc.mjs', import.meta.url)), '--check']);
	expect(output).toContain('Non-RPC diagnostics: 0');
	expect(output).toContain('Non-RPC fixtures: 4 rejected, 0 handled, 0 responses');
	expect(output).toContain('RPC outcomes: 128 successes, 0 errors');
	expect(output).not.toContain('Stream merge throughput');
	expect(output).toContain('Check passed.');
}, 35_000);

it('checks real delivery authorization decisions in the benchmark', () => {
	const output = execFileSync(process.execPath, ['bench/delivery-authorization.mjs', '--check'], {
		cwd: root, encoding: 'utf8', timeout: 30_000,
		env: { ...process.env, VITEST: '' }
	});
	expect(output).toMatch(/svelte-realtime .+ delivery authorization benchmarks/);
	expect(output).toMatch(/Runtime: Node v/);
	expect(output).toContain('no policy: realtime({}) returns the plain message and unsubscribe hooks');
	for (const row of ['guard per message', 'policy call per delivery', 'guard, equal policy', 'switch to newer policy', 'guard, retired policy']) expect(output).toContain(row);
	expect(output).toContain('Check passed.');
}, 35_000);
