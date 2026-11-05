// Browser bundle budgets. Each entry is bundled the way a Vite 8 production
// client build bundles it: rolldown, browser conditions, minified ESM, with
// import.meta.env folded for production and svelte left external. The
// adapter's client is external too, so these budgets measure only this
// package; svelte-adapter-uws keeps budgets for its own client.
import { describe, it, expect } from 'vitest';
import { rolldown } from 'rolldown';
import { brotliCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = '\0size-entry';

/**
 * @param {string} code Entry source; `#/` stands for this package's src/
 */
async function measure(code) {
	const source = code.replaceAll('#/', join(root, 'src').split(sep).join('/') + '/');
	const bundle = await rolldown({
		input: ENTRY,
		cwd: root,
		platform: 'browser',
		external: [/^svelte($|\/)/, /^svelte-adapter-uws($|\/)/],
		resolve: { conditionNames: ['browser', 'import', 'default'] },
		transform: { define: { 'import.meta.env.PROD': 'true', 'import.meta.env.DEV': 'false', 'import.meta.env.SSR': 'false', 'import.meta.env.MODE': '"production"' } },
		plugins: [{ name: 'size-entry', resolveId: (id) => (id === ENTRY ? id : null), load: (id) => (id === ENTRY ? source : null) }],
		logLevel: 'silent'
	});
	try {
		const { output } = await bundle.generate({ format: 'esm', minify: true });
		const chunks = output.filter((item) => item.type === 'chunk');
		const entry = chunks.find((chunk) => chunk.isEntry);
		const bytes = Buffer.from(entry.code);
		const modules = Object.keys(entry.modules)
			.filter((id) => id !== ENTRY)
			.map((id) => relative(root, id).split(sep).join('/'))
			.sort();
		return { raw: bytes.length, brotli: brotliCompressSync(bytes).length, modules, lazyChunks: chunks.length - 1 };
	} finally {
		await bundle.close();
	}
}

describe('browser bundle budgets', () => {
	it('keeps the shared transport hook free of the client and server entries', async () => {
		const result = await measure("import { realtimeTransport } from '#/hooks.js'; console.log(realtimeTransport);");
		expect(result.modules).toEqual([
			'src/client/rpc-error.js',
			'src/hooks.js',
			'src/server/live-error.js',
			'src/shared/error-brand.js',
			'src/shared/error-metadata.js'
		]);
		expect(result.brotli).toBeLessThan(1400);
	});
});
