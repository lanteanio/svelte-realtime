#!/usr/bin/env node
// @ts-check
import { execFileSync } from 'child_process';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import * as p from '@clack/prompts';
import { detectAgent, parseArgs, VALID_NAME_RE } from './cli-utils.js';

const IS_WIN = process.platform === 'win32';

/**
 * Resolve a binary name to the OS-specific form. npm / pnpm / yarn / bun / npx
 * ship as `.cmd` shims on Windows; Node's execFileSync (no shell) refuses to
 * launch them without the extension. Native binaries (git) work as-is on
 * every platform because Node resolves PATHEXT for them.
 * @param {string} name
 */
function bin(name) {
	return IS_WIN && name !== 'git' ? `${name}.cmd` : name;
}

const DEMO_REPO = 'https://github.com/lanteanio/svelte-realtime-demo.git';

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
import { message } from 'svelte-realtime/server';
export { message };

const SCAFFOLD_PLACEHOLDER = true;

export function upgrade() {
\tif (SCAFFOLD_PLACEHOLDER) {
\t\tconsole.warn(
\t\t\t'[svelte-realtime] upgrade() is the scaffold default. ' +
\t\t\t\t'Every connection gets a random UUID identity. ' +
\t\t\t\t'Edit src/hooks.ws.ts before deploying - see the SECURITY block at the top of the file.'
\t\t);
\t}
\treturn { id: crypto.randomUUID() };
}
`;

const parsed = parseArgs(process.argv.slice(2), {
	dirExists: (name) => existsSync(resolve(process.cwd(), name))
});

if ('help' in parsed) {
	console.log(`
  Usage: npx svelte-realtime [project-name] [--template minimal|example|demo]

  Scaffolds a SvelteKit project with svelte-realtime wired up and ready to go.
`);
	process.exit(0);
}

if ('error' in parsed) {
	console.error(parsed.error);
	process.exit(1);
}

p.intro('svelte-realtime');

const name =
	parsed.name ||
	/** @type {string} */ (
		await p.text({
			message: 'Project name',
			placeholder: 'my-app',
			validate(value) {
				if (!value) return 'Required.';
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

if (template === 'demo') {
	p.log.step('Cloning demo repository');
	run('git', ['clone', DEMO_REPO, name]);

	p.log.step('Installing dependencies');
	run(bin(agent), ['install'], dest);

	p.outro(`Done. cd ${name} && ${agent} run dev`);
	process.exit(0);
}

p.log.step('Creating SvelteKit project');
run(bin('npx'), ['-y', 'sv', 'create', name, '--template', 'minimal', '--types', 'ts', '--no-add-ons', '--no-install']);

p.log.step('Installing dependencies');
const add = agent === 'npm' ? 'install' : 'add';
run(bin(agent), [add, 'svelte-adapter-uws', 'svelte-realtime'], dest);
run(bin(agent), [add, 'uNetworking/uWebSockets.js#v20.60.0'], dest);
run(bin(agent), [add, '-D', 'ws'], dest);

p.log.step('Configuring svelte-realtime');

writeFileSync(
	join(dest, 'svelte.config.js'),
	`import adapter from 'svelte-adapter-uws';

/** @type {import('@sveltejs/kit').Config} */
const config = {
\tkit: {
\t\tadapter: adapter({ websocket: true })
\t}
};

export default config;
`
);

writeFileSync(
	join(dest, 'vite.config.ts'),
	`import { sveltekit } from '@sveltejs/kit/vite';
import uws from 'svelte-adapter-uws/vite';
import realtime from 'svelte-realtime/vite';
import { defineConfig } from 'vite';

export default defineConfig({
\tplugins: [sveltekit(), uws(), realtime()]
});
`
);

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
</script>

<h1>svelte-realtime</h1>

{#if $counter === undefined}
\t<p>Connecting...</p>
{:else}
\t<p>Count: {$counter}</p>
{/if}

<button onclick={() => increment()}>+1</button>
`
	);
}

p.log.success('Configured.');

p.outro(`Done. cd ${name} && ${agent} run dev`);

// ---------------------------------------------------------------------------

/**
 * Run an external binary. Args are passed as an explicit array so they reach
 * the OS exec call without shell tokenization - no template-string injection
 * possible from this entrypoint regardless of how the caller assembles args.
 *
 * On Windows, package-manager shims (npm.cmd / pnpm.cmd / yarn.cmd / bun.cmd
 * / npx.cmd) must run under a shell because Node >=22 EINVALs `.cmd` files
 * under `shell: false`. The `shell: IS_WIN` toggle is scoped per-call to that
 * platform-specific need; on Linux / Mac the no-shell path is the default.
 * Even on Windows, the shell:true escaping caveat (DEP0190) is bounded here
 * because every arg fed to run() in this file is either a hardcoded literal,
 * the cli-utils VALID_NAME_RE-validated project name, or the hardcoded demo
 * repo URL - none of which carry shell metacharacters. Adding an arg from an
 * unvalidated source reintroduces the shell-injection class this refactor
 * was designed to remove; new args must keep that invariant.
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
	try {
		execFileSync(file, args, {
			cwd,
			stdio: 'inherit',
			env,
			shell: IS_WIN
		});
	} catch (e) {
		const line = `${file} ${args.join(' ')}`;
		p.cancel(`Command failed: ${line}\n${/** @type {any} */ (e).stderr || /** @type {any} */ (e).message}`);
		process.exit(1);
	}
}
