import { mergeConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import realtime from '../vite.js';

let root;
afterEach(() => { if (root) { rmSync(root, { recursive: true, force: true }); root = undefined; } });
function plugin(command = 'serve', options = {}) {
 root = mkdtempSync(join(tmpdir(), 'realtime-kit-'));
 mkdirSync(join(root, 'src/live'), { recursive: true });
 writeFileSync(join(root, 'src/live/count.js'), "import { live } from 'svelte-realtime/server';\nexport const count = live(() => 1);\n");
 const result = realtime({ typedImports: false, ...options });
 result.configResolved({ root, command, build: {} });
 return result;
}
function server(modern = true) {
 const listeners = {};
 const changed = { id: 'changed-live-module' };
 const registry = { id: 'live-registry' };
 const graph = { getModuleById: vi.fn(() => registry), getModulesByFile: vi.fn(() => new Set([changed])), invalidateModule: vi.fn() };
 const runtime = { _prepareHmr: vi.fn(() => ({})), _restoreHmr: vi.fn() };
 const load = vi.fn(async id => ['svelte-realtime/server', '/@svelte-realtime-server'].includes(id) ? runtime : {});
 return {
  config: { base: '/', plugins: modern ? [{ name: 'vite-plugin-sveltekit-setup', api: { options: { paths: {}, adapter: { name: 'adapter-uws' } } } }] : [] },
  middlewares: { use: vi.fn() },
  httpServer: { once: (name, fn) => { listeners[name] = fn; } },
  watcher: { on: vi.fn() },
  moduleGraph: modern ? { getModuleById: vi.fn(() => null), invalidateModule: vi.fn() } : graph,
  environments: { ssr: { moduleGraph: graph, runner: { import: load } } },
  ssrLoadModule: modern ? vi.fn(() => { throw new Error('Wrong module graph'); }) : load,
  warmupRequest: vi.fn(async () => {}),
  listeners, graph, load, changed, registry, runtime
 };
}

describe('SvelteKit build environments', () => {
 it('emits the registry only in the production SSR environment', () => {
  const p = plugin('build');
  const emitFile = vi.fn();
  p.buildStart.call({ environment: { name: 'ssr' }, emitFile });
  expect(emitFile).toHaveBeenCalledExactlyOnceWith({ type: 'chunk', id: '\0live:__registry', fileName: '__live-registry.js' });
  emitFile.mockClear();
  p.buildStart.call({ environment: { name: 'client' }, emitFile });
  expect(emitFile).not.toHaveBeenCalled();
  p.configResolved({ root, command: 'serve', build: {} });
  p.buildStart.call({ environment: { name: 'ssr' }, emitFile });
  expect(emitFile).not.toHaveBeenCalled();
 });
 it('keeps realtime external without losing a custom external predicate', () => {
  const p = plugin('build');
  const external = vi.fn(id => id === 'custom');
  const sentinel = { name: 'user-plugin' };
  const config = { build: { rolldownOptions: { external, plugins: [sentinel], output: [{ format: 'es' }] } } };
  const result = p.configEnvironment('ssr', config);
  expect(config.build.rolldownOptions.external).toBe(external);
  const merged = mergeConfig(config, result);
  expect(merged.build.rolldownOptions.plugins).toEqual([sentinel]);
  expect(merged.build.rolldownOptions.output).toEqual([{ format: 'es' }]);
  const predicate = merged.build.rolldownOptions.external;
  expect(predicate('svelte-realtime/server', 'entry.js', true)).toBe(true);
  expect(predicate('custom', 'entry.js', true)).toBe(true);
  expect(external).toHaveBeenCalledWith('custom', 'entry.js', true);
  expect(predicate('other', 'entry.js', false)).toBe(false);
  const client = {};
  p.configEnvironment('client', client);
  expect(client).toEqual({});
 });
 it('generates distinct client and server stubs with a shared plugin instance', () => {
  const p = plugin('build');
  const client = p.load.call({ environment: { config: { consumer: 'client' } } }, '\0live:count');
  const ssr = p.load.call({ environment: { config: { consumer: 'server' } } }, '\0live:count');
  expect(client).toContain('__rpc');
  expect(ssr).not.toContain('__rpc');
  expect(ssr).toContain('export * from');
  expect(ssr).toContain('/src/live/count.js');
 });
 it('co-locates the registry with hooks in the SSR environment only', () => {
  const p = plugin();
  const id = join(root, 'src/hooks.ws.ts');
  const input = "export { message } from 'svelte-realtime/server';";
  expect(p.transform.call({ environment: { config: { consumer: 'server' } } }, input, id).code).toContain('import "/@svelte-realtime-registry";');
  expect(p.transform.call({ environment: { config: { consumer: 'client' } } }, input, id)).toBeNull();
 });
});

describe('SvelteKit development module loading', () => {
 it.each(['wrapped', 'none'])('uses the Kit 3 graph with a %s adapter configuration', async adapterMode => {
  const p = plugin();
  const s = server();
  const options = s.config.plugins[0].api.options;
  if (adapterMode === 'wrapped') options.adapter.name = 'custom-adapter';
  else delete options.adapter;
  p.configureServer(s);
  await s.listeners.listening();
  expect(s.load).toHaveBeenCalledWith('/@svelte-realtime-registry');
  await p.handleHotUpdate({ file: join(root, 'src/live/count.js').replaceAll('\\', '/'), server: s });
  expect(s.graph.invalidateModule).toHaveBeenCalledWith(s.changed);
  expect(s.load).toHaveBeenCalledWith('/@svelte-realtime-server');
  expect(s.runtime._prepareHmr).toHaveBeenCalledExactlyOnceWith();
  expect(s.ssrLoadModule).not.toHaveBeenCalled();
 });
 it('keeps the Kit 2 loader when only an adapter or an unrelated plugin has paths', async () => {
  const p = plugin();
  const s = server(false);
  s.config.plugins = [
   { name: 'vite-plugin-sveltekit-setup', api: { options: { kit: { paths: {} }, adapter: { name: 'adapter-uws' } } } },
   { name: 'custom-plugin', api: { options: { paths: {} } } }
  ];
  s.environments.ssr.runner.import = vi.fn(() => { throw new Error('Wrong modern graph'); });
  p.configureServer(s);
  await s.listeners.listening();
  await p.handleHotUpdate({ file: join(root, 'src/live/count.js').replaceAll('\\', '/'), server: s });
  expect(s.ssrLoadModule).toHaveBeenCalledWith('svelte-realtime/server');
  expect(s.environments.ssr.runner.import).not.toHaveBeenCalled();
 });
 for (const modern of [false, true]) {
  it('loads the startup registry using the ' + (modern ? 'environment runner' : 'Kit 2 loader'), async () => {
   const p = plugin();
   const s = server(modern);
   p.configureServer(s);
   await s.listeners.listening();
   expect(s.load).toHaveBeenCalledWith('/@svelte-realtime-registry');
   if (modern) expect(s.ssrLoadModule).not.toHaveBeenCalled();
  });
  it('reloads live handlers using the ' + (modern ? 'SSR environment graph' : 'Kit 2 graph'), async () => {
   const p = plugin();
   const s = server(modern);
   await p.handleHotUpdate({ file: join(root, 'src/live/count.js').replaceAll('\\', '/'), server: s });
   expect(s.graph.getModulesByFile).toHaveBeenCalled();
   expect(s.graph.invalidateModule).toHaveBeenCalledWith(s.changed);
   expect(s.graph.invalidateModule).toHaveBeenCalledWith(s.registry);
   expect(s.runtime._prepareHmr).toHaveBeenCalledExactlyOnceWith();
   expect(s.load.mock.calls.map(call => call[0])).toEqual([modern ? '/@svelte-realtime-server' : 'svelte-realtime/server', '/@svelte-realtime-registry']);
   if (modern) expect(s.ssrLoadModule).not.toHaveBeenCalled();
  });
 }
});

describe('Windows root spelling', () => {
 // SvelteKit keeps the root as the user spelled it. Vite 8 realpaths its own
 // root, which on Windows can change the case of the drive letter.
 let restorePlatform;
 afterEach(() => { restorePlatform?.(); restorePlatform = undefined; });
 function onPlatform(value) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value });
  restorePlatform = () => Object.defineProperty(process, 'platform', descriptor);
 }
 const onWindows = () => onPlatform('win32');
 const respell = path => path === path.toUpperCase() ? path.toLowerCase() : path.toUpperCase();
 const posix = path => path.replaceAll('\\', '/');
 function viteRespelledRoot() {
  root = mkdtempSync(join(tmpdir(), 'realtime-kit-'));
  mkdirSync(join(root, 'src/live'), { recursive: true });
  writeFileSync(join(root, 'src/live/count.js'), "import { live } from 'svelte-realtime/server';\nexport const count = live(() => 1);\n");
  const p = realtime({ typedImports: false });
  p.config({ root }, { command: 'serve' });
  p.configResolved({ root: respell(root), command: 'serve', build: {} });
  return p;
 }
 it('imports live modules under the root SvelteKit uses', () => {
  onWindows();
  const p = viteRespelledRoot();
  const registry = p.load('\0live:__registry');
  expect(registry).toContain(JSON.stringify(posix(join(root, 'src/live/count.js'))));
  expect(p.load.call({ environment: { config: { consumer: 'server' } } }, '\0live:count')).toContain(posix(join(root, 'src/live/count.js')));
 });
 it('reloads a live module that Vite reports under its own spelling', async () => {
  onWindows();
  const p = viteRespelledRoot();
  const s = server();
  await p.handleHotUpdate({ file: posix(join(respell(root), 'src/live/count.js')), server: s });
  expect(s.graph.getModulesByFile).toHaveBeenCalledWith(posix(join(root, 'src/live/count.js')));
  expect(s.graph.invalidateModule).toHaveBeenCalledWith(s.changed);
  expect(s.runtime._prepareHmr).toHaveBeenCalledExactlyOnceWith();
 });
 it('co-locates the registry with hooks loaded under either spelling', () => {
  onWindows();
  const p = viteRespelledRoot();
  const input = "export { message } from 'svelte-realtime/server';";
  const ssr = { environment: { config: { consumer: 'server' } } };
  for (const spelling of [root, respell(root)]) {
   expect(p.transform.call(ssr, input, join(spelling, 'src/hooks.ws.js')).code).toContain('import "/@svelte-realtime-registry";');
  }
 });
 it('takes the root from the working directory when the config has none', () => {
  onWindows();
  root = mkdtempSync(join(tmpdir(), 'realtime-kit-'));
  mkdirSync(join(root, 'src/live'), { recursive: true });
  writeFileSync(join(root, 'src/live/count.js'), "import { live } from 'svelte-realtime/server';\nexport const count = live(() => 1);\n");
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
  try {
   const p = realtime({ typedImports: false });
   p.config({}, { command: 'serve' });
   p.configResolved({ root: respell(root), command: 'serve', build: {} });
   expect(p.load('\0live:__registry')).toContain(JSON.stringify(posix(join(root, 'src/live/count.js'))));
  } finally { cwd.mockRestore(); }
 });
 it("keeps Vite's root when the configured root is another directory", () => {
  onWindows();
  root = mkdtempSync(join(tmpdir(), 'realtime-kit-'));
  mkdirSync(join(root, 'src/live'), { recursive: true });
  writeFileSync(join(root, 'src/live/count.js'), "import { live } from 'svelte-realtime/server';\nexport const count = live(() => 1);\n");
  const p = realtime({ typedImports: false });
  p.config({ root: join(root, 'app') }, { command: 'serve' });
  p.configResolved({ root, command: 'serve', build: {} });
  expect(p.load('\0live:__registry')).toContain(JSON.stringify(posix(join(root, 'src/live/count.js'))));
 });
 it('reloads once when one save or delete is reported under both spellings', async () => {
  onWindows();
  const p = viteRespelledRoot();
  const s = server();
  p.configureServer(s);
  const file = join(root, 'src/live/count.js');
  for (const spelling of [respell(root), root]) {
   await p.handleHotUpdate({ file: posix(join(spelling, 'src/live/count.js')), server: s });
  }
  expect(s.runtime._prepareHmr).toHaveBeenCalledTimes(1);
  writeFileSync(file, "import { live } from 'svelte-realtime/server';\nexport const count = live(() => 2);\n");
  await p.handleHotUpdate({ file: posix(file), server: s });
  expect(s.runtime._prepareHmr).toHaveBeenCalledTimes(2);
  const unlink = s.watcher.on.mock.calls.find(([event]) => event === 'unlink')[1];
  rmSync(file);
  for (const spelling of [respell(root), root]) await unlink(join(spelling, 'src/live/count.js'));
  expect(s.runtime._prepareHmr).toHaveBeenCalledTimes(3);
 });
 it('keeps paths case-sensitive off Windows', () => {
  onPlatform('linux');
  const p = viteRespelledRoot();
  const ssr = { environment: { config: { consumer: 'server' } } };
  expect(p.transform.call(ssr, '', join(root, 'src/hooks.ws.js'))).toBeNull();
  expect(p.transform.call(ssr, '', join(respell(root), 'src/hooks.ws.js')).code).toContain('import "/@svelte-realtime-registry";');
 });
});

