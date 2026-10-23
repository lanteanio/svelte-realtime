import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, win32 } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
// Exercise the real prompt implementation over controlled terminal input.
// The first external command is captured and stopped before it can create,
// install, clone, or otherwise change anything outside the child process.
const preload = 'data:text/javascript,' + encodeURIComponent(`
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process.stdin, 'isTTY', { value: true });
process.stdin.setRawMode = () => process.stdin;
Object.defineProperties(process.stdout, { columns: { value: 80 }, rows: { value: 24 } });
childProcess.execFileSync = (file, args) => {
	console.log('CLI_EXEC ' + JSON.stringify({ file, args }));
	throw new Error('Stopped before external work');
};
syncBuiltinESMExports();
`);

// The CLI looks commands up through PATH on Windows. Give it a PATH holding only
// placeholder npx and git files, so the outcome does not depend on what the
// machine running the tests has installed. Nothing runs them: execFileSync is
// stubbed above.
const fakeBin = mkdtempSync(join(tmpdir(), 'realtime-prompt-bin-'));
writeFileSync(join(fakeBin, 'npx.cmd'), '');
writeFileSync(join(fakeBin, 'git.exe'), '');
afterAll(() => rmSync(fakeBin, { recursive: true, force: true }));
const childEnv = { FORCE_COLOR: '0' };
for (const [key, value] of Object.entries(process.env)) if (key.toUpperCase() !== 'PATH' && key.toUpperCase() !== 'PATHEXT') childEnv[key] = value;
childEnv.PATH = fakeBin;
childEnv.PATHEXT = '.COM;.EXE;.BAT;.CMD';

// On Windows a .cmd shim runs as one command line with no args array, so read
// the resolved file and the words from either form.
function command({ file, args }) {
	let words = args;
	if (args.length === 0) {
		const match = /^("[^"]*"|\S+)\s*(.*)$/.exec(file);
		file = match[1].replace(/^"|"$/g, '');
		words = match[2] ? match[2].split(' ').map((word) => word.replace(/^"(.*)"$/, '$1')) : [];
	}
	if (process.platform === 'win32') expect(win32.dirname(file)).toBe(fakeBin);
	return { name: win32.basename(file).replace(/\.(exe|cmd)$/i, '').toLowerCase(), args: words };
}

function terminal(args, steps) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['--import', preload, cli, ...args], {
			cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv
		});
		let output = '', next = 0;
		const timer = setTimeout(() => { child.kill(); reject(new Error('CLI prompt timed out: ' + output)); }, 15000);
		const receive = (chunk) => {
			output += stripVTControlCharacters(chunk.toString());
			if (next < steps.length && output.includes(steps[next].waitFor)) {
				child.stdin.write(steps[next++].input);
			}
		};
		child.stdout.on('data', receive);
		child.stderr.on('data', receive);
		child.once('error', (error) => { clearTimeout(timer); reject(error); });
		child.once('close', (code) => { clearTimeout(timer); resolve({ code, output, completedSteps: next }); });
	});
}

describe('interactive CLI prompts', { timeout: 25000 }, () => {
	it('cancels project-name input without starting external work', async () => {
		const result = await terminal([], [{ waitFor: 'Project name', input: '\x03' }]);
		expect(result.code).toBe(0);
		expect(result.output).toContain('Cancelled.');
		expect(result.output).not.toContain('CLI_EXEC');
	});

	it.each([
		['bad.name', 'Use only letters, numbers, hyphens, and underscores.'],
		['src', 'already exists.']
	])('validates project name %j and remains cancellable', async (name, message) => {
		const result = await terminal([], [
			{ waitFor: 'Project name', input: name + '\r' },
			{ waitFor: message, input: '\x03' }
		]);
		expect(result.code).toBe(0);
		expect(result.completedSteps).toBe(2);
		expect(result.output).toContain(message);
		expect(result.output).toContain('Cancelled.');
		expect(result.output).not.toContain('CLI_EXEC');
	});

	it('accepts the displayed default name on empty input', async () => {
		const result = await terminal([], [
			{ waitFor: 'Project name', input: '\r' },
			{ waitFor: 'Which template would you like?', input: '\r' }
		]);
		expect(result.code).toBe(1);
		expect(result.completedSteps).toBe(2);
		const captured = JSON.parse(result.output.match(/CLI_EXEC (\{[^\r\n]+\})/)[1]);
		expect(command(captured)).toEqual({ name: 'npx', args: ['-y', 'sv@1.1.1', 'create', 'my-app', '--template', 'minimal', '--types', 'ts', '--no-add-ons', '--no-install'] });
	});

	it('accepts a valid name and exposes every cancellable template choice', async () => {
		const result = await terminal([], [
			{ waitFor: 'Project name', input: 'prompt-probe\r' },
			{ waitFor: 'Which template would you like?', input: '\x03' }
		]);
		expect(result.code).toBe(0);
		for (const label of ['Wiring only', 'Barebones example', 'Full demo app']) expect(result.output).toContain(label);
		expect(result.output).not.toContain('CLI_EXEC');
	});

	it.each(['minimal', 'example', 'demo'])('selects %s and reports an external command failure', async (template) => {
		const index = ['minimal', 'example', 'demo'].indexOf(template);
		const result = await terminal(['prompt-probe'], [
			{ waitFor: 'Which template would you like?', input: '\x1b[B'.repeat(index) + '\r' }
		]);
		expect(result.code).toBe(1);
		expect(result.output).toContain('Command failed:');
		const selected = ['Wiring only', 'Barebones example', 'Full demo app'][index];
		expect(result.output).toMatch(new RegExp('Which template would you like\\?[^\\n]*\\n[^\\n]*' + selected));
		const captured = JSON.parse(result.output.match(/CLI_EXEC (\{[^\r\n]+\})/)[1]);
		if (template === 'demo') expect(command(captured)).toEqual({ name: 'git', args: ['clone', 'https://github.com/lanteanio/svelte-realtime-demo.git', 'prompt-probe'] });
		else expect(command(captured)).toEqual({ name: 'npx', args: ['-y', 'sv@1.1.1', 'create', 'prompt-probe', '--template', 'minimal', '--types', 'ts', '--no-add-ons', '--no-install'] });
	});
});
