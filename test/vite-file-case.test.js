import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import realtime from '../src/vite.js';
import { _fileCache, _codeCache } from '../src/vite/source-cache.js';
import { _canonicalLiveFile, _respellUnder } from '../src/vite/paths.js';

let root;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
	vi.restoreAllMocks();
});

// The end-to-end case needs a file system that opens a differently cased path.
const probe = mkdtempSync(join(tmpdir(), 'realtime-case-probe-'));
writeFileSync(join(probe, 'lower.js'), '');
const caseInsensitiveFs = existsSync(join(probe, 'LOWER.js'));
rmSync(probe, { recursive: true, force: true });

describe('live import file identity', () => {
	it.runIf(caseInsensitiveFs)('invalidates generated exports using the on-disk spelling after an edit', async () => {
		root = mkdtempSync(join(tmpdir(), 'realtime-case-'));
		const liveDir = join(root, 'src/live');
		mkdirSync(join(liveDir, 'nested'), { recursive: true });
		const file = join(liveDir, 'nested/counter.js');
		writeFileSync(file, "// realtime-allow-public\nimport { live } from 'svelte-realtime/server';\nexport const before = live(() => 1);\n");
		const p = realtime({ typedImports: false });
		p.configResolved({ root, command: 'serve', build: {} });
		const canonical = '\0live:nested/counter';
		const requested = '$live/NESTED/Counter';
		const id = p.resolveId(requested);
		const oldCode = p.load(id);
		expect(oldCode).toContain('export const before');
		const module = { id };
		const runtime = { _prepareHmr: vi.fn(() => ({})), _restoreHmr: vi.fn() };
		const graph = { getModuleById: vi.fn(() => module), getModulesByFile: vi.fn(() => new Set()), invalidateModule: vi.fn() };
		const server = {
			moduleGraph: graph,
			ssrLoadModule: vi.fn(async name => ['svelte-realtime/server', '/@svelte-realtime-server'].includes(name) ? runtime : {}),
			ws: { send: vi.fn() }
		};
		writeFileSync(file, "// realtime-allow-public\nimport { live } from 'svelte-realtime/server';\nexport const after = live(() => 2);\n");
		await p.handleHotUpdate({ file, server });
		expect(runtime._prepareHmr).toHaveBeenCalledTimes(1);
		const freshCode = p.load(id);
		expect(freshCode).toContain('export const after');
		expect(freshCode).not.toContain('export const before');
		expect(id).toBe(canonical);
		expect(p.resolveId('$live/nested/counter')).toBe(id);
		expect(freshCode).toContain('nested/counter/after');
		expect([..._fileCache.keys()]).toEqual([file]);
		expect([..._codeCache.keys()]).toEqual(['client:' + file]);
		expect(graph.getModuleById).toHaveBeenCalledWith(canonical);
	});
	it.each(['win32', 'darwin'])('uses the on-disk spelling below the live directory on %s', platform => {
		root = mkdtempSync(join(tmpdir(), 'realtime-case-'));
		const liveDir = join(root, 'src/live');
		mkdirSync(join(liveDir, 'nested'), { recursive: true });
		writeFileSync(join(liveDir, 'nested/counter.js'), '');
		vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
		expect(_canonicalLiveFile(liveDir, join(liveDir, 'NESTED/Counter.js'))).toBe(join(liveDir, 'nested/counter.js'));
		// A deleted file keeps its reported suffix.
		expect(_canonicalLiveFile(liveDir, join(liveDir, 'nested/Gone.js'))).toBe(join(liveDir, 'nested/Gone.js'));
	});
	it('keeps case-sensitive file names on Linux', () => {
		root = mkdtempSync(join(tmpdir(), 'realtime-case-'));
		const liveDir = join(root, 'src/live');
		mkdirSync(liveDir, { recursive: true });
		writeFileSync(join(liveDir, 'counter.js'), '');
		vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
		expect(_canonicalLiveFile(liveDir, join(liveDir, 'Counter.js'))).toBe(join(liveDir, 'Counter.js'));
	});
	it('co-locates the registry with hooks when the root is a file system root', () => {
		const fsRoot = parse(tmpdir()).root;
		const p = realtime({ typedImports: false });
		p.configResolved({ root: fsRoot, command: 'serve', build: {} });
		const hooks = fsRoot.replaceAll('\\', '/') + 'src/hooks.ws.js';
		const result = p.transform.call({}, "export { message } from 'svelte-realtime/server';\n", hooks, { ssr: true });
		expect(result?.code).toMatch(/^import '\/@svelte-realtime-registry';/);
	});
	it('does not add a second separator when a Windows live directory is a drive root', () => {
		vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
		expect(_respellUnder('C:\\', 'c:\\Counter.js', '\\')).toBe('C:\\Counter.js');
		expect(_respellUnder('C:\\', 'D:\\Counter.js', '\\')).toBeNull();
		expect(_respellUnder('C:/', 'c:/Counter.js', '/')).toBe('C:/Counter.js');
	});
});
