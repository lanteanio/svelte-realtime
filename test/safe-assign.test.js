import { describe, it, expect } from 'vitest';
import {
	PROTO_POLLUTION_KEYS,
	safeAssign,
	sanitizeRowData,
	assertSafeMergeKey
} from '../shared/safe-assign.js';

describe('shared/safe-assign', () => {
	describe('PROTO_POLLUTION_KEYS', () => {
		it('contains exactly the three dangerous keys', () => {
			expect(PROTO_POLLUTION_KEYS).toEqual(['__proto__', 'constructor', 'prototype']);
		});

		it('is frozen so a future contributor cannot widen it', () => {
			expect(Object.isFrozen(PROTO_POLLUTION_KEYS)).toBe(true);
		});
	});

	describe('safeAssign', () => {
		it('copies own enumerable properties from src into dst', () => {
			const dst = { existing: 1 };
			const src = { a: 1, b: 2 };
			const result = safeAssign(dst, src);
			expect(result).toBe(dst);
			expect(dst).toEqual({ existing: 1, a: 1, b: 2 });
		});

		it('skips __proto__ as own property', () => {
			const dst = {};
			const src = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
			safeAssign(dst, src);
			expect(dst).toEqual({ safe: 1 });
			// Proof: Object.prototype was not polluted.
			expect(({}).polluted).toBeUndefined();
		});

		it('skips constructor and prototype keys', () => {
			const dst = {};
			const src = { constructor: 'evil', prototype: 'also evil', safe: 1 };
			safeAssign(dst, src);
			expect(Object.prototype.hasOwnProperty.call(dst, 'constructor')).toBe(false);
			expect(Object.prototype.hasOwnProperty.call(dst, 'prototype')).toBe(false);
			expect(dst).toEqual({ safe: 1 });
		});

		it('overrides existing values on dst (last-write-wins semantics)', () => {
			const dst = { a: 1, b: 2 };
			safeAssign(dst, { b: 99, c: 3 });
			expect(dst).toEqual({ a: 1, b: 99, c: 3 });
		});
	});

	describe('sanitizeRowData', () => {
		it('returns primitives unchanged', () => {
			expect(sanitizeRowData(42)).toBe(42);
			expect(sanitizeRowData('hello')).toBe('hello');
			expect(sanitizeRowData(true)).toBe(true);
			expect(sanitizeRowData(null)).toBe(null);
			expect(sanitizeRowData(undefined)).toBe(undefined);
		});

		it('returns clean plain objects by reference (no allocation when safe)', () => {
			const data = { id: 'a', name: 'Alice', payload: { nested: true } };
			const result = sanitizeRowData(data);
			expect(result).toBe(data);
		});

		it('strips __proto__ from plain objects, returning a clone', () => {
			const data = JSON.parse('{"id":"a","__proto__":{"polluted":true}}');
			const result = sanitizeRowData(data);
			expect(result).not.toBe(data);
			expect(result.id).toBe('a');
			expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
		});

		it('strips constructor as own property', () => {
			const data = { id: 'a', constructor: 'evil' };
			const result = sanitizeRowData(data);
			expect(result).not.toBe(data);
			expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
			expect(result.id).toBe('a');
		});

		it('strips prototype as own property', () => {
			const data = { id: 'a', prototype: 'evil' };
			const result = sanitizeRowData(data);
			expect(result).not.toBe(data);
			expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(false);
			expect(result.id).toBe('a');
		});

		it('processes arrays element-by-element', () => {
			const data = [
				{ id: 'a' },
				JSON.parse('{"id":"b","__proto__":{"x":1}}'),
				{ id: 'c' }
			];
			const result = sanitizeRowData(data);
			expect(result).not.toBe(data);
			expect(result[0]).toBe(data[0]);
			expect(result[1]).not.toBe(data[1]);
			expect(Object.prototype.hasOwnProperty.call(result[1], '__proto__')).toBe(false);
			expect(result[2]).toBe(data[2]);
		});

		it('returns the original array if no element needs sanitizing', () => {
			const data = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
			const result = sanitizeRowData(data);
			expect(result).toBe(data);
		});

		it('leaves Date, Map, Set unchanged (non-plain objects)', () => {
			const d = new Date('2026-01-01');
			const m = new Map([['a', 1]]);
			const s = new Set([1, 2, 3]);
			expect(sanitizeRowData(d)).toBe(d);
			expect(sanitizeRowData(m)).toBe(m);
			expect(sanitizeRowData(s)).toBe(s);
		});

		it('leaves Object.create(null) objects unchanged (still safe to spread)', () => {
			const ud = Object.create(null);
			ud.id = 'a';
			expect(sanitizeRowData(ud)).toBe(ud);
		});

		it('does not crash on objects containing all three danger keys', () => {
			const data = JSON.parse('{"id":"a","__proto__":{},"constructor":"x","prototype":"y","name":"Alice"}');
			const result = sanitizeRowData(data);
			expect(result.id).toBe('a');
			expect(result.name).toBe('Alice');
			expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
			expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
			expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(false);
		});

		it('verifies prototype-pollution PoC is blocked end-to-end', () => {
			// A target object that a future Object.assign might use.
			const target = {};
			// Wire-shape envelope an attacker could send via a CRUD created event.
			const wireBytes = '{"id":"victim","__proto__":{"polluted":"yes"}}';
			const parsed = JSON.parse(wireBytes);

			const sanitized = sanitizeRowData(parsed);
			Object.assign(target, sanitized);
			expect(target.polluted).toBeUndefined();
			// Sanity: nothing else leaked into Object.prototype.
			expect(({}).polluted).toBeUndefined();
		});
	});

	describe('assertSafeMergeKey', () => {
		it('passes for safe string keys', () => {
			expect(() => assertSafeMergeKey('a')).not.toThrow();
			expect(() => assertSafeMergeKey('user-123')).not.toThrow();
			expect(() => assertSafeMergeKey('')).not.toThrow();
		});

		it('passes for non-string keys (numbers, etc.)', () => {
			expect(() => assertSafeMergeKey(42)).not.toThrow();
			expect(() => assertSafeMergeKey(null)).not.toThrow();
			expect(() => assertSafeMergeKey(undefined)).not.toThrow();
		});

		it('throws for the three danger strings', () => {
			expect(() => assertSafeMergeKey('__proto__')).toThrow('unsafe merge key');
			expect(() => assertSafeMergeKey('constructor')).toThrow('unsafe merge key');
			expect(() => assertSafeMergeKey('prototype')).toThrow('unsafe merge key');
		});
	});
});
