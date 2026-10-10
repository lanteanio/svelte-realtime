#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { resolveNpmCli } from './npm-cli.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = resolveNpmCli();
const freshInstall = process.argv.includes('--fresh-install');
const workspace = mkdtempSync(join(root, '.manual-setup-'));
const app = join(workspace, 'app');
const artifacts = join(workspace, 'artifacts');
const installedModules = realpathSync(join(root, 'node_modules'));
let child, browser;
let output = '';

function run(args, cwd = app) {
	const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 180000, env: { ...process.env, NODE_ENV: 'development', npm_config_cache: join(workspace, 'pack-cache') } });
	if (result.error) throw result.error;
	assert.equal(result.status, 0, result.stdout + result.stderr);
	return result.stdout;
}
function pack(directory) {
	const result = JSON.parse(run([npm, 'pack', directory, '--ignore-scripts', '--json', '--pack-destination', artifacts], workspace));
	return join(artifacts, result[0].filename);
}
function installPacked(file, name) {
	const target = join(app, 'node_modules', name);
	mkdirSync(target, { recursive: true });
	const extracted = spawnSync('tar', ['-xzf', relative(workspace, file).replaceAll('\\', '/'), '-C', relative(workspace, target).replaceAll('\\', '/'), '--strip-components=1'], { cwd: workspace, encoding: 'utf8', timeout: 30000 });
	assert.equal(extracted.status, 0, extracted.stderr);
}
async function port() {
	const server = createServer();
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const value = server.address().port;
	await new Promise(resolve => server.close(resolve));
	return value;
}
async function stop() {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const stopped = once(child, 'exit');
	if (process.platform === 'win32') {
		const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
		if (killed.status !== 0 && child.exitCode === null) throw new Error('Could not stop manual app: ' + killed.stderr);
	}
	else process.kill(-child.pid, 'SIGTERM');
	await stopped;
	child = null;
}
async function start(args, listenPort) {
	output = '';
	child = spawn(process.execPath, args, {
		cwd: app, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
		detached: process.platform !== 'win32',
		env: { ...process.env, HOST: '127.0.0.1', PORT: String(listenPort), npm_config_cache: join(workspace, 'pack-cache'), NODE_ENV: args[0] === 'build/index.js' ? 'production' : 'development' }
	});
	child.stdout.on('data', chunk => { output += chunk; });
	child.stderr.on('data', chunk => { output += chunk; });
	const origin = `http://127.0.0.1:${listenPort}`;
	for (let attempt = 0; attempt < 120; attempt++) {
		if (child.exitCode !== null) throw new Error(output);
		try { if ((await fetch(origin)).ok) return origin; } catch {}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error('Manual app did not start: ' + output);
}
async function twoTabs(origin) {
	const context = await browser.newContext();
	try {
		const first = await context.newPage(), second = await context.newPage();
		const errors = [];
		for (const page of [first, second]) {
			page.on('pageerror', error => errors.push(error.message));
			page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
		}
		await Promise.all([first.goto(origin), second.goto(origin)]);
		const hasCount = (page, count) => page.waitForFunction(value => document.querySelector('[role="status"]')?.textContent.trim() === `Count: ${value}`, count);
		await Promise.all([hasCount(first, 0), hasCount(second, 0)]);
		await first.getByRole('button', { name: 'Increase count by one' }).click();
		await Promise.all([hasCount(first, 1), hasCount(second, 1)]);
		await second.reload();
		await hasCount(second, 1);
		await second.getByRole('button', { name: 'Increase count by one' }).click();
		await Promise.all([hasCount(first, 2), hasCount(second, 2)]);
		assert.deepEqual(errors, []);
	} catch (error) {
		for (const page of context.pages()) console.error(await page.locator('body').innerText());
		throw error;
	} finally { await context.close(); }
}

try {
	mkdirSync(app);
	mkdirSync(artifacts);
	const readme = readFileSync(join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
	const manual = readme.split('## Manual setup\n')[1]?.split('\n## How it works')[0];
	assert.ok(manual, 'README manual setup section exists');
	const files = new Map();
	for (const match of manual.matchAll(/```(?:js|ts|svelte)\r?\n(?:\/\/ |<!-- )([^\r\n]+?)(?: -->)?\r?\n([\s\S]*?)```/g)) files.set(match[1], match[2]);
	for (const name of ['vite.config.ts', 'src/hooks.ws.js', 'src/live/counter.js', 'src/routes/+page.svelte']) {
		assert.ok(files.has(name), 'literal README file: ' + name);
		mkdirSync(dirname(join(app, name)), { recursive: true });
		writeFileSync(join(app, name), files.get(name));
	}
	writeFileSync(join(app, 'src/app.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">%sveltekit.head%</head><body><div style="display:contents">%sveltekit.body%</div></body></html>');
	const dependencies = {};
	const ws = [join(installedModules, 'ws'), join(root, 'test/fixture/node_modules/ws'), join(dirname(installedModules), 'test/fixture/node_modules/ws')].find(path => existsSync(join(path, 'package.json')));
	assert.ok(ws, 'Install the fixture dependencies with npm ci --prefix test/fixture first');
	for (const name of ['svelte', '@sveltejs/kit', '@sveltejs/vite-plugin-svelte', 'vite']) dependencies[name] = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
	dependencies.ws = JSON.parse(readFileSync(join(ws, 'package.json'), 'utf8')).version;
	console.log('manual setup: packing local candidates');
	dependencies['svelte-realtime'] = 'file:' + pack(root);
	dependencies['svelte-adapter-uws'] = 'file:' + pack(join(root, 'node_modules/svelte-adapter-uws'));
	dependencies['uWebSockets.js'] = 'file:' + pack(join(root, 'node_modules/uWebSockets.js'));
	writeFileSync(join(app, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { dev: 'vite dev', build: 'vite build' }, dependencies }, null, 2));
	if (freshInstall) {
		// A new app and a new npm cache exercise installation without a warm
		// consumer tree. Candidate packages come from the exact local artifacts.
		run([npm, 'install', '--cache', join(workspace, 'npm-cache'), '--no-audit', '--no-fund']);
	} else {
		mkdirSync(join(app, 'node_modules'));
		for (const entry of readdirSync(join(root, 'node_modules'))) {
			if (entry.startsWith('.') || ['svelte-realtime', 'svelte-adapter-uws', 'uWebSockets.js'].includes(entry)) continue;
			symlinkSync(join(root, 'node_modules', entry), join(app, 'node_modules', entry), 'junction');
		}
		for (const name of ['svelte-realtime', 'svelte-adapter-uws', 'uWebSockets.js']) installPacked(dependencies[name].slice(5), name);
		if (!existsSync(join(app, 'node_modules/ws'))) symlinkSync(ws, join(app, 'node_modules/ws'), 'junction');
		mkdirSync(join(app, 'node_modules/.bin'));
		const viteEntry = join(app, 'node_modules/vite/bin/vite.js');
		if (process.platform === 'win32') writeFileSync(join(app, 'node_modules/.bin/vite.cmd'), `@"${process.execPath}" "${viteEntry}" %*\r\n`);
		else symlinkSync(viteEntry, join(app, 'node_modules/.bin/vite'));
	}
	const adapter = JSON.parse(readFileSync(join(app, 'node_modules/svelte-adapter-uws/package.json'), 'utf8'));
	const preflight = run([join(app, 'node_modules/svelte-adapter-uws', adapter.bin['svelte-adapter-uws-preflight'])]);
	assert.match(preflight, /preflight OK/);
	browser = await chromium.launch({ headless: true });
	const devPort = await port();
	console.log('manual setup: checking dev server');
	await twoTabs(await start([npm, 'run', 'dev', '--', '--host', '127.0.0.1', '--port', String(devPort), '--strictPort'], devPort));
	await stop();
	console.log('manual setup: building production app');
	run([npm, 'run', 'build']);
	assert.ok(existsSync(join(app, 'build/index.js')));
	const productionPort = await port();
	await twoTabs(await start(['build/index.js'], productionPort));
	await stop();
	await twoTabs(await start(['build/index.js'], productionPort));
	console.log(`manual setup: literal README files, native preflight, two tabs, reload, production build and restart pass on Node ${process.versions.node} (${freshInstall ? 'fresh install/cache' : 'packed local packages'})`);
} catch (error) {
	console.error(error.stack || error);
	if (output) console.error(output);
	process.exitCode = 1;
} finally {
	await browser?.close();
	await stop();
	if (dirname(workspace) !== root || !workspace.startsWith(join(root, '.manual-setup-'))) throw new Error('Unexpected manual setup workspace');
	rmSync(workspace, { recursive: true, force: true });
}
