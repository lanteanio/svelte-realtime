import { it, expect } from 'vitest';
import ts from 'typescript';
import { resolve } from 'node:path';

it('accepts typed smooth snapshot options and rejects invalid values', () => {
	const file = resolve(import.meta.dirname, 'smooth-config-consumer.ts').replaceAll('\\', '/');
	const source = `
import { live, type SmoothConfig } from '../src/server.js';
const config: SmoothConfig = {
  topic: 'positions', apply: (state) => state, initial: {},
  snapshot: true, snapshotDebounceMs: 250
};
live.smooth(config);
live.smooth({ topic: 'positions', apply: (state) => state, initial: {}, snapshot: false });
// @ts-expect-error snapshots are enabled with a boolean
const invalidSnapshot: SmoothConfig = { ...config, snapshot: 'true' };
// @ts-expect-error the cadence is numeric
const invalidCadence: SmoothConfig = { ...config, snapshotDebounceMs: '250' };
void invalidSnapshot; void invalidCadence;
`;
	const options = {
		noEmit: true, strict: true, skipLibCheck: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler
	};
	const host = ts.createCompilerHost(options);
	const getSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (name, ...args) => name === file
		? ts.createSourceFile(name, source, options.target, true)
		: getSourceFile(name, ...args);
	const program = ts.createProgram([file], options, host);
	const diagnostics = ts.getPreEmitDiagnostics(program)
		.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
	expect(diagnostics).toEqual([]);
});
