// @ts-check
import { win32, join } from 'path';
import { readFileSync } from 'fs';

export const VALID_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const VALID_TEMPLATES = ['minimal', 'example', 'demo'];

// One audited onboarding tuple. Keep these exact so a scaffold cannot silently
// combine independent "latest" releases whose native ABI or peer contract has
// not been verified together.
export const SCAFFOLD_ADAPTER_SPEC = 'svelte-adapter-uws@0.6.0-next.97';
export const SCAFFOLD_REALTIME_SPEC = 'svelte-realtime@0.6.0-next.92';
export const SCAFFOLD_EXTENSIONS_SPEC = 'svelte-adapter-uws-extensions@0.6.0-next.65';
export const SCAFFOLD_UWS_SPEC =
	'https://github.com/uNetworking/uWebSockets.js/archive/refs/tags/v20.69.0.tar.gz';
// Pinned so generated configuration stays on the SvelteKit 3 scaffold this
// release was verified against.
export const SCAFFOLD_SV_SPEC = 'sv@1.1.1';

/**
 * Fetch one immutable template without checking out the remote default branch.
 * No package-manager or template code runs until the detached identity matches.
 * @param {{ repository: string, revision: string, dest: string, run: (file: string, args: string[], cwd?: string) => void, readHead?: (dest: string) => string }} input
 */
export function checkoutDemoTemplate({ repository, revision, dest, run, readHead = directory => readFileSync(join(directory, '.git', 'HEAD'), 'utf8').trim() }) {
	if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('The demo template requires a full immutable commit ID');
	run('git', ['clone', '--no-checkout', '--no-recurse-submodules', '--filter=blob:none', '--no-tags', repository, dest]);
	run('git', ['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', 'origin', revision], dest);
	run('git', ['checkout', '--detach', '--no-recurse-submodules', revision], dest);
	if (readHead(dest) !== revision) throw new Error('The demo template checkout does not match its pinned commit');
}

// Owned once and embedded into the generated hooks file. Documentation and
// transcript generation consume these fields instead of maintaining a second
// prose approximation that can contradict the runtime warning.
export const SCAFFOLD_AUTH_WARNING = Object.freeze({
	code: 'SR-ONBOARD-001',
	title: 'Scaffold authentication is still permissive',
	body:
		'Every connection receives a random UUID. Replace upgrade() in src/hooks.ws.ts and delete SCAFFOLD_PLACEHOLDER before deployment.'
});

/**
 * The generated configuration uses svelte-adapter-uws only, so drop the
 * adapter-auto entry `sv create` lists. Other entries keep their order.
 * @param {any} manifest - Parsed package.json of the generated project
 * @returns {any}
 */
export function withoutAdapterAuto(manifest) {
	const next = { ...manifest };
	for (const field of ['dependencies', 'devDependencies']) {
		if (!next[field] || !('@sveltejs/adapter-auto' in next[field])) continue;
		next[field] = { ...next[field] };
		delete next[field]['@sveltejs/adapter-auto'];
	}
	return next;
}

export function formatScaffoldAuthWarning() {
	const warning = SCAFFOLD_AUTH_WARNING;
	return '[' + warning.code + '] ' + warning.title + ': ' + warning.body;
}

/**
 * Render the exact statement embedded in the generated hook. This keeps
 * quoting and punctuation under the same owned contract as docs and tests.
 */
export function renderScaffoldAuthWarningStatement() {
	return `console.warn(${JSON.stringify(formatScaffoldAuthWarning())});`;
}

/**
 * Execute a binary provided by the freshly installed project.
 * @param {'npm' | 'pnpm' | 'yarn' | 'bun'} agent
 * @param {string} binary
 */
export function packageExecArgs(agent, binary) {
	if (agent === 'npm') return ['exec', '--', binary];
	if (agent === 'bun') return ['x', binary];
	return ['exec', binary];
}

/**
 * The one verification path shared by every template. Keeping the command
 * runner injected makes the real order executable under test without invoking
 * package managers or the network.
 * @param {{
 *   agent: 'npm' | 'pnpm' | 'yarn' | 'bun',
 *   dest: string,
 *   run: (file: string, args: string[], cwd?: string) => void,
 *   onStep?: (message: string) => void,
 *   onSuccess?: (message: string) => void
 * }} input
 */
