#!/usr/bin/env node
// @ts-check
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from 'fs';
import { resolve, join } from 'path';
// Reject Node versions the generated SvelteKit 3 project cannot run on before
// loading dependencies or starting work: 22.17+ on the 22 line, or 24+.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (!(nodeMajor >= 24 || (nodeMajor === 22 && nodeMinor >= 17))) {
	console.error('[svelte-realtime] Scaffolding requires Node 22.17+ on 22.x, or Node 24+; found ' + process.versions.node + '. Upgrade Node before creating a project.');
	process.exit(1);
}

const p = await import('@clack/prompts');
const {
	detectAgent,
	parseArgs,
	renderScaffoldAuthWarningStatement,
	renderViteConfig,
	runScaffoldVerification,
	SCAFFOLD_ADAPTER_SPEC,
	SCAFFOLD_REALTIME_SPEC,
	SCAFFOLD_SV_SPEC,
	SCAFFOLD_UWS_SPEC,
	VALID_NAME_RE,
	windowsCommand,
	withoutAdapterAuto
} = await import('./cli-utils.js');

const IS_WIN = process.platform === 'win32';

const DEMO_REPO = 'https://github.com/lanteanio/svelte-realtime-demo.git';
const DEFAULT_PROJECT_NAME = 'my-app';

// The scaffolded upgrade() hook is intentionally permissive so the first
// `npm run dev` works without any identity wiring: every connection gets a
// fresh UUID and accepts. The hook also fires a console.warn on every
// accepted connection until the developer deletes the SCAFFOLD_PLACEHOLDER
// line. Deletion is the explicit "I have replaced this with real auth, stop
// nagging me" action. Without that, the warning floods stderr/log
// aggregators - unmissable in dev, impossible to ignore in prod.
const UPGRADE_HOOK_SCAFFOLD = `// SECURITY: this scaffolded upgrade() hook accepts every WebSocket
// connection and gives it a random UUID identity. It exists so the
// scaffold works out of the box. Before deploying anything that
// touches a real session store, real users, or anything else worth
// protecting, replace this hook with one of:
//
//   1. Cookie session - parse req.getHeader('cookie'), look up the
//      session id in your store, return { id: session.userId } or
//      false if missing/expired.
//
//   2. Bearer token - parse req.getHeader('authorization'), validate
//      the JWT or opaque token, return { id: claims.sub } or false.
//
//   3. Signed query token - parse the upgrade URL's query string,
//      verify a server-issued HMAC, return { id: claims.userId } or
//      false. Useful when the client cannot send custom headers.
//
// Returning false from upgrade() rejects the connection. The object
// you return becomes ctx.user on every message and live() call.
//
// Delete the SCAFFOLD_PLACEHOLDER line below to silence the runtime
// warning once your auth is in place.
export { message, close, unsubscribe } from 'svelte-realtime/server';

const SCAFFOLD_PLACEHOLDER = true;

export function upgrade() {
\tif (SCAFFOLD_PLACEHOLDER) {
\t\t${renderScaffoldAuthWarningStatement()}
\t}
\treturn { id: crypto.randomUUID() };
}
`;

const parsed = parseArgs(process.argv.slice(2), {
	dirExists: (name) => existsSync(resolve(process.cwd(), name)),
	interactive: process.stdin.isTTY === true
});

if ('help' in parsed) {
	console.log(`
  Usage: npx svelte-realtime [project-name] [--template minimal|example|demo]

  Scaffolds a SvelteKit project with svelte-realtime wired up and ready to go.
`);
	process.exit(0);
}

if ('error' in parsed) {
	console.error('[svelte-realtime]', parsed.error);
	process.exit(1);
}

p.intro('svelte-realtime');

const name =
	parsed.name ||
	/** @type {string} */ (
		await p.text({
			message: 'Project name',
			placeholder: DEFAULT_PROJECT_NAME,
			defaultValue: DEFAULT_PROJECT_NAME,
			validate(value) {
				value = value || DEFAULT_PROJECT_NAME;
				if (!VALID_NAME_RE.test(value))
					return 'Use only letters, numbers, hyphens, and underscores.';
				if (existsSync(resolve(process.cwd(), value))) return `Directory "${value}" already exists.`;
			}
		})
	);

