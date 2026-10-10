// @ts-check
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { _writeTypeDeclarations } from './codegen-types.js';

/**
 * Generate $live declarations without starting Vite or executing server modules.
 * Read fresh source on every call without changing an active plugin's source caches.
 * @param {import('../vite.js').GenerateTypesOptions} [options]
 */
export function generateTypes(options = {}) {
	const root = resolve(options.root ?? process.cwd());
	const dir = options.dir ?? 'src/live';
	_writeTypeDeclarations(resolve(root, dir), dir, path => readFileSync(path, 'utf8'));
}
