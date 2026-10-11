import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { _generateClientStubs } from '../src/vite/codegen-client.js';
import { _extractFunctionTimeout } from '../src/vite/extract-options.js';
import { live } from '../src/server.js';

describe('function timeout declarations', () => {
	it('generates budgets for RPC, wrapped RPC, static/dynamic streams and uploads', () => {
		const dir = mkdtempSync(join(import.meta.dirname, 'timeout-fixture-'));
		try {
			const file = join(dir, 'budget.js');
			writeFileSync(file, `// realtime-allow-public
const budget = 300_000;
const options = { timeout: budget };
export const slow = live(async () => 1, options);
export const normal = live(async () => ({ timeout: 20 }));
export const wrapped = live.public(live(async () => 2, { ...options, timeout: 400_000 }));
export const feed = live.stream('feed', async () => [], options);
export const dynamic = live.stream((id) => 'feed:' + id, async () => [], options);
export const upload = live.upload(async () => 1, options);
`);
			const code = _generateClientStubs(file, 'budget', dir);
			expect(code).toContain('__rpc("budget/slow", {"timeout":300000})');
			expect(code).toContain('__rpc("budget/normal")');
			expect(code).toContain('__rpc("budget/wrapped", {"timeout":400000})');
			expect(code).toMatch(/__stream\("budget\/feed", \{[^\n]*"timeout":300000/);
			expect(code).toMatch(/__stream\("budget\/dynamic", \{[^\n]*"timeout":300000[^\n]*true\)/);
			expect(code).toContain('__upload("budget/upload", {"timeout":300000})');
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it.each(['0', '-1', 'Infinity', 'NaN', '2147483648', '"300000"', 'getBudget()'])('rejects unsupported declared budget %s', (value) => {
		expect(() => _extractFunctionTimeout(`export const slow = live(() => 1, { timeout: ${value} });`, 'slow')).toThrow();
	});

	it('keeps existing dynamic options without an explicit timeout compatible', () => {
		expect(_extractFunctionTimeout('export const feed = live.stream("feed", () => [], getOptions());', 'feed')).toBeUndefined();
		expect(_extractFunctionTimeout('export const feed = live.stream("feed", () => [], { ...getOptions(), merge: "set" });', 'feed')).toBeUndefined();
	});

	it('honors duplicate keys and refuses unknown spreads that may override a budget', () => {
		expect(_extractFunctionTimeout('export const slow = live(() => 1, { timeout: 10, timeout: 20 });', 'slow')).toBe(20);
		expect(() => _extractFunctionTimeout('export const slow = live(() => 1, { timeout: 10, ...unknown });', 'slow')).toThrow();
		expect(_extractFunctionTimeout('export const slow = live(() => 1, { ...unknown, timeout: 20 });', 'slow')).toBe(20);
	});

	it.each([0, -1, Infinity, NaN, 2147483648, 1.5])('validates runtime registrations for %s', (timeout) => {
		expect(() => live(() => 1, { timeout })).toThrow(/timeout/);
		expect(() => live.stream('feed', () => [], { timeout })).toThrow(/timeout/);
		expect(() => live.upload(() => 1, { timeout })).toThrow(/timeout/);
	});
});
