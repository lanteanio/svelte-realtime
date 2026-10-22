import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import realtime from '../src/vite.js';
import { _fileCache, _codeCache } from '../src/vite/source-cache.js';
import { _respellUnder } from '../src/vite/paths.js';

let root;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
	vi.restoreAllMocks();
});

describe('live import file identity', () => {
	it('invalidates generated exports using the on-disk spelling after an edit', async () => {
		root = mkdtempSync(join(tmpdir(), 'realtime-case-'));
		const liveDir = join(root, 'src/live');
		mkdirSync(join(liveDir, 'nested'), { recursive: true });
		const file = join(liveDir, 'nested/counter.js');
		writeFileSync(file, "// realtime-allow-public\nimport { live } from 'svelte-realtime/server';\nexport const before = live(() => 1);\n");
		const p = realtime({ typedImports: false });
		p.configResolved({ root, command: 'serve', build: {} });
		const canonical = '\0live:nested/counter';
		const requested = process.platform === 'win32' ? '$live/NESTED/Counter' : '$live/nested/counter';
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
	it('does not add a second separator when a Windows live directory is a drive root', () => {
		vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
		expect(_respellUnder('C:\\', 'c:\\Counter.js', '\\')).toBe('C:\\Counter.js');
		expect(_respellUnder('C:\\', 'D:\\Counter.js', '\\')).toBeNull();
		expect(_respellUnder('C:/', 'c:/Counter.js', '/')).toBe('C:/Counter.js');
	});
});
