import { readFileSync } from 'node:fs';
import MarkdownIt from 'markdown-it';
import { expect, it } from 'vitest';
import { _runtimeExports } from '../src/vite/hooks-exports.js';

const examples = [
	['README.md', 16],
	['src/server.d.ts', 6],
	['src/server.js', 3],
	['src/server/cron-engine.js', 1]
];
const exportsMessage = /\bexport\s+(?:function\s+message\b|const\s+(?:message\b|\{[^}]*\bmessage\b)|\{[^}]*\bmessage\b)/;

it.each(examples)('keeps cleanup exports in every routing hook example in %s', (file, minimum) => {
	const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
	const markdown = file.endsWith('.md') ? source : [...source.matchAll(/\/\*\*[\s\S]*?\*\//g)]
		.map(match => match[0].replace(/^\s*\* ?/gm, '')).join('\n');
	let checked = 0;
	for (const block of new MarkdownIt().parse(markdown, {})) {
		if (block.type !== 'fence' || !['js', 'ts'].includes(block.info.trim()) || !exportsMessage.test(block.content)) continue;
		const exports = _runtimeExports(block.content, 'example.ts');
		expect(exports, file + ' contains a parsable hook example').not.toBeNull();
		expect(exports.has('message')).toBe(true);
		checked++;
		for (const handler of ['close', 'unsubscribe']) expect(exports.has(handler), file + ' exports ' + handler).toBe(true);
	}
	expect(checked).toBeGreaterThanOrEqual(minimum);
});