describe('repeated live module updates', () => {
 it('retries a save whose reload failed when the same content is saved again', async () => {
  const p = plugin();
  const s = server();
  let failRegistry = true;
  s.load.mockImplementation(async id => {
   if (id === '/@svelte-realtime-server') return s.runtime;
   if (id === '/@svelte-realtime-registry' && failRegistry) {
    failRegistry = false;
    throw new Error('broken import');
   }
   return {};
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
   const update = { file: join(root, 'src/live/count.js').replaceAll('\\', '/'), server: s };
   await p.handleHotUpdate(update);
   expect(s.runtime._restoreHmr).toHaveBeenCalledTimes(1);
   await p.handleHotUpdate(update);
   expect(s.runtime._prepareHmr).toHaveBeenCalledTimes(2);
   // Another event for the same, now handled, write does not reload again.
   await p.handleHotUpdate(update);
   expect(s.runtime._prepareHmr).toHaveBeenCalledTimes(2);
   expect(s.runtime._restoreHmr).toHaveBeenCalledTimes(1);
  } finally { error.mockRestore(); }
 });
 it('reloads a deliberate save of unchanged content', async () => {
  const p = plugin();
  const s = server();
  const file = join(root, 'src/live/count.js');
  const update = { file: file.replaceAll('\\', '/'), server: s };
  await p.handleHotUpdate(update);
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  await p.handleHotUpdate(update);
  expect(s.runtime._prepareHmr).toHaveBeenCalledTimes(2);
 });
 it('retries a save whose reload threw', async () => {
  const p = plugin();
  const s = server();
  s.runtime._prepareHmr.mockImplementationOnce(() => { throw new Error('runtime unavailable'); });
  const update = { file: join(root, 'src/live/count.js').replaceAll('\\', '/'), server: s };
  await expect(p.handleHotUpdate(update)).rejects.toThrow('runtime unavailable');
  await p.handleHotUpdate(update);
  expect(s.runtime._prepareHmr).toHaveBeenCalledTimes(2);
 });
 it('retries a new live file whose first registration failed', async () => {
  const p = plugin();
  const s = server();
  let failRegistry = true;
  s.load.mockImplementation(async id => {
   if (id === '/@svelte-realtime-server') return s.runtime;
   if (id === '/@svelte-realtime-registry' && failRegistry) {
    failRegistry = false;
    throw new Error('missing import');
   }
   return {};
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
   p.configureServer(s);
   const add = s.watcher.on.mock.calls.find(([event]) => event === 'add')[1];
   const file = join(root, 'src/live/count.js');
   await add(file);
   expect(s.runtime._restoreHmr).toHaveBeenCalledTimes(1);
   await p.handleHotUpdate({ file: file.replaceAll('\\', '/'), server: s });
   expect(s.runtime._prepareHmr).toHaveBeenCalledTimes(2);
  } finally { error.mockRestore(); }
 });
 it('returns the same client update for a repeated event and reloads the server once', async () => {
  const p = plugin();
  const s = server(false);
  const update = { file: join(root, 'src/live/count.js').replaceAll('\\', '/'), server: s };
  const first = await p.handleHotUpdate(update);
  const second = await p.handleHotUpdate(update);
  expect(first).toEqual([s.registry]);
  expect(second).toEqual(first);
  expect(s.runtime._prepareHmr).toHaveBeenCalledTimes(1);
 });
});

describe('overlapping live module updates', () => {
 it('keeps handlers registered when two registry reloads overlap', async () => {
  const p = plugin();
  const s = server();
  const registrations = new Set(['count']);
  let cachedRegistry = true;
  let runtimeLoads = 0;
  let registryExecutions = 0;
  let firstRegistryExecuted;
  const firstExecution = new Promise(resolve => { firstRegistryExecuted = resolve; });
  s.graph.invalidateModule.mockImplementation(mod => {
   if (mod === s.registry) cachedRegistry = false;
  });
  s.runtime._prepareHmr.mockImplementation(() => {
   const snapshot = new Set(registrations);
   registrations.clear();
   return snapshot;
  });
  s.runtime._restoreHmr.mockImplementation(snapshot => {
   registrations.clear();
   for (const name of snapshot) registrations.add(name);
  });
  s.load.mockImplementation(async id => {
   if (id === '/@svelte-realtime-server') {
    runtimeLoads++;
    // The second runtime import finishes after the first registry has
    // executed. A serialized reload sees an already-resolved promise.
    if (runtimeLoads === 2) await firstExecution;
    return s.runtime;
   }
   if (id === '/@svelte-realtime-registry') {
    if (!cachedRegistry) {
     cachedRegistry = true;
     registryExecutions++;
     registrations.add('count');
     firstRegistryExecuted();
    }
    return {};
   }
   throw new Error('Unexpected module: ' + id);
  });
  const update = { file: join(root, 'src/live/count.js').replaceAll('\\', '/'), server: s };
  // Two saves of different content, the second arriving while the first reloads.
  const first = p.handleHotUpdate(update);
  writeFileSync(join(root, 'src/live/count.js'), "import { live } from 'svelte-realtime/server';\nexport const count = live(() => 2);\n");
  await Promise.all([first, p.handleHotUpdate(update)]);
  expect(runtimeLoads).toBe(2);
  expect(s.runtime._prepareHmr).toHaveBeenCalledTimes(2);
  expect([...registrations]).toEqual(['count']);
  expect(registryExecutions).toBe(2);
  expect(s.runtime._restoreHmr).not.toHaveBeenCalled();
 });
});

describe('streamed devtools bootstrap', () => {
 async function response(writeResponse, options) {
  const p = plugin('serve', options);
  const s = server();
  p.configureServer(s);
  const middleware = s.middlewares.use.mock.calls[0]?.[0];
  const http = createServer((req, res) => {
   if (middleware) middleware(req, res, () => writeResponse(res));
   else writeResponse(res);
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  try {
   const result = await fetch('http://127.0.0.1:' + http.address().port);
   return { body: await result.text(), headers: result.headers, p };
  } finally { await new Promise(resolve => http.close(resolve)); }
 }
 it('injects a browser-loadable module across split closing tags without changing UTF-8', async () => {
  const before = '<html><head><title>Gr\u00fc\u00dfe</title>';
  const after = '</head><body>counter</body></html>';
  const result = await response(res => {
   res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(before + after) });
   const bytes = Buffer.from(before);
   const split = bytes.indexOf(Buffer.from('\u00fc')) + 1;
   res.write(bytes.subarray(0, split));
   res.write(bytes.subarray(split));
   res.write('</he');
   res.write('ad><body>counter</bo');
   res.end('dy></html>');
  });
  const script = '<script type="module" src="/@svelte-realtime-devtools"></script>';
  expect(result.body).toBe(before + script + after);
  expect(result.headers.has('content-length')).toBe(false);
  const id = result.p.resolveId('/@svelte-realtime-devtools');
  expect(result.p.load(id)).toContain("import { __devtools } from 'svelte-realtime/client'");
  expect(result.p.load(id)).toContain("import('svelte-realtime/devtools')");
 });
 it('injects into an end-only response once', async () => {
  const result = await response(res => {
   res.setHeader('content-type', 'text/html');
   res.setHeader('content-length', '26');
   res.end('<html><body></body></html>');
  });
  expect(result.body.match(/src="\/@svelte-realtime-devtools"/g)).toHaveLength(1);
 });
 it('preserves non-HTML responses and their length', async () => {
  const result = await response(res => {
   res.writeHead(200, { 'content-type': 'application/json', 'content-length': '2' });
   res.end('{}');
  });
  expect(result.body).toBe('{}');
  expect(result.headers.get('content-length')).toBe('2');
 });
 it('leaves HTML unchanged when devtools is disabled', async () => {
  const result = await response(res => { res.setHeader('content-type', 'text/html'); res.end('<body></body>'); }, { devtools: false });
  expect(result.body).toBe('<body></body>');
  expect(result.p.load(result.p.resolveId('/@svelte-realtime-devtools'))).toBe('');
 });
});