export function runScaffoldVerification({
	agent,
	dest,
	run,
	onStep = () => {},
	onSuccess = () => {}
}) {
	onStep('Checking Node, OS, architecture, libc, and uWebSockets.js');
	run(agent, packageExecArgs(agent, 'svelte-adapter-uws-preflight'), dest);
	onStep('Building the production app');
	run(agent, ['run', 'build'], dest);
	onSuccess('Production build verified');
}

/**
 * The command line that runs file with args through cmd.exe, which .cmd and
 * .bat files need on Windows. cmd.exe and a .cmd shim each read ^ as an escape
 * character, so an unquoted `pkg@^1.2.3` reaches the package manager as
 * `pkg@1.2.3`. Quoting keeps ^, &, |, <, >, parentheses and spaces literal.
 * What quoting cannot protect is refused: a double quote, %, !, a line break,
 * or a trailing backslash.
 * @param {string} file
 * @param {string[]} args
 * @returns {string}
 */
export function cmdLine(file, args) {
	return [file, ...args].map((arg) => {
		if (/["%!\r\n]|\\$/.test(arg)) throw new Error(`Argument cannot be passed through cmd.exe: ${arg}`);
		return arg === '' || /[\s^&|<>()]/.test(arg) ? `"${arg}"` : arg;
	}).join(' ');
}

/**
 * Read an environment variable the way Windows does, ignoring case. A copied
 * process.env is a plain object, so `env.PATH` misses a `Path` key.
 * @param {Record<string, string | undefined>} env
 * @param {string} key
 */
function winEnv(env, key) {
	const upper = key.toUpperCase();
	for (const name of Object.keys(env)) if (name.toUpperCase() === upper) return env[name];
	return undefined;
}

/**
 * Find the file Windows would run for a bare command name: every PATH
 * directory in order, each with every PATHEXT extension in order. Package
 * managers come as .cmd shims (npm, or pnpm and yarn through corepack) or as
 * native executables (the bun installer's bun.exe, standalone pnpm.exe), so
 * no single extension can be assumed. Only PATHEXT extensions that can be
 * launched here (.com, .exe, .bat, .cmd) count; a pnpm.js earlier on PATH is
 * passed over. Relative and drive-relative entries (`.`, `bin`, `C:foo`) are
 * skipped, so the working directory is never searched and a file in the
 * project being created cannot stand in for the package manager. Returns
 * null when nothing matches.
 * @param {string} name
 * @param {Record<string, string | undefined>} env
 * @param {(path: string) => boolean} isFile
 * @returns {string | null}
 */
export function findWindowsCommand(name, env, isFile) {
	const listed = (winEnv(env, 'PATHEXT') || '')
		.split(';')
		.map((ext) => ext.trim().toLowerCase())
		.filter((ext) => RUNNABLE_EXTS.includes(ext));
	const exts = listed.length ? listed : RUNNABLE_EXTS;
	for (const dir of splitWindowsPath(winEnv(env, 'PATH') || '')) {
		if (!win32.isAbsolute(dir) || /^[A-Za-z]:(?![\\/])/.test(dir)) continue;
		for (const ext of exts) {
			const candidate = win32.join(dir, name + ext);
			if (isFile(candidate)) return candidate;
		}
	}
	return null;
}

const RUNNABLE_EXTS = ['.com', '.exe', '.bat', '.cmd'];

/**
 * Split a Windows PATH value into directories. A double-quoted entry may
 * contain `;`; the quotes themselves are not part of the directory.
 * @param {string} value
 * @returns {string[]}
 */
function splitWindowsPath(value) {
	const dirs = [];
	let current = '';
	let quoted = false;
	for (const char of value) {
		if (char === '"') quoted = !quoted;
		else if (char === ';' && !quoted) {
			dirs.push(current.trim());
			current = '';
		} else current += char;
	}
	dirs.push(current.trim());
	return dirs.filter(Boolean);
}

/**
 * How to launch name with args on Windows without handing the arguments to a
 * shell unquoted. A native executable runs directly with an args array. A
 * .cmd or .bat file can only run under cmd.exe (Node refuses it otherwise),
 * so it gets one command line built by cmdLine and no args array.
 * @param {string} name
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 * @param {(path: string) => boolean} isFile
 * @returns {{ file: string, args: string[], shell: boolean }}
 */
export function windowsCommand(name, args, env, isFile) {
	const file = findWindowsCommand(name, env, isFile);
	if (!file) throw new Error(`${name} was not found on PATH`);
	if (/\.(cmd|bat)$/i.test(file)) return { file: cmdLine(file, args), args: [], shell: true };
	return { file, args, shell: false };
}

/**
 * Maintainer-owned clean first-run transcript. Package-manager and Vite noise
 * is intentionally omitted; every line here is a checkpoint the ecosystem
 * itself owns and accepts as the expected newcomer handoff.
 */
export function renderFirstRunTranscript({ name = 'my-app', agent = 'npm' } = {}) {
	return [
		'Checking Node, OS, architecture, libc, and uWebSockets.js',
		'preflight OK - Node, platform/libc, and the pinned native addon are ready.',
		'Building the production app',
		'Production build verified',
		`Verified. cd ${name} && ${agent} run dev`,
		'First browser connection (expected until authentication is replaced):',
		formatScaffoldAuthWarning()
	].join('\n');
}

/**
 * Current sv projects pass SvelteKit options directly in vite.config.ts. A
 * sidecar svelte.config.js is ignored in that shape, so generate one
 * consolidated source of truth.
 */
export function renderViteConfig() {
	return `import adapter from 'svelte-adapter-uws';
import { sveltekit } from '@sveltejs/kit/vite';
import uws from 'svelte-adapter-uws/vite';
import realtime from 'svelte-realtime/vite';
import { defineConfig } from 'vite';

export default defineConfig({
\tplugins: [
\t\tsveltekit({
\t\t\tadapter: adapter({ websocket: true })
\t\t}),
\t\tuws(),
\t\trealtime()
\t]
});
`;
}

/**
 * @param {string} [ua]
 * @returns {'npm' | 'pnpm' | 'yarn' | 'bun'}
 */
export function detectAgent(ua) {
	const agent = ua ?? '';
	if (agent.startsWith('pnpm')) return 'pnpm';
	if (agent.startsWith('yarn')) return 'yarn';
	if (agent.startsWith('bun')) return 'bun';
	return 'npm';
}

/**
 * Parse and validate CLI arguments. Returns an object or an error string.
 * Parses in one pass so that flag values (e.g. --template minimal) are consumed
 * and not mistaken for positional args.
 * @param {string[]} argv - arguments (without node/script prefix)
 * @param {{ dirExists?: (name: string) => boolean, interactive?: boolean }} [opts]
 * @returns {{ help: true } | { error: string } | { name?: string, template?: string }}
 */
export function parseArgs(argv, opts) {
	const positional = [];
	let template;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		if (arg === '--help' || arg === '-h') {
			return { help: true };
		}

		if (arg === '--template') {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('-')) {
				if (next === '--help' || next === '-h') return { help: true };
				return { error: '--template requires a value: minimal, example, or demo.' };
			}
			template = argv[++i];
			if (!VALID_TEMPLATES.includes(template)) {
				return { error: `Unknown template: "${template}". Use minimal, example, or demo.` };
			}
			continue;
		}

		if (arg.startsWith('--template=')) {
			template = arg.slice('--template='.length);
			if (!template) {
				return { error: '--template requires a value: minimal, example, or demo.' };
			}
			if (!VALID_TEMPLATES.includes(template)) {
				return { error: `Unknown template: "${template}". Use minimal, example, or demo.` };
			}
			continue;
		}

		if (arg.startsWith('-')) continue;

		positional.push(arg);
	}

	const name = positional[0];
	if (name !== undefined) {
		if (!VALID_NAME_RE.test(name)) {
			return { error: `Invalid project name: "${name}". Use only letters, numbers, hyphens, and underscores.` };
		}
		if (opts?.dirExists?.(name)) {
			return { error: `Directory "${name}" already exists.` };
		}
	}

	if (opts?.interactive === false && (!name || !template)) {
		return { error: 'Non-interactive input requires a project name and --template minimal|example|demo. Example: npx svelte-realtime my-app --template example' };
	}

	return { name, template };
}
