#!/usr/bin/env node
// Generate and validate the README entry routes and compatibility commands.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anchorsOf } from './check-links.js';
import { SCAFFOLD_ADAPTER_SPEC, SCAFFOLD_REALTIME_SPEC, SCAFFOLD_EXTENSIONS_SPEC, SCAFFOLD_UWS_SPEC } from '../src/cli-utils.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PATHS_START = '<!-- documentation-paths:start -->';
export const PATHS_END = '<!-- documentation-paths:end -->';
const COMPAT_START = '<!-- compatibility:start -->';
const COMPAT_END = '<!-- compatibility:end -->';
const keys = ['identity', 'first-success', 'compatibility', 'tutorial', 'how-to', 'reference', 'explanation', 'operations'];
const types = ['Identity', 'First success', 'Compatibility', 'Tutorial', 'How-to', 'Reference', 'Explanation', 'Operations'];
const site = 'svelte-realtime.dev';
const printable = (value) => typeof value === 'string' && value.trim() === value && value.length > 0 && !/[\u0000-\u001f\u007f`|<>]/.test(value);
function fields(value, expected) {
	return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
export function validateManifest(manifest, pkg) {
	const failures = [];
	if (!fields(manifest, ['schemaVersion', 'owner', 'compatibilitySource', 'entryBudgetLines', 'readmeMaxLines', 'paths'])) return ['manifest fields differ from schema'];
	if (manifest.schemaVersion !== 1 || manifest.owner !== pkg.name) failures.push('manifest version or package owner is invalid');
	if (manifest.compatibilitySource !== 'src/cli-utils.js') failures.push('compatibility must use the CLI-owned tuple');
	if (!Number.isInteger(manifest.entryBudgetLines) || manifest.entryBudgetLines < 30 || manifest.entryBudgetLines > 120) failures.push('entryBudgetLines must be between 30 and 120');
	if (!Number.isInteger(manifest.readmeMaxLines) || manifest.readmeMaxLines < 1) failures.push('readmeMaxLines must be positive');
	if (!Array.isArray(manifest.paths) || manifest.paths.length !== keys.length) return [...failures, 'exactly eight ordered paths are required'];
	const destinations = new Set();
	for (const [index, path] of manifest.paths.entries()) {
		if (!fields(path, ['key', 'type', 'need', 'label', 'destination', 'owner'])) { failures.push(`path ${index} fields differ from schema`); continue; }
		if (path.key !== keys[index] || path.type !== types[index]) failures.push(`path ${index} must be ${keys[index]}/${types[index]}`);
		if (!Object.values(path).every(printable)) failures.push(`path ${index} values must be printable single lines`);
		if (destinations.has(path.destination)) failures.push(`duplicate destination: ${path.destination}`);
		destinations.add(path.destination);
		if (index < 3) {
			if (path.owner !== 'README.md' || !/^#[a-z0-9_-]+$/.test(path.destination)) failures.push(`path ${index} must be owned by a README anchor`);
		} else {
			let url;
			try { url = new URL(path.destination); } catch { failures.push(`path ${index} is not a URL`); }
			if (path.owner !== site || !url || url.protocol !== 'https:' || url.hostname !== site || url.username || url.password || url.port || url.hash || url.search || url.href !== path.destination || !/^\/[a-z0-9/-]*$/.test(url.pathname) || url.pathname.includes('//')) failures.push(`path ${index} must be a clean HTTPS site-owned route`);
		}
	}
	return failures;
}
export function renderPaths(manifest) {
	return [PATHS_START, '**Choose a documentation path:**', '', '| Need | Type | Start here | Owner |', '| --- | --- | --- | --- |', ...manifest.paths.map((path) => `| ${path.need} | ${path.type} | [${path.label}](${path.destination}) | ${path.owner} |`), PATHS_END].join('\n');
}
export function renderCompatibility() {
	const version = (spec) => spec.slice(spec.lastIndexOf('@') + 1);
	return [COMPAT_START,
		'| `svelte-adapter-uws` | `svelte-realtime` | `svelte-adapter-uws-extensions` | Notes |',
		'| --- | --- | --- | --- |',
		'| `^0.4.x` | `^0.4.x` | `^0.4.x` | Legacy stable |',
		'| `^0.5.8` | `^0.5.0` | `^0.5.0` | Stable. Node 22+ required. |',
		`| \`${version(SCAFFOLD_ADAPTER_SPEC)}\` | \`${version(SCAFFOLD_REALTIME_SPEC)}\` | \`${version(SCAFFOLD_EXTENSIONS_SPEC)}\` | Coordinated candidate; publish the tuple together before these registry commands are used. |`,
		'', 'Install the CLI-owned candidate tuple and run its native preflight:', '', '```bash',
		`npm install ${SCAFFOLD_ADAPTER_SPEC} ${SCAFFOLD_REALTIME_SPEC}`,
		`npm install ${SCAFFOLD_UWS_SPEC}`,
		'npm install -D ws', 'npm exec -- svelte-adapter-uws-preflight', '```', COMPAT_END].join('\n');
}
function bounds(source, startMarker, endMarker) {
	if (source.split(startMarker).length !== 2 || source.split(endMarker).length !== 2) throw new Error(`Expected exactly one ${startMarker} block`);
	const start = source.indexOf(startMarker);
	const endStart = source.indexOf(endMarker);
	if (endStart < start) throw new Error('Reversed README block markers');
	for (const [offset, marker] of [[start, startMarker], [endStart, endMarker]]) {
		if ((offset > 0 && source[offset - 1] !== '\n') || (offset + marker.length < source.length && source[offset + marker.length] !== '\n')) throw new Error('README block markers must occupy complete lines');
	}
	return { start, end: endStart + endMarker.length };
}
export function replaceBlock(source, start, end, content) {
	const limits = bounds(source, start, end);
	return source.slice(0, limits.start) + content + source.slice(limits.end);
}
export function validateReadme(readme, manifest) {
	readme = readme.replace(/\r\n/g, '\n');
	const failures = [];
	let paths;
	let compatibility;
	try { paths = bounds(readme, PATHS_START, PATHS_END); compatibility = bounds(readme, COMPAT_START, COMPAT_END); } catch (error) { return [error.message]; }
	if (readme.slice(paths.start, paths.end) !== renderPaths(manifest)) failures.push('routing block differs from the manifest; run npm run generate:documentation');
	if (readme.slice(compatibility.start, compatibility.end) !== renderCompatibility()) failures.push('compatibility block differs from CLI tuple; run npm run generate:documentation');
	const endLine = readme.slice(0, paths.end).split('\n').length;
	if (endLine > manifest.entryBudgetLines) failures.push(`routing block ends at ${endLine}, beyond entry budget ${manifest.entryBudgetLines}`);
	const total = readme.split('\n').length;
	if (total > manifest.readmeMaxLines) failures.push(`README has ${total} lines; size ratchet is ${manifest.readmeMaxLines}. Move content out rather than add headroom.`);
	const anchors = anchorsOf(readme);
	for (const path of manifest.paths.slice(0, 3)) if (!anchors.has(path.destination.slice(1))) failures.push(`missing local destination ${path.destination}`);
	const outside = readme.slice(0, compatibility.start) + readme.slice(compatibility.end);
	if (/uWebSockets\.js\/archive\/refs\/tags\/v\d+\.\d+\.\d+|\bv\d+\.\d+\.\d+\b/.test(outside)) failures.push('native version facts belong in the generated compatibility block');
	return failures;
}
function main() {
	const manifest = JSON.parse(readFileSync(resolve(root, 'docs/documentation.v1.json'), 'utf8'));
	const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
	const schemaErrors = validateManifest(manifest, pkg);
	if (schemaErrors.length) throw new Error(schemaErrors.join('\n'));
	let readme = readFileSync(resolve(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
	if (process.argv.includes('--write')) {
		readme = replaceBlock(readme, PATHS_START, PATHS_END, renderPaths(manifest));
		readme = replaceBlock(readme, COMPAT_START, COMPAT_END, renderCompatibility());
		writeFileSync(resolve(root, 'README.md'), readme);
	}
	const failures = validateReadme(readme, manifest);
	if (failures.length) throw new Error(failures.join('\n'));
	console.log(`documentation contract: eight owned paths; README ${readme.split('\n').length}/${manifest.readmeMaxLines} lines`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
