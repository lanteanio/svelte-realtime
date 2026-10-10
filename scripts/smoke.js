#!/usr/bin/env node
// Install the fixture and exercise two real clients in dev and production.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this checkpoint with npm run smoke.');
function run(args) {
	const result = spawnSync(process.execPath, [npm, ...args], { cwd: root, stdio: 'inherit', env: process.env });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`smoke: Node ${process.version}, ${process.platform}/${process.arch}`);
run(['--version']);
run(['ci', '--prefix', 'test/fixture']);
for (const name of ['svelte-realtime', 'svelte-adapter-uws', 'svelte-adapter-uws-extensions', '@sveltejs/kit', 'svelte']) {
	const file = name === 'svelte-realtime' ? 'package.json' : `test/fixture/node_modules/${name}/package.json`;
	console.log(`smoke: ${name}@${JSON.parse(readFileSync(resolve(root, file), 'utf8')).version}`);
}
run(['exec', '--', 'playwright', 'install', 'chromium']);
run(['exec', '--', 'playwright', 'test', '--config', 'test/e2e/smoke.config.js']);
console.log('smoke: two independent browser clients exchanged live data in dev and built production');
