import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, linkSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import {
	cmdLine,
	findWindowsCommand,
	windowsCommand,
	parseArgs,
	detectAgent,
	formatScaffoldAuthWarning,
	packageExecArgs,
	renderScaffoldAuthWarningStatement,
	renderViteConfig,
	renderFirstRunTranscript,
	runScaffoldVerification,
	SCAFFOLD_ADAPTER_SPEC,
	SCAFFOLD_EXTENSIONS_SPEC,
	SCAFFOLD_REALTIME_SPEC,
	SCAFFOLD_SV_SPEC,
	SCAFFOLD_UWS_SPEC,
	withoutAdapterAuto
} from '../src/cli-utils.js';

const _here = dirname(fileURLToPath(import.meta.url));
const _cliSrc = readFileSync(resolve(_here, '..', 'src', 'cli.js'), 'utf8');
const _cliUtilsSrc = readFileSync(resolve(_here, '..', 'src', 'cli-utils.js'), 'utf8');

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

// - deterministic first-success route --------------------------------------

describe('newcomer scaffold contract', () => {
	it('pins the audited adapter, realtime, and native addon tuple', () => {
		expect(SCAFFOLD_ADAPTER_SPEC).toBe('svelte-adapter-uws@0.6.0-next.96');
		expect(SCAFFOLD_REALTIME_SPEC).toBe('svelte-realtime@0.6.0-next.91');
		expect(SCAFFOLD_EXTENSIONS_SPEC).toBe('svelte-adapter-uws-extensions@0.6.0-next.64');
		expect(SCAFFOLD_UWS_SPEC).toBe(
			'https://github.com/uNetworking/uWebSockets.js/archive/refs/tags/v20.69.0.tar.gz'
		);
		expect(_cliSrc).not.toContain('uNetworking/uWebSockets.js#v20.60.0');
	});

	it.each([
		['npm', ['exec', '--', 'svelte-adapter-uws-preflight']],
		['pnpm', ['exec', 'svelte-adapter-uws-preflight']],
		['yarn', ['exec', 'svelte-adapter-uws-preflight']],
		['bun', ['x', 'svelte-adapter-uws-preflight']]
	])('runs the installed prerequisite gate with %s', (agent, expected) => {
		expect(packageExecArgs(agent, 'svelte-adapter-uws-preflight')).toEqual(expected);
	});

	it('generates one consolidated current-sv configuration', () => {
		const config = renderViteConfig();
		expect(config).toContain("import adapter from 'svelte-adapter-uws'");
		expect(config).toContain('sveltekit({');
		expect(config).toContain('adapter: adapter({ websocket: true })');
		expect(config).toContain('uws()');
		expect(config).toContain('realtime()');
		expect(_cliSrc).toContain("rmSync(join(dest, 'svelte.config.js'), { force: true })");
	});

	it('drops adapter-auto from the generated manifest and keeps everything else', () => {
		const generated = {
			name: 'fresh-app',
			devDependencies: { '@sveltejs/adapter-auto': '^7.0.0', '@sveltejs/kit': '^3.0.0', vite: '^8.0.0' },
			dependencies: { '@sveltejs/adapter-auto': '^7.0.0', svelte: '^5.0.0' }
		};
		const cleaned = withoutAdapterAuto(generated);
		expect(cleaned).toEqual({
			name: 'fresh-app',
			devDependencies: { '@sveltejs/kit': '^3.0.0', vite: '^8.0.0' },
			dependencies: { svelte: '^5.0.0' }
		});
		expect(generated.devDependencies['@sveltejs/adapter-auto']).toBe('^7.0.0');
		expect(withoutAdapterAuto({ name: 'bare' })).toEqual({ name: 'bare' });
		expect(_cliSrc).toContain('withoutAdapterAuto(JSON.parse(readFileSync(manifestPath');
	});

	it('executes preflight and build in order through the injected real runner contract', () => {
		const events = [];
		runScaffoldVerification({
			agent: 'npm',
			dest: 'fresh-app',
			run: (file, args, cwd) => events.push({ file, args, cwd }),
			onStep: (message) => events.push({ step: message }),
			onSuccess: (message) => events.push({ success: message })
		});
		expect(events).toEqual([
			{ step: 'Checking Node, OS, architecture, libc, and uWebSockets.js' },
			{
				file: 'npm',
				args: ['exec', '--', 'svelte-adapter-uws-preflight'],
				cwd: 'fresh-app'
			},
			{ step: 'Building the production app' },
			{ file: 'npm', args: ['run', 'build'], cwd: 'fresh-app' },
			{ success: 'Production build verified' }
		]);
	});

	it('has one common verification/success exit after both template branches', () => {
		expect(_cliSrc.match(/runScaffoldVerification\(/g)).toHaveLength(1);
		expect(_cliSrc.match(/p\.outro\(/g)).toHaveLength(1);
		expect(_cliSrc).not.toContain("p.log.success('Configured.')");
		const demo = _cliSrc.indexOf("if (template === 'demo')");
		const normal = _cliSrc.indexOf("if (template !== 'demo')");
		const verify = _cliSrc.indexOf('runScaffoldVerification({');
		const success = _cliSrc.indexOf('p.outro(`Verified.');
		expect(normal).toBeGreaterThan(demo);
		expect(verify).toBeGreaterThan(normal);
		expect(success).toBeGreaterThan(verify);
	});

	it('verifies the immutable demo template before installing its dependency tuple', () => {
		const demo = _cliSrc.slice(
			_cliSrc.indexOf("if (template === 'demo')"),
			_cliSrc.indexOf("if (template !== 'demo')")
		);
		expect(demo).not.toContain("run(agent, ['install'], dest)");
		expect(demo.indexOf('SCAFFOLD_ADAPTER_SPEC')).toBeGreaterThan(0);
		expect(demo.indexOf('SCAFFOLD_UWS_SPEC')).toBeGreaterThan(0);
		expect(demo.indexOf('checkoutDemoTemplate({')).toBeLessThan(demo.indexOf('SCAFFOLD_ADAPTER_SPEC'));
		expect(demo).toContain('revision: DEMO_COMMIT');
		expect(_cliSrc).toMatch(/const DEMO_COMMIT = '[a-f0-9]{40}';/);
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
		expect(_cliSrc).toContain('replace this hook with one of');
		expect(_cliSrc).toContain('Returning false from upgrade() rejects the connection');
	});

	it('the SECURITY block precedes the upgrade() function in the scaffold template', () => {
		const securityIdx = _cliSrc.indexOf('// SECURITY:');
		const upgradeIdx = _cliSrc.indexOf('export function upgrade()');
		expect(securityIdx).toBeGreaterThan(0);
		expect(upgradeIdx).toBeGreaterThan(securityIdx);
	});

	it('the SECURITY block lists the three real auth patterns the developer should pick from', () => {
		// A multi-line comment that names cookie sessions, bearer tokens,
		// and signed query tokens is more actionable than a vague
		// "replace this!" - it tells the developer concretely what to
		// reach for next. A regression that softens the comment back to
		// "replace this!" would fail these substring checks.
		expect(_cliSrc).toContain('Cookie session');
		expect(_cliSrc).toContain('Bearer token');
		expect(_cliSrc).toContain('Signed query token');
	});

	it('the scaffolded upgrade() emits a runtime console.warn while the placeholder marker is present', () => {
		// The placeholder is a single-line const the developer deletes
		// when they replace the hook with real auth. As long as it
		// remains, every accepted connection logs a warning - loud
		// enough to surface in dev terminals, log aggregators, and
		// stderr-tailing operators in prod. Deletion is the explicit
		// opt-out, not a comment toggle that decays over time.
		expect(_cliSrc).toContain('const SCAFFOLD_PLACEHOLDER = true;');
		expect(_cliSrc).toContain('if (SCAFFOLD_PLACEHOLDER)');
		expect(_cliSrc).toContain('console.warn');
		expect(formatScaffoldAuthWarning()).toBe(
			'[SR-ONBOARD-001] Scaffold authentication is still permissive: Every connection receives a random UUID. Replace upgrade() in src/hooks.ws.ts and delete SCAFFOLD_PLACEHOLDER before deployment.'
		);
		expect(renderScaffoldAuthWarningStatement()).toBe(
			'console.warn("[SR-ONBOARD-001] Scaffold authentication is still permissive: Every connection receives a random UUID. Replace upgrade() in src/hooks.ws.ts and delete SCAFFOLD_PLACEHOLDER before deployment.");'
		);
		expect(_cliSrc).toContain('renderScaffoldAuthWarningStatement()');
		expect(_cliSrc).not.toContain('JSON.stringify(formatScaffoldAuthWarning())');
	});

	it('the warning message references the file path so the developer can jump straight to it', () => {
		expect(formatScaffoldAuthWarning()).toContain('src/hooks.ws.ts');
	});

	it('the same scaffolded hook is written for both minimal and example templates', () => {
		// Both templates open the scaffold to the same identity surface
		// (UUID-assigning permissive default). The runtime warn handles
		// the security signal; template choice only governs whether the
		// counter example files get written alongside the hook. A
		// regression that branches the hook on template would fail this
		// check.
		const writeCalls = _cliSrc.match(/writeFileSync\s*\(\s*join\(\s*dest\s*,\s*'src'\s*,\s*'hooks\.ws\.ts'\s*\)\s*,\s*([^)]+)\)/);
		expect(writeCalls).not.toBeNull();
		expect(writeCalls?.[1]).toContain('UPGRADE_HOOK_SCAFFOLD');
		expect(writeCalls?.[1]).not.toMatch(/template\s*===/);
	});
});

describe('accepted first-run transcript', () => {
	it('contains every owned success checkpoint and the canonical warning once', () => {
		const transcript = renderFirstRunTranscript();
		expect(transcript).toContain('preflight OK');
		expect(transcript).toContain('Production build verified');
		expect(transcript).toContain('Verified. cd my-app && npm run dev');
		expect(transcript.match(/SR-ONBOARD-001/g)).toHaveLength(1);
		expect(transcript).toContain(formatScaffoldAuthWarning());
	});
});

// - run() helper uses execFileSync with arg arrays (no template-string shells)

describe('run() helper', () => {
	it('imports execFileSync (not execSync)', () => {
		expect(_cliSrc).toMatch(/import\s+\{\s*execFileSync\s*\}\s+from\s+['"]child_process['"]/);
		expect(_cliSrc).not.toMatch(/import\s+\{\s*execSync\s*\}\s+from\s+['"]child_process['"]/);
		expect(_cliSrc).not.toMatch(/\bexecSync\(/);
	});

	it('every run() invocation passes args as an explicit array, not an interpolated template string', () => {
		// Match any `run(` call. The first argument must NOT be a template
		// literal (backtick-delimited). A regression would surface as a
		// template-literal first arg whose middle contains a `${...}`
		// placeholder - exactly the shell-injection class this refactor
		// closed.
		const runCalls = _cliSrc.match(/\brun\(([^)]*)/g) || [];
		// Exclude the function declaration itself: `function run(`.
		const invocations = runCalls.filter((m) => !/function\s+run\s*\(/.test(m));
		expect(invocations.length).toBeGreaterThan(0);
		for (const call of invocations) {
			expect(call).not.toMatch(/run\(\s*`/);
		}
	});

	it('git clone is invoked with arg array, not interpolated template', () => {
		expect(_cliUtilsSrc).toMatch(/run\(\s*'git'\s*,\s*\[\s*'clone'/);
	});

	it('sv create is invoked with arg array including the validated name as a separate element', () => {
		// The name parameter must reach execFileSync as its own array element,
		// not concatenated into a single shell-style string. If a future
		// edit re-introduces template-string interpolation here, the regex
		// for the array-shape call will stop matching.
		expect(_cliSrc).toMatch(/run\(\s*'npx'\s*,\s*\[\s*'-y'\s*,\s*SCAFFOLD_SV_SPEC\s*,\s*'create'\s*,\s*name\s*,/);
	});

	it('sv create runs a pinned SvelteKit 3 scaffold', () => {
		// An unpinned sv follows its latest release, whose generated
		// configuration this scaffold has not been verified against.
		expect(SCAFFOLD_SV_SPEC).toBe('sv@1.1.1');
	});

	it('passes bare command names and resolves them through PATH only on Windows', () => {
		// No extension is assumed: bun.exe and standalone pnpm.exe have no .cmd shim.
		expect(_cliSrc).not.toMatch(/\.cmd`/);
		expect(_cliSrc).not.toMatch(/function\s+bin\s*\(/);
		expect(_cliSrc).toMatch(/if \(IS_WIN\) \{\s*const command = windowsCommand\(file, args, env, isFile\);\s*execFileSync\(command\.file, command\.args, \{ cwd, stdio: 'inherit', env, shell: command\.shell \}\);/);
		// Linux and macOS keep the plain args array with no shell.
		expect(_cliSrc).toMatch(/\} else \{\s*execFileSync\(file, args, \{ cwd, stdio: 'inherit', env \}\);/);
	});
});

describe('Windows command resolution', () => {
	const install = ['add', 'svelte-adapter-uws@^0.6.0', 'svelte-realtime@^0.6.0'];
	/** @param {string[]} files */
	const fakeFs = (files) => {
		const set = new Set(files.map((f) => f.toLowerCase()));
		return (path) => set.has(path.toLowerCase());
	};
	const env = { Path: 'C:\\bun\\bin;"C:\\Program Files\\pnpm";;C:\\nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
	const files = ['C:\\bun\\bin\\bun.exe', 'C:\\Program Files\\pnpm\\pnpm.cmd', 'C:\\nodejs\\npm.cmd', 'C:\\nodejs\\node.exe'];

	it('finds an .exe-only agent and a .cmd-only agent, reading Path and PATHEXT case-insensitively', () => {
		const isFile = fakeFs(files);
		expect(findWindowsCommand('bun', env, isFile)).toBe('C:\\bun\\bin\\bun.exe');
		expect(findWindowsCommand('pnpm', env, isFile)).toBe('C:\\Program Files\\pnpm\\pnpm.cmd');
		expect(findWindowsCommand('npm', { path: env.Path, pathext: env.PATHEXT }, isFile)).toBe('C:\\nodejs\\npm.cmd');
		expect(findWindowsCommand('yarn', env, isFile)).toBeNull();
		expect(findWindowsCommand('bun', {}, isFile)).toBeNull();
	});

	it('takes the first PATH directory, then the first PATHEXT extension within it', () => {
		const both = ['C:\\a\\pnpm.cmd', 'C:\\b\\pnpm.exe', 'C:\\b\\pnpm.cmd'];
		expect(findWindowsCommand('pnpm', { PATH: 'C:\\a;C:\\b', PATHEXT: '.EXE;.CMD' }, fakeFs(both))).toBe('C:\\a\\pnpm.cmd');
		expect(findWindowsCommand('pnpm', { PATH: 'C:\\b;C:\\a', PATHEXT: '.EXE;.CMD' }, fakeFs(both))).toBe('C:\\b\\pnpm.exe');
		expect(findWindowsCommand('pnpm', { PATH: 'C:\\b;C:\\a', PATHEXT: '.CMD;.EXE' }, fakeFs(both))).toBe('C:\\b\\pnpm.cmd');
		// Without PATHEXT, the Windows default list applies.
		expect(findWindowsCommand('pnpm', { PATH: 'C:\\b' }, fakeFs(both))).toBe('C:\\b\\pnpm.exe');
	});

	it('does not search the working directory or relative PATH entries', () => {
		const seen = [];
		const everything = (path) => (seen.push(path), true);
		expect(findWindowsCommand('npm', { PATH: '.;bin;C:foo;..\\tools' }, everything)).toBeNull();
		expect(seen).toEqual([]);
		expect(findWindowsCommand('npm', { PATH: '.;bin;C:foo;C:\\nodejs' }, everything)).toBe('C:\\nodejs\\npm.com');
		expect(seen).toEqual(['C:\\nodejs\\npm.com']);
		expect(findWindowsCommand('npm', { PATH: '' }, () => true)).toBeNull();
	});

	it('considers only launchable PATHEXT extensions, in PATHEXT order', () => {
		const isFile = fakeFs(['C:\\early\\pnpm.js', 'C:\\early\\pnpm.vbs', 'C:\\late\\pnpm.cmd']);
		const pathext = '.JS;.VBS;.CMD;.EXE';
		expect(findWindowsCommand('pnpm', { PATH: 'C:\\early;C:\\late', PATHEXT: pathext }, isFile)).toBe('C:\\late\\pnpm.cmd');
		// A PATHEXT naming nothing launchable falls back to the Windows default list.
		expect(findWindowsCommand('pnpm', { PATH: 'C:\\early;C:\\late', PATHEXT: '.JS' }, isFile)).toBe('C:\\late\\pnpm.cmd');
	});

	it('splits PATH around quoted entries that contain a semicolon', () => {
		const isFile = fakeFs(['C:\\tools;v2\\bun.exe']);
		expect(findWindowsCommand('bun', { PATH: 'C:\\nodejs;"C:\\tools;v2";C:\\other' }, isFile)).toBe('C:\\tools;v2\\bun.exe');
		expect(findWindowsCommand('bun', { PATH: 'C:\\tools;v2' }, isFile)).toBeNull();
	});

	it('quotes a resolved shim path with & or ^ and refuses one with % or !', () => {
		const shims = ['C:\\R&D\\npm.cmd', 'C:\\a^b\\yarn.cmd', 'C:\\100%\\pnpm.cmd', 'C:\\Hey!\\bun.cmd'];
		const env = { PATH: 'C:\\R&D;C:\\a^b;C:\\100%;C:\\Hey!' };
		const isFile = fakeFs(shims);
		expect(windowsCommand('npm', ['run', 'build'], env, isFile).file).toBe('"C:\\R&D\\npm.cmd" run build');
		expect(windowsCommand('yarn', ['run', 'build'], env, isFile).file).toBe('"C:\\a^b\\yarn.cmd" run build');
		expect(() => windowsCommand('pnpm', ['run', 'build'], env, isFile)).toThrow(/cannot be passed through cmd.exe: C:\\100%\\pnpm.cmd/);
		expect(() => windowsCommand('bun', ['run', 'build'], env, isFile)).toThrow(/cannot be passed through cmd.exe: C:\\Hey!\\bun.cmd/);
	});

	it('runs an executable with an args array and a shim through one quoted command line', () => {
		const isFile = fakeFs(files);
		expect(windowsCommand('bun', install, env, isFile)).toEqual({ file: 'C:\\bun\\bin\\bun.exe', args: install, shell: false });
		expect(windowsCommand('pnpm', install, env, isFile)).toEqual({
			file: '"C:\\Program Files\\pnpm\\pnpm.cmd" add "svelte-adapter-uws@^0.6.0" "svelte-realtime@^0.6.0"',
			args: [],
			shell: true
		});
		expect(() => windowsCommand('yarn', install, env, isFile)).toThrow('yarn was not found on PATH');
		expect(() => windowsCommand('npm', ['%PATH%'], env, isFile)).toThrow(/cannot be passed through cmd.exe/);
	});

	it('quotes arguments that cmd.exe would rewrite and leaves the rest alone', () => {
		expect(cmdLine('npm.cmd', ['install', 'a@^1.0.0'])).toBe('npm.cmd install "a@^1.0.0"');
		expect(cmdLine('npx.cmd', ['-y', 'sv@1.1.1', 'create', 'my-app', 'a b', 'x&y', 'x|y', 'x<y', 'x>y', 'f(x)']))
			.toBe('npx.cmd -y sv@1.1.1 create my-app "a b" "x&y" "x|y" "x<y" "x>y" "f(x)"');
		expect(cmdLine('npm.cmd', ['run', ''])).toBe('npm.cmd run ""');
	});

	it.each(['say "hi"', '%PATH%', 'wow!', 'a\nb', 'a\rb', 'C:\\dir\\'])('refuses %j, which quoting cannot protect', (arg) => {
		expect(() => cmdLine('npm.cmd', [arg])).toThrow(/cannot be passed through cmd.exe/);
	});

	it('accepts every literal and scaffold spec run() is given in cli.js', () => {
		const calls = (_cliSrc + '\n' + _cliUtilsSrc).split('\n').filter((line) => /\brun\(/.test(line) && !/function\s+run\s*\(/.test(line));
		const literals = calls.flatMap((line) => [...line.matchAll(/'([^']*)'/g)].map((m) => m[1]));
		const demo = /const DEMO_REPO = '([^']+)'/.exec(_cliSrc)[1];
		const specs = [SCAFFOLD_ADAPTER_SPEC, SCAFFOLD_REALTIME_SPEC, SCAFFOLD_UWS_SPEC, SCAFFOLD_SV_SPEC];
		expect(literals).toContain('clone');
		expect(() => cmdLine('npm.cmd', [...literals, demo, ...specs, 'my-app'])).not.toThrow();
	});

	it.runIf(process.platform === 'win32')('launches an .exe-only and a .cmd-only agent from a real PATH', () => {
		const root = mkdtempSync(join(tmpdir(), 'realtime-path-'));
		try {
			const exeDir = join(root, 'bun bin');
			const cmdDir = join(root, 'pnpm (standalone)');
			mkdirSync(exeDir);
			mkdirSync(cmdDir);
			// A native executable named bun.exe, with no bun.cmd anywhere on PATH.
			try {
				linkSync(process.execPath, join(exeDir, 'bun.exe'));
			} catch {
				copyFileSync(process.execPath, join(exeDir, 'bun.exe'));
			}
			writeFileSync(join(cmdDir, 'args.js'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
			writeFileSync(join(cmdDir, 'pnpm.cmd'), '@"' + process.execPath + '" "%~dp0args.js" %*\r\n');
			const pathEnv = { ...process.env, PATH: exeDir + ';' + cmdDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
			for (const key of Object.keys(pathEnv)) if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete pathEnv[key];
			const isFile = (path) => statSync(path, { throwIfNoEntry: false })?.isFile() === true;
			const launch = (name, args) => {
				const command = windowsCommand(name, args, pathEnv, isFile);
				return JSON.parse(execFileSync(command.file, command.args, { cwd: root, env: pathEnv, shell: command.shell, encoding: 'utf8' }));
			};
			expect(launch('bun', ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...install])).toEqual(install);
			expect(launch('pnpm', install)).toEqual(install);
			// The bun installer ships no shim, so the name the scaffolder used to run does not exist.
			expect(findWindowsCommand('bun', { PATH: pathEnv.PATH, PATHEXT: '.CMD' }, isFile)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('package bin entries', () => {
	// npm marks a linked bin target executable on install, so a target tracked
	// as 100644 leaves the checkout dirty after the fixture install links the
	// package, and the release identity check refuses a dirty checkout.
	const root = resolve(_here, '..');
	const bins = Object.values(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).bin || {});

	it('tracks every bin target as an executable file with a node shebang', () => {
		expect(bins.length).toBeGreaterThan(0);
		for (const target of bins) {
			const entry = execFileSync('git', ['ls-files', '-s', '--', target], { cwd: root, encoding: 'utf8', windowsHide: true });
			expect(entry, target).toMatch(/^100755 /);
			expect(readFileSync(resolve(root, target), 'utf8').startsWith('#!/usr/bin/env node\n'), target).toBe(true);
		}
	});
});
