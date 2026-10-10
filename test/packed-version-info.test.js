import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
let temp, consumer, installed;
beforeAll(() => {
	temp = mkdtempSync(join(tmpdir(), 'realtime-version-'));
	const npm = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
	const packed = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--json', '--pack-destination', temp], { cwd: root, encoding: 'utf8', timeout: 120000 }));
	consumer = join(temp, 'consumer');
	installed = join(consumer, 'node_modules/svelte-realtime');
	mkdirSync(installed, { recursive: true });
	execFileSync('tar', ['-xzf', join(temp, packed[0].filename), '-C', installed, '--strip-components=1'], { timeout: 120000 });
	writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
	for (const entry of readdirSync(join(root, 'node_modules'))) {
		if (entry.startsWith('.') || entry === 'svelte-realtime') continue;
		const source = join(root, 'node_modules', entry), target = join(consumer, 'node_modules', entry);
		// The adapter's import.meta resolver must run inside this consumer, not
		// through a junction back into the development checkout.
		if (entry === 'svelte-adapter-uws') cpSync(source, target, { recursive: true });
		else symlinkSync(source, target, 'junction');
	}
}, 180000);
afterAll(() => { if (temp) rmSync(temp, { recursive: true, force: true }); });
function run(name, source) {
	const file = join(consumer, name + '.mjs');
	writeFileSync(file, source);
	return execFileSync(process.execPath, [file], { cwd: consumer, encoding: 'utf8', timeout: 60000 });
}

it('resolves packed package identity and carries the actual adapter version tuple through init and introspect', () => {
	const output = run('versions', `
import assert from 'node:assert/strict';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestServer } from 'svelte-adapter-uws/testing';
import { realtime, introspect } from 'svelte-realtime/server';
import { readRuntimeVersionInfo, formatVersionBanner } from './node_modules/svelte-adapter-uws/src/runtime/version-info.js';
const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const own = json('./node_modules/svelte-realtime/package.json');
const adapter = json('./node_modules/svelte-adapter-uws/package.json');
const extensions = json('./node_modules/svelte-adapter-uws-extensions/package.json');
const entry = fileURLToPath(import.meta.resolve('svelte-realtime'));
const location = relative(fileURLToPath(new URL('./node_modules/svelte-realtime/', import.meta.url)), entry);
assert.ok(location && !location.startsWith('..') && !isAbsolute(location), 'entry resolves inside the installed tarball');
let directory = dirname(entry), found;
for (let depth = 0; depth < 12; depth++) {
  const candidate = join(directory, 'package.json');
  if (existsSync(candidate)) {
    const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
    if (pkg.name === 'svelte-realtime' && typeof pkg.version === 'string') { found = pkg.version; break; }
  }
  const parent = dirname(directory); if (parent === directory) break; directory = parent;
}
assert.equal(found, own.version);
const tuple = readRuntimeVersionInfo();
assert.equal(tuple.adapter, adapter.version);
assert.equal(tuple.realtime, own.version);
assert.equal(tuple.extensions, extensions.version);
assert.ok(Number.isInteger(tuple.protocolRevision) && tuple.protocolRevision > 0);
assert.ok(!formatVersionBanner(tuple).includes('not installed'));
const server = await createTestServer({ handler: realtime() });
try {
  const transport = introspect().transport;
  assert.deepEqual(transport.versions, tuple);
  assert.deepEqual(transport.versions, server.platform.introspect().versions);
  assert.equal(transport.connections, 0);
} finally { await server.close(); }
console.log('packed version tuple verified');
`);
	expect(output).toContain('packed version tuple verified');
}, 90000);

it('retains bare realtime imports in actual SSR output even when the app requests dependency bundling', () => {
	mkdirSync(join(consumer, 'src/live'), { recursive: true });
	writeFileSync(join(consumer, 'src/live/echo.js'), "import { live } from 'svelte-realtime/server'; export const echo = live.public(async () => 'ready');");
	writeFileSync(join(consumer, 'src/hooks.ws.js'), "export { message } from 'svelte-realtime/server';");
	writeFileSync(join(consumer, 'entry.js'), "export { introspect } from 'svelte-realtime/server';");
	const output = run('ssr-build', `
import assert from 'node:assert/strict';
import { build } from 'vite';
import svelteRealtime from 'svelte-realtime/vite';
const result = await build({
  root: import.meta.dirname, configFile: false, logLevel: 'error',
  plugins: [svelteRealtime({ devtools: false, typedImports: false })],
  ssr: { noExternal: ['svelte-realtime'] },
  build: { ssr: true, write: false, rollupOptions: { input: { index: './entry.js' } } }
});
const chunks = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output).filter(file => file.type === 'chunk');
const entry = chunks.find(file => file.name === 'index');
assert.ok(entry && entry.imports.includes('svelte-realtime/server'), 'SSR entry keeps its bare runtime import');
assert.ok(chunks.some(file => file.name === '__live-registry' && file.imports.includes('svelte-realtime/server')), 'generated registry uses the same external runtime');
assert.ok(chunks.every(file => Object.keys(file.modules).every(id => !id.replaceAll(String.fromCharCode(92), '/').includes('/node_modules/svelte-realtime/src/'))), 'realtime runtime is not duplicated into SSR chunks');
console.log('SSR runtime externalization verified');
`);
	expect(output).toContain('SSR runtime externalization verified');
}, 90000);
