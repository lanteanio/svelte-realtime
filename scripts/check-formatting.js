#!/usr/bin/env node
// Check tracked text against .editorconfig without rewriting files.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Translate one EditorConfig section glob to a regular expression.
 *
 * Supports the subset this repository uses: `*` (does not cross a directory
 * separator), `**`, `?`, and `{a,b}` alternation. A pattern with no separator
 * matches the BASENAME at any depth, which is what makes `[*.json]` mean every
 * JSON file rather than only the ones beside `.editorconfig`.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
	let out = '';
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		if (char === '*') {
			if (glob[index + 1] === '*') {
				out += '.*';
				index++;
			} else {
				out += '[^/]*';
			}
		} else if (char === '?') {
			out += '[^/]';
		} else if (char === '{') {
			const close = glob.indexOf('}', index);
			if (close === -1) {
				out += '\\{';
			} else {
				const parts = glob.slice(index + 1, close).split(',');
				out += '(?:' + parts.map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
				index = close;
			}
		} else if ('.+^$()|[]\\'.includes(char)) {
			out += '\\' + char;
		} else {
			out += char;
		}
	}
	const anchored = glob.includes('/') ? '^' + out + '$' : '^(?:.*/)?' + out + '$';
	return new RegExp(anchored);
}

/**
 * Parse `.editorconfig` into ordered sections. Later sections win per property,
 * which is the EditorConfig cascade.
 * @param {string} source
 */
export function parseEditorConfig(source) {
	const sections = [];
	let current = null;
	for (const rawLine of source.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
		if (line.startsWith('[') && line.endsWith(']')) {
			current = { glob: line.slice(1, -1), pattern: globToRegExp(line.slice(1, -1)), properties: {} };
			sections.push(current);
			continue;
		}
		const split = line.indexOf('=');
		if (split === -1) continue;
		const key = line.slice(0, split).trim().toLowerCase();
		const value = line.slice(split + 1).trim();
		if (current) current.properties[key] = value;
	}
	return sections;
}

/**
 * Effective properties for one repository-relative path.
 * @param {Array<{pattern: RegExp, properties: Record<string, string>}>} sections
 * @param {string} file
 */
export function propertiesFor(sections, file) {
	const effective = {};
	for (const section of sections) {
		if (section.pattern.test(file)) Object.assign(effective, section.properties);
	}
	return effective;
}

/** Permit alignment after tabs and block-comment continuation lines. */
export function indentRunIsValid(run, rest, style) {
	if (run === '') return true;
	if (style === 'tab') {
		if (run.startsWith('\t')) return true;
		return /^ +$/.test(run) && rest.startsWith('*');
	}
	if (style === 'space') return /^ +$/.test(run);
	return true;
}

function trackedFiles(directory) {
	return execFileSync('git', ['ls-files', '-z'], { cwd: directory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
		.split('\0')
		.filter(Boolean);
}

/**
 * Index end-of-line per tracked file, from ONE git call.
 *
 * `end_of_line` governs the COMMITTED bytes, not the working copy: a clone
 * predating the LF checkout attribute (or one materialised by other tooling)
 * can legitimately hold a CRLF working tree, and reading from disk would
 * report every such file as violating its own declaration. `git ls-files
 * --eol` reports what is actually stored.
 */
export function indexEol(directory = root) {
	const map = new Map();
	const output = execFileSync('git', ['ls-files', '--eol'], { cwd: directory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	for (const line of output.split('\n')) {
		if (!line.trim()) continue;
		// Attributes may contain spaces; the tab separates them from the path.
		const match = /^i\/(\S+)\s+w\/(\S+)\s+attr\/([^\t]*?)\s*\t(.*)$/.exec(line);
		if (match) map.set(match[4], match[1]);
	}
	return map;
}

export function findOffenses(directory = root) {
	const sections = parseEditorConfig(readFileSync(resolve(directory, '.editorconfig'), 'utf8'));
	const eol = indexEol(directory);
	const offenses = [];
	const files = trackedFiles(directory);

	for (const file of files) {
		const properties = propertiesFor(sections, file);
		const absolute = resolve(directory, file);
		if (eol.get(file) === '-text') continue;
		let source;
		try {
			source = new TextDecoder('utf-8', { fatal: properties.charset === 'utf-8' }).decode(readFileSync(absolute));
		} catch (error) {
			offenses.push(`${file}: unreadable or invalid UTF-8: ${error.message}`);
			continue;
		}
		// A file git records as binary has no end-of-line classification and no
		// text contract to check.
		const recorded = eol.get(file);

		if (properties.end_of_line === 'lf' && recorded && recorded !== 'none' && recorded !== 'lf') {
			offenses.push(`${file}: committed end-of-line is ${recorded}, declared lf`);
		}
		if (properties.insert_final_newline === 'true' && source !== '' && !source.endsWith('\n')) {
			offenses.push(`${file}: no final newline`);
		}

		const lines = source.split('\n').map((line) => line.replace(/\r$/, ''));
		// The last element after a trailing newline is an empty string that is
		// not a line of the file.
		if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

		for (const [index, line] of lines.entries()) {
			const where = `${file}:${index + 1}`;
			if (properties.trim_trailing_whitespace === 'true' && /[ \t]$/.test(line)) {
				offenses.push(`${where}: trailing whitespace`);
			}
			if (properties.indent_style) {
				const run = /^[ \t]*/.exec(line)[0];
				if (properties.indent_style === 'space' && Number(properties.indent_size) > 0 && run.length % Number(properties.indent_size)) {
					offenses.push(`${where}: indent width must be a multiple of ${properties.indent_size}`);
				}
				if (!indentRunIsValid(run, line.slice(run.length), properties.indent_style)) {
					offenses.push(`${where}: indent starts with a ${run[0] === '\t' ? 'tab' : 'space'}, declared ${properties.indent_style}`);
				}
			}
		}
	}
	return { offenses, count: files.length };
}

function main() {
	const { offenses, count } = findOffenses();
	// A pass over zero files would report success having read nothing.
	if (count < 100) throw new Error(`only ${count} tracked file(s) were read; the file list is not trustworthy`);
	if (offenses.length > 0) {
		const shown = offenses.slice(0, 40);
		throw new Error(
			`${offenses.length} formatting offense(s) against .editorconfig:\n- ` + shown.join('\n- ') +
			(offenses.length > shown.length ? `\n- ... and ${offenses.length - shown.length} more` : '')
		);
	}
	console.log(`check-formatting: ${count} tracked files conform to .editorconfig`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error('check-formatting failed:\n' + error.message);
		process.exitCode = 1;
	}
}