if (p.isCancel(name)) {
	p.cancel('Cancelled.');
	process.exit(0);
}

const dest = resolve(process.cwd(), name);

const template =
	parsed.template ||
	/** @type {string} */ (
		await p.select({
			message: 'Which template would you like?',
			options: [
				{
					value: 'minimal',
					label: 'Wiring only',
					hint: 'SvelteKit + svelte-realtime, no example code'
				},
				{
					value: 'example',
					label: 'Barebones example',
					hint: 'SvelteKit + svelte-realtime with a working counter'
				},
				{
					value: 'demo',
					label: 'Full demo app',
					hint: 'clone svelte-realtime-demo'
				}
			]
		})
	);

if (p.isCancel(template)) {
	p.cancel('Cancelled.');
	process.exit(0);
}

const agent = detectAgent(process.env.npm_config_user_agent);
const add = agent === 'npm' ? 'install' : 'add';

if (template === 'demo') {
	p.log.step('Cloning demo repository');
	run('git', ['clone', DEMO_REPO, name]);

	p.log.step('Installing the audited dependency tuple');
	run(agent, [add, SCAFFOLD_ADAPTER_SPEC, SCAFFOLD_REALTIME_SPEC], dest);
	run(agent, [add, SCAFFOLD_UWS_SPEC], dest);
}

if (template !== 'demo') {
	p.log.step('Creating SvelteKit project');
	run('npx', ['-y', SCAFFOLD_SV_SPEC, 'create', name, '--template', 'minimal', '--types', 'ts', '--no-add-ons', '--no-install']);
	// The generated configuration below uses the native adapter exclusively.
	const manifestPath = join(dest, 'package.json');
	writeFileSync(manifestPath, JSON.stringify(withoutAdapterAuto(JSON.parse(readFileSync(manifestPath, 'utf8'))), null, 2) + '\n');

	p.log.step('Installing dependencies');
	run(agent, [add, SCAFFOLD_ADAPTER_SPEC, SCAFFOLD_REALTIME_SPEC], dest);
	run(agent, [add, SCAFFOLD_UWS_SPEC], dest);
	run(agent, [add, '-D', 'ws'], dest);

	p.log.step('Configuring svelte-realtime');

	// sv currently writes the SvelteKit options directly into vite.config.ts.
	// Keeping a second sidecar makes the adapter setting look configured while
	// SvelteKit ignores it, so remove any generated sidecar before writing the
	// consolidated configuration.
	rmSync(join(dest, 'svelte.config.js'), { force: true });
	writeFileSync(join(dest, 'vite.config.ts'), renderViteConfig());

	writeFileSync(join(dest, 'src', 'hooks.ws.ts'), UPGRADE_HOOK_SCAFFOLD);

	if (template === 'example') {
		mkdirSync(join(dest, 'src', 'live'), { recursive: true });

		writeFileSync(
			join(dest, 'src', 'live', 'counter.ts'),
			`import { live } from 'svelte-realtime/server';

let count = 0;

export const increment = live((ctx) => {
\tcount++;
\tctx.publish('count', 'set', count);
\treturn count;
});

export const counter = live.stream('count', () => {
\treturn count;
}, { merge: 'set' });
`
		);

		writeFileSync(
			join(dest, 'src', 'routes', '+page.svelte'),
			`<script lang="ts">
\timport { increment, counter } from '$live/counter';

\tconst counterStatus = counter.status;
\tconst counterError = counter.error;
\tlet incrementing = $state(false);
\tlet mutationError = $state('');

\tasync function increaseCount() {
\t\tif (incrementing || $counterStatus !== 'connected') return;
\t\tincrementing = true;
\t\tmutationError = '';
\t\ttry {
\t\t\tawait increment();
\t\t} catch (error) {
\t\t\tmutationError = error instanceof Error && error.message ? error.message : 'Please try again.';
\t\t} finally {
\t\t\tincrementing = false;
\t\t}
\t}
</script>

<h1>svelte-realtime</h1>

<p role="status" aria-live="polite" aria-atomic="true">
\t{#if $counterError || $counterStatus === 'error'}
\t\tCounter unavailable: {$counterError?.message ?? 'Connection failed.'}
\t{:else if $counterStatus === 'reconnecting'}
\t\tReconnecting... {#if $counter !== undefined}Last count: {$counter}.{/if}
\t{:else if $counter === undefined || $counterStatus === 'loading'}
\t\tConnecting...
\t{:else}
\t\tCount: {$counter}{#if incrementing}. Updating...{/if}
\t\t{#if mutationError} Could not increase count: {mutationError} Try Increase count by one again.{/if}
\t{/if}
</p>

<button onclick={increaseCount} disabled={$counterStatus !== 'connected'} aria-disabled={incrementing || $counterStatus !== 'connected'}>
\tIncrease count by one
</button>
{#if $counterError || $counterStatus === 'error'}
\t<button onclick={() => window.location.reload()}>Retry connection</button>
{/if}
`
		);
	}
}

