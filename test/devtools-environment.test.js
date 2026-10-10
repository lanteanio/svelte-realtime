import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const instrument = fileURLToPath(new URL('../src/client/devtools-instrument.js', import.meta.url));

it('disables instrumentation when loaded without a bundler environment', () => {
 const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  import { pathToFileURL } from 'node:url';
  const tools = await import(pathToFileURL(process.argv[1]).href);
  assert.equal(tools.__devtools, null);
  const payload = new Proxy({}, { get() { throw Error('Payload inspected'); }, ownKeys() { throw Error('Payload enumerated'); } });
  tools._devtoolsStart('secret/path', 'request', [payload]);
  tools._devtoolsEnd('request', true, payload);
  tools._devtoolsStream('secret/path', 'secret/topic', 1);
  tools._devtoolsStreamEvent('secret/path', 'update', payload);
  tools._devtoolsVolatileSent('secret/path', [payload]);
  tools._devtoolsConnectionStatus('open');
  tools._devtoolsConnectionFailure(payload);
  tools._devtoolsSmoothRegister(() => payload)();
 `, instrument], { encoding: 'utf8', timeout: 10000, windowsHide: true });
 expect(result.error).toBeUndefined();
 expect(result.status, result.stdout + result.stderr).toBe(0);
}, 15000);

it.each([
 ['development', { DEV: true, PROD: false }, true],
 ['production', { DEV: false, PROD: true }, false],
 ['conflicting flags', { DEV: true, PROD: true }, false],
 ['unspecified mode', {}, false]
])('enables bundled instrumentation only for explicit development: %s', async (_name, env, enabled) => {
 const result = await build({ configFile: false, logLevel: 'silent', define: { 'import.meta.env.DEV': JSON.stringify(env.DEV) ?? 'undefined', 'import.meta.env.PROD': JSON.stringify(env.PROD) ?? 'undefined' }, build: { write: false, lib: { entry: instrument, formats: ['es'], fileName: 'devtools' } } });
 const bundled = (Array.isArray(result) ? result[0] : result).output[0].code;
 const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  const tools = await import('data:text/javascript;base64,' + process.argv[1]);
  assert.equal(tools.__devtools !== null, process.argv[2] === 'true');
  if (tools.__devtools) {
   tools.__devtools.paused = false;
   tools._devtoolsStart('example/read', 'request', []);
   tools._devtoolsEnd('request', true, 'value');
   assert.equal(tools.__devtools.history.filter(Boolean).length, 1);
  }
 `, Buffer.from(bundled).toString('base64'), String(enabled)], { encoding: 'utf8', timeout: 10000, windowsHide: true });
 expect(child.error).toBeUndefined();
 expect(child.status, child.stdout + child.stderr).toBe(0);
}, 15000);
