import { readFileSync } from 'node:fs';
import MarkdownIt from 'markdown-it';
import { expect, it } from 'vitest';
import { _runtimeExports } from '../src/vite/hooks-exports.js';

it('keeps cleanup exports in every README routing hook example', () => {
	const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
	let checked = 0;
	for (const block of new MarkdownIt().parse(readme, {})) {
		if (block.type !== 'fence' || !['js', 'ts'].includes(block.info.trim())) continue;
		const exports = _runtimeExports(block.content, 'example.' + block.info.trim());
		if (!exports?.has('message')) continue;
		checked++;
		for (const handler of ['close', 'unsubscribe']) expect(exports.has(handler), 'README.md:' + (block.map[0] + 1) + ' exports ' + handler).toBe(true);
	}
	expect(checked).toBeGreaterThan(15);
});
