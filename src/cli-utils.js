// @ts-check

export const VALID_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const VALID_TEMPLATES = ['minimal', 'example', 'demo'];

// One audited onboarding tuple. Keep these exact so a scaffold cannot silently
// combine independent "latest" releases whose native ABI or peer contract has
// not been verified together.
export const SCAFFOLD_ADAPTER_SPEC = 'svelte-adapter-uws@0.6.0-next.94';
export const SCAFFOLD_REALTIME_SPEC = 'svelte-realtime@0.6.0-next.91';
export const SCAFFOLD_EXTENSIONS_SPEC = 'svelte-adapter-uws-extensions@0.6.0-next.64';
export const SCAFFOLD_UWS_SPEC =
	'https://github.com/uNetworking/uWebSockets.js/archive/refs/tags/v20.69.0.tar.gz';

// Owned once and embedded into the generated hooks file. Documentation and
// transcript generation consume these fields instead of maintaining a second
// prose approximation that can contradict the runtime warning.
export const SCAFFOLD_AUTH_WARNING = Object.freeze({
	code: 'SR-ONBOARD-001',
	title: 'Scaffold authentication is still permissive',
	body:
		'Every connection receives a random UUID. Replace upgrade() in src/hooks.ws.ts and delete SCAFFOLD_PLACEHOLDER before deployment.'
});

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
 *   bin: (name: string) => string,
 *   run: (file: string, args: string[], cwd?: string) => void,
 *   onStep?: (message: string) => void,
 *   onSuccess?: (message: string) => void
 * }} input
 */
export function runScaffoldVerification({
	agent,
	dest,
	bin,
	run,
	onStep = () => {},
	onSuccess = () => {}
}) {
	onStep('Checking Node, OS, architecture, libc, and uWebSockets.js');
	run(bin(agent), packageExecArgs(agent, 'svelte-adapter-uws-preflight'), dest);
	onStep('Building the production app');
	run(bin(agent), ['run', 'build'], dest);
	onSuccess('Production build verified');
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
 * @param {{ dirExists?: (name: string) => boolean }} [opts]
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

	return { name, template };
}
