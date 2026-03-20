#!/usr/bin/env node
// @ts-check
import { execSync } from 'child_process';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import * as p from '@clack/prompts';
import { detectAgent, parseArgs } from './cli-utils.js';

const DEMO_REPO = 'https://github.com/lanteanio/svelte-realtime-demo.git';

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
				if (!/^[a-zA-Z0-9_-]+$/.test(value))
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
	const s = p.spinner();
	s.start('Cloning demo repository');
	run(`git clone ${DEMO_REPO} "${name}"`);
	s.stop('Cloned.');

	s.start('Installing dependencies');
	run(`${agent} install`, dest);
	s.stop('Installed.');

	p.outro(`Done. cd ${name} && ${agent} run dev`);
	process.exit(0);
}

const s = p.spinner();

s.start('Creating SvelteKit project');
run(`npx -y sv create "${name}" --template minimal --types ts`);
s.stop('Project created.');

s.start('Installing dependencies');
const add = agent === 'npm' ? 'install' : 'add';
run(`${agent} ${add} svelte-adapter-uws svelte-realtime`, dest);
run(`${agent} ${add} uNetworking/uWebSockets.js#v20.60.0`, dest);
run(`${agent} ${add} -D ws`, dest);
s.stop('Dependencies installed.');

s.start('Configuring svelte-realtime');

writeFileSync(
	join(dest, 'svelte.config.js'),
	`import adapter from 'svelte-adapter-uws';
import { vitePreprocess } from '@sveltejs/kit/vite';

export default {
\tkit: {
\t\tadapter: adapter({ websocket: true })
\t},
\tpreprocess: [vitePreprocess()]
};
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

writeFileSync(
	join(dest, 'src', 'hooks.ws.ts'),
	`import { message } from 'svelte-realtime/server';
export { message };

export function upgrade() {
\treturn { id: crypto.randomUUID() };
}
`
);

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

s.stop('Configured.');

p.outro(`Done. cd ${name} && ${agent} run dev`);

// ---------------------------------------------------------------------------

function run(cmd, cwd) {
	try {
		execSync(cmd, { cwd, stdio: 'pipe' });
	} catch (e) {
		p.cancel(`Command failed: ${cmd}\n${e.stderr || e.message}`);
		process.exit(1);
	}
}
