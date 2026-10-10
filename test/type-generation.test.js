import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import * as realtime from '../src/vite.js';

const ownedRoots = [];
function fixture(dir = 'src/live') {
	const root = mkdtempSync(join(import.meta.dirname, '.type-generation-'));
	ownedRoots.push(root);
	mkdirSync(join(root, dir), { recursive: true });
	return root;
}
function source(root, name, content, dir = 'src/live') {
	const path = join(root, dir, name);
	mkdirSync(resolve(path, '..'), { recursive: true });
	writeFileSync(path, content);
	return path;
}
function diagnostics(root, dir = 'src/live') {
	const options = { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
	const declarations = join(root, dir, '$types.d.ts');
	return ts.getPreEmitDiagnostics(ts.createProgram([
		join(root, 'consumer.ts'), ...(existsSync(declarations) ? [declarations] : [])
	], options)).map(d => ({ code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') }));
}
afterEach(() => {
	for (const root of ownedRoots.splice(0)) {
		if (!root.startsWith(join(import.meta.dirname, '.type-generation-'))) throw new Error('Unexpected fixture path');
		rmSync(root, { recursive: true, force: true });
	}
});

describe('standalone live declaration generation', () => {
	it('typechecks a newly added module from a cold tree without running a build or its server code', () => {
		const root = fixture();
		source(root, 'widgets.ts', `
throw new Error('The declaration generator must not execute server modules');
import { live } from 'svelte-realtime/server';
export const makeWidget = live((ctx, name: string): number => name.length);
`);
		writeFileSync(join(root, 'consumer.ts'), `
import { makeWidget } from '$live/widgets';
import { generateTypes, type GenerateTypesOptions } from 'svelte-realtime/vite';
const options: GenerateTypesOptions = { root: '.', dir: 'src/live' };
generateTypes(); generateTypes(options);
// @ts-expect-error a generator root must be a path string
generateTypes({ root: 42 });
// @ts-expect-error Vite plugin settings are not generation options
generateTypes({ typedImports: true });
const result: Promise<number> = makeWidget('widget');
// @ts-expect-error the ctx parameter is absent and the remaining argument stays typed
makeWidget(42);
void result;
`);
		expect(diagnostics(root).some(d => d.code === 2307 && d.message.includes('$live/widgets'))).toBe(true);
		realtime.generateTypes({ root });
		expect(diagnostics(root)).toEqual([]);
		for (const artifact of ['build', '.svelte-kit', 'vite.config.js']) expect(existsSync(join(root, artifact))).toBe(false);
	}, 30000);

	it('regenerates changed and added modules in a long-lived process and removes deleted declarations', () => {
		const root = fixture();
		const original = source(root, 'widgets.ts', "export const makeWidget = live((ctx, name: string): number => 1);");
		realtime.generateTypes({ root });
		writeFileSync(original, "export const makeWidget = live((ctx, count: number): string => 'value');");
		const added = source(root, 'nested/new.ts', "export const added = live((ctx, value: boolean): boolean => value);");
		realtime.generateTypes({ root });
		writeFileSync(join(root, 'consumer.ts'), `
import { makeWidget } from '$live/widgets';
import { added } from '$live/nested/new';
const result: Promise<string> = makeWidget(3);
const nested: Promise<boolean> = added(true);
// @ts-expect-error the old signature must not survive a source edit
makeWidget('stale');
void result; void nested;
`);
		expect(diagnostics(root)).toEqual([]);
		rmSync(original); realtime.generateTypes({ root });
		expect(readFileSync(join(root, 'src/live/$types.d.ts'), 'utf8')).not.toContain('$live/widgets');
		rmSync(added); realtime.generateTypes({ root });
		expect(existsSync(join(root, 'src/live/$types.d.ts'))).toBe(false);
	}, 30000);

	it('uses the configured live directory and preserves unchanged declaration mtimes', () => {
		const root = fixture('server/functions');
		source(root, 'rooms/lobby.ts', "export const greet = live((ctx, name: string): string => name);", 'server/functions');
		realtime.generateTypes({ root, dir: 'server/functions' });
		const output = join(root, 'server/functions/$types.d.ts');
		const oldTime = new Date('2000-01-01T00:00:00Z');
		utimesSync(output, oldTime, oldTime);
		realtime.generateTypes({ root, dir: 'server/functions' });
		expect(statSync(output).mtimeMs).toBe(oldTime.getTime());
		expect(readFileSync(output, 'utf8')).toContain('$live/rooms/lobby');
		expect(existsSync(join(root, 'src/live/$types.d.ts'))).toBe(false);
	});

	it('uses the working directory by default and tolerates a project with no live files', () => {
		const root = fixture();
		const previous = process.cwd();
		try { process.chdir(root); expect(() => realtime.generateTypes()).not.toThrow(); }
		finally { process.chdir(previous); }
		expect(existsSync(join(root, 'src/live/$types.d.ts'))).toBe(false);
	});

	it('reports a stale output that cannot be removed instead of silently retaining it', () => {
		const root = fixture();
		mkdirSync(join(root, 'src/live/$types.d.ts'));
		expect(() => realtime.generateTypes({ root })).toThrow(/directory|EISDIR/i);
	});
});
