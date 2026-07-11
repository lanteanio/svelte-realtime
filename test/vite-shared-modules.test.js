// Regression: `.shared.js` helper modules in src/live are plain modules the app
// imports on both sides. They must be EXCLUDED from live-file discovery (so
// prewarm / registry / type-gen never falsely warn "not wrapped in live()"),
// and the documented `$live/x.shared.js` import must resolve to the REAL file
// on disk (serving its non-live exports) instead of a virtual client stub.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import svelteRealtime from '../src/vite.js';
import { _findLiveFiles } from '../src/vite/codegen-registry.js';

const testRoot = resolve(import.meta.dirname, '__fixtures_shared__');
const liveDir = resolve(testRoot, 'src/live');

function setup(files = {}) {
	mkdirSync(liveDir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(resolve(liveDir, name), content);
	}
}

function teardown() {
	if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: true });
}

function createPlugin(opts = {}) {
	const plugin = svelteRealtime({ dir: 'src/live', ...opts });
	plugin.configResolved({ root: testRoot, build: {} });
	return plugin;
}

const norm = (p) => String(p).replace(/\\/g, '/');

describe('shared helper modules (.shared.js)', () => {
	afterEach(teardown);

	it('D6: _findLiveFiles excludes .shared.js (kept out of prewarm, registry, type-gen)', () => {
		setup({
			'board.js': "import { live } from 'svelte-realtime/server';\nexport const ping = live(async () => {});",
			'board.shared.js': 'export function apply(s) { return s; }'
		});
		const found = _findLiveFiles(liveDir).map(norm);
		expect(found.some((f) => f.endsWith('/board.js'))).toBe(true);
		expect(found.some((f) => f.endsWith('/board.shared.js'))).toBe(false);
	});

	it('D6b: resolveId serves $live/<x>.shared.js from the real file, not a virtual stub', () => {
		setup({ 'board.shared.js': 'export function apply(s) { return s; }' });
		const plugin = createPlugin();
		const withExt = plugin.resolveId('$live/board.shared.js');
		const noExt = plugin.resolveId('$live/board.shared');
		// Not the virtual id, and points at the real on-disk file both with and
		// without the extension (the documented import keeps the `.js`).
		expect(withExt).not.toBe('\0live:board.shared.js');
		expect(norm(withExt)).toMatch(/\/board\.shared\.js$/);
		expect(norm(noExt)).toMatch(/\/board\.shared\.js$/);
	});

	it('D6b: a non-shared $live import still maps to the virtual module', () => {
		setup({ 'chat.js': "import { live } from 'svelte-realtime/server';\nexport const send = live(async () => {});" });
		const plugin = createPlugin();
		expect(plugin.resolveId('$live/chat')).toBe('\0live:chat');
	});
});