runScaffoldVerification({
	agent,
	dest,
	run,
	onStep: (message) => p.log.step(message),
	onSuccess: (message) => p.log.success(message)
});

p.outro(`Verified. cd ${name} && ${agent} run dev`);

// ---------------------------------------------------------------------------

/**
 * Run an external binary. On Linux / Mac args are passed as an explicit array
 * straight to the OS exec call, with no shell to tokenize them.
 *
 * On Windows, windowsCommand resolves the bare name through PATH and PATHEXT,
 * because a package manager may be a .cmd shim (npm.cmd, corepack's pnpm.cmd)
 * or a native executable (bun.exe, standalone pnpm.exe). An executable runs
 * with an args array and no shell. A .cmd or .bat file must run under cmd.exe
 * because Node >=22 EINVALs it under `shell: false`; Node would only
 * concatenate separate args for the shell (DEP0190), so it gets one command
 * line built by cmdLine, which quotes what cmd.exe would rewrite and refuses
 * what quoting cannot protect. Every arg fed to run() in this file is a
 * hardcoded literal, the cli-utils VALID_NAME_RE-validated project name, or
 * the hardcoded demo repo URL; new args must keep that invariant.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {string} [cwd]
 */
function run(file, args, cwd) {
	// Strip NODE_ENV so the scaffold runs npm/pnpm install as if from a clean
	// shell - if the user invoked `npx svelte-realtime` inside an env where
	// NODE_ENV=production was set, the package manager would skip devDeps and
	// the resulting project would be broken. Use `delete` rather than spread +
	// undefined: both have the same effect on Node 22+ (Node drops undefined
	// env entries) but `delete` is the unambiguous form that does not depend
	// on Node-internal handling of undefined env values.
	const env = { ...process.env };
	delete env.NODE_ENV;
	// npm exec exports its selected package to children. A nested npx must
	// select sv itself instead of trying to execute the package spec as a binary.
	for (const key of Object.keys(env)) {
		if (/^npm_config_(package|call)$/i.test(key)) delete env[key];
	}
	try {
		if (IS_WIN) {
			const command = windowsCommand(file, args, env, isFile);
			execFileSync(command.file, command.args, { cwd, stdio: 'inherit', env, shell: command.shell });
		} else {
			execFileSync(file, args, { cwd, stdio: 'inherit', env });
		}
	} catch (e) {
		const line = `${file} ${args.join(' ')}`;
		p.cancel(`Command failed: ${line}\n${/** @type {any} */ (e).stderr || /** @type {any} */ (e).message}`);
		process.exit(1);
	}
}

/**
 * Whether path names a file. A PATH entry that is unreadable or not a
 * directory is skipped rather than ending the search.
 * @param {string} path
 */
function isFile(path) {
	try {
		return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
	} catch {
		return false;
	}
}
