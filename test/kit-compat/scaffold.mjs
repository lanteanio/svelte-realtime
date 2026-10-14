import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const adapterPack = option('--adapter-pack');
const realtimePack = option('--realtime-pack');
assert(adapterPack && realtimePack, 'Pass --adapter-pack and --realtime-pack with local npm pack archives');
const packages = new Map();
for (const path of [adapterPack, realtimePack]) {
 const bytes = readFileSync(resolve(path));
 const manifest = JSON.parse(execFileSync('tar', ['-xOf', resolve(path), 'package/package.json'], { encoding: 'utf8', windowsHide: true }));
 packages.set(manifest.name, { manifest, bytes, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), shasum: createHash('sha1').update(bytes).digest('hex') });
}
assert.equal(packages.get('svelte-adapter-uws')?.manifest.version, '0.5.11');
assert.equal(packages.get('svelte-realtime')?.manifest.version, '0.5.14');
const directory = resolve(root, 'test-results', 'scaffold-' + Date.now());
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'scaffold-smoke', private: true }));
const npmrc = join(directory, 'npmrc');
writeFileSync(npmrc, '');
const npm = process.env.npm_execpath || resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const results = [];
let registryUrl;
const registry = createServer((req, res) => {
 const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1);
 const packageEntry = packages.get(path);
 if (packageEntry) {
  const { manifest, integrity, shasum } = packageEntry;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: { ...manifest, dist: { tarball: registryUrl + '/' + manifest.name + '/-/' + manifest.name + '-' + manifest.version + '.tgz', integrity, shasum } } } }));
  return;
 }
 for (const { manifest, bytes } of packages.values()) {
  if (path === manifest.name + '/-/' + manifest.name + '-' + manifest.version + '.tgz') {
   res.setHeader('content-type', 'application/octet-stream');
   res.end(bytes);
   return;
  }
 }
 if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
 res.writeHead(307, { location: 'https://registry.npmjs.org/' + path + new URL(req.url, 'http://localhost').search });
 res.end();
});
await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve));
registryUrl = 'http://127.0.0.1:' + registry.address().port;
const env = { ...process.env, npm_config_registry: registryUrl, npm_config_userconfig: npmrc, npm_config_audit: 'false', npm_config_fund: 'false' };
delete env.NODE_AUTH_TOKEN;
delete env.NPM_TOKEN;
delete env.NODE_ENV;
for (const key of Object.keys(env)) {
 if (/^npm_config_(force|legacy_peer_deps|strict_peer_deps|package|call|cache)$/i.test(key)) delete env[key];
}
Object.assign(env, { npm_config_cache: join(directory, 'npm-cache'), npm_config_force: 'false', npm_config_legacy_peer_deps: 'false', npm_config_strict_peer_deps: 'true' });
function start(args, cwd, extraEnv = {}) {
 const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extraEnv }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
 let output = '';
 child.stdout.on('data', data => { output += data; });
 child.stderr.on('data', data => { output += data; });
 child.output = () => output;
 child.completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
 return child;
}
async function stop(child) {
 if (child.exitCode !== null) return;
 if (process.platform === 'win32') {
  const kill = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  await new Promise(resolve => kill.once('exit', resolve));
 } else child.kill('SIGTERM');
 await child.completion;
}
async function command(name, args, cwd) {
 const child = start(args, cwd);
 const timer = setTimeout(() => { void stop(child); }, 180000);
 try {
  const code = await child.completion;
  writeFileSync(join(directory, name + '.log'), child.output());
  assert.equal(code, 0, name + ' failed:\n' + child.output());
  assert(!/transformIndexHtml.*not supported|transform_index_html_unsupported/.test(child.output()), 'Unsupported Vite hook warning');
  results.push({ name, passed: true });
 } finally { clearTimeout(timer); await stop(child); }
}
async function freePort() {
 const server = createServer();
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const port = server.address().port;
 await new Promise(resolve => server.close(resolve));
 return port;
}
async function waitFor(fn, timeout = 30000) {
 const end = Date.now() + timeout;
 let last;
 while (Date.now() < end) {
  try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
  await new Promise(resolve => setTimeout(resolve, 100));
 }
 throw last || new Error('Timed out');
}
async function browserSmoke(app, dev) {
 const mode = dev ? 'dev' : 'production';
 const port = await freePort();
 const url = 'http://127.0.0.1:' + port;
 const args = dev ? [join(app, 'node_modules/vite/bin/vite.js'), 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'] : [join(app, 'build/index.js')];
 const child = start(args, app, { PORT: String(port), HOST: '127.0.0.1', ORIGIN: url });
 let browser;
 try {
  await waitFor(async () => {
   assert.equal(child.exitCode, null, child.output());
   return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
  }, 60000);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const pages = [await context.newPage(), await context.newPage()];
  const errors = [];
  const frames = [];
  for (const page of pages) {
   page.on('pageerror', error => errors.push(error.message));
   page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/ws') return;
    socket.on('framesent', event => frames.push({ direction: 'sent', payload: String(event.payload) }));
    socket.on('framereceived', event => frames.push({ direction: 'received', payload: String(event.payload) }));
   });
   await page.goto(url);
   await page.getByText('Count: 0', { exact: true }).waitFor();
  }
  await pages[0].getByRole('button', { name: '+1', exact: true }).click();
  for (const page of pages) await page.getByText('Count: 1', { exact: true }).waitFor();
  await pages[1].getByRole('button', { name: '+1', exact: true }).click();
  for (const page of pages) await page.getByText('Count: 2', { exact: true }).waitFor();
  assert(frames.some(frame => frame.direction === 'sent' && frame.payload.includes('increment')), 'No real counter RPC WebSocket frame');
  assert(frames.some(frame => frame.direction === 'received'), 'No real WebSocket delivery');
  if (dev) {
   await pages[0].waitForFunction(() => Boolean(window.__svelte_realtime_devtools));
   await pages[0].locator('#svelte-realtime-devtools').waitFor({ state: 'attached' });
   await pages[0].keyboard.press('Control+Shift+L');
   await pages[0].locator('#svelte-realtime-devtools').waitFor({ state: 'visible' });
  }
  assert.deepEqual(errors, [], 'Browser errors');
  assert(!/transformIndexHtml.*not supported|transform_index_html_unsupported/.test(child.output()), 'Unsupported Vite hook warning');
  results.push({ name: mode + ' counter RPC and live stores', passed: true, frames: frames.length });
 } finally {
  if (browser) await browser.close();
  await stop(child);
  writeFileSync(join(directory, mode + '.log'), child.output());
 }
}
try {
 const invoke = process.argv.includes('--explicit-package')
  ? [npm, 'exec', '--yes', '--package=' + resolve(realtimePack), '--', 'svelte-realtime']
  : [npm, 'exec', '--yes', '--', 'svelte-realtime@0.5.14'];
 await command('scaffold', [...invoke, 'app', '--template', 'example'], directory);
 const app = join(directory, 'app');
 const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
 assert(manifest.devDependencies['@sveltejs/kit'].startsWith('^3.'), 'Scaffold did not target Kit 3');
 for (const [name, version] of [['svelte-realtime', '0.5.14'], ['svelte-adapter-uws', '0.5.11']]) {
  assert.equal(JSON.parse(readFileSync(join(app, 'node_modules', name, 'package.json'), 'utf8')).version, version);
 }
 await command('build', [npm, 'run', 'build'], app);
 await browserSmoke(app, false);
 await browserSmoke(app, true);
 console.log(JSON.stringify({ passed: true, directory, results }, null, 2));
} catch (error) {
 results.push({ name: 'failure', passed: false, error: error.stack });
 throw error;
} finally {
 writeFileSync(join(directory, 'result.json'), JSON.stringify({ results }, null, 2) + '\n');
 await new Promise(resolve => registry.close(resolve));
}
