import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, PROCESS_TEST_TIMEOUT, removeFixture } from './process-fixtures.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOffenses, indexEol, parseEditorConfig, propertiesFor } from '../scripts/check-formatting.js';

const directories = [];
afterEach(() => { for (const dir of directories.splice(0)) removeFixture(dir, 'realtime-format-'); });
function fixture(content) {
	const dir = mkdtempSync(join(tmpdir(), 'realtime-format-'));
	directories.push(dir);
	const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
	git('init');
	writeFileSync(join(dir, '.gitattributes'), '* text=auto eol=lf\n');
	writeFileSync(join(dir, '.editorconfig'), '[*]\ncharset = utf-8\nend_of_line = lf\ninsert_final_newline = true\ntrim_trailing_whitespace = true\n[*.json]\nindent_style = space\nindent_size = 2\n[*.md]\ntrim_trailing_whitespace = false\n');
	writeFileSync(join(dir, 'sample.json'), content);
	git('add', '.');
	return dir;
}

describe('formatting contract', () => {
	it('applies ordered EditorConfig overrides to nested basenames', () => {
		const sections = parseEditorConfig('[*]\ntrim_trailing_whitespace=true\n[{package.json,package-lock.json}]\nindent_style=space\n[*.md]\ntrim_trailing_whitespace=false\n');
		expect(propertiesFor(sections, 'test/fixture/package.json').indent_style).toBe('space');
		expect(propertiesFor(sections, 'docs/guide.md').trim_trailing_whitespace).toBe('false');
		expect(propertiesFor(sections, 'src/client.js').indent_style).toBeUndefined();
	});
	it('checks committed line endings despite a CRLF working copy', () => {
		const dir = fixture('{\n  "ok": true\n}\n');
		writeFileSync(join(dir, 'sample.json'), '{\r\n  "ok": true\r\n}\r\n');
		expect(indexEol(dir).get('sample.json')).toBe('lf');
		expect(findOffenses(dir).offenses).toEqual([]);
	}, PROCESS_TEST_TIMEOUT);
	it('rejects whitespace, missing newline, odd indentation and malformed UTF-8', () => {
		const dir = fixture('{\n  "ok": true\n}\n');
		writeFileSync(join(dir, 'sample.json'), '{\n   "ok": true \n}');
		const failures = findOffenses(dir).offenses.join('\n');
		expect(failures).toContain('no final newline');
		expect(failures).toContain('trailing whitespace');
		expect(failures).toContain('multiple of 2');
		writeFileSync(join(dir, 'sample.json'), Buffer.from([0xff, 0x0a]));
		expect(findOffenses(dir).offenses.join('\n')).toContain('invalid UTF-8');
	}, PROCESS_TEST_TIMEOUT);
	it('reads index metadata for Unicode and space-containing file names', () => {
		const dir = fixture('{}\n');
		const name = 'caf\u00e9 settings.json';
		writeFileSync(join(dir, name), '{}\n');
		execFileSync('git', ['add', '--', name], { cwd: dir, stdio: 'pipe' });
		expect(indexEol(dir).get(name)).toBe('lf');
		expect(findOffenses(dir).offenses).toEqual([]);
	}, PROCESS_TEST_TIMEOUT);
	it('checks text without any newline rather than treating it as binary', () => {
		const dir = fixture('{}');
		expect(findOffenses(dir).offenses.join('\n')).toContain('no final newline');
	}, PROCESS_TEST_TIMEOUT);
});
