import { describe, it, expect } from 'vitest';
import { realtimeTransport } from '../hooks.js';
import { LiveError } from '../server.js';
import { RpcError } from '../client.js';

describe('realtimeTransport()', () => {
	it('returns an object with RpcError and LiveError entries', () => {
		const transport = realtimeTransport();
		expect(typeof transport.RpcError.encode).toBe('function');
		expect(typeof transport.RpcError.decode).toBe('function');
		expect(typeof transport.LiveError.encode).toBe('function');
		expect(typeof transport.LiveError.decode).toBe('function');
	});

	it('RpcError encode round-trips through decode', () => {
		const transport = realtimeTransport();
		const original = new RpcError('FORBIDDEN', 'Access denied');

		const encoded = transport.RpcError.encode(original);
		expect(Array.isArray(encoded)).toBe(true);
		expect(encoded[0]).toBe('FORBIDDEN');
		expect(encoded[1]).toBe('Access denied');

		const decoded = transport.RpcError.decode(encoded);
		expect(decoded).toBeInstanceOf(RpcError);
		expect(decoded.code).toBe('FORBIDDEN');
		expect(decoded.message).toBe('Access denied');
	});

	it('RpcError encode preserves the optional issues field', () => {
		const transport = realtimeTransport();
		const issues = [{ path: ['email'], message: 'Invalid email' }];
		const original = new RpcError('VALIDATION', 'Validation failed');
		original.issues = issues;

		const encoded = transport.RpcError.encode(original);
		const decoded = transport.RpcError.decode(encoded);
		expect(decoded.issues).toEqual(issues);
	});

	it('RpcError encode returns false for non-RpcError values', () => {
		const transport = realtimeTransport();
		expect(transport.RpcError.encode(new Error('plain'))).toBe(false);
		expect(transport.RpcError.encode('string')).toBe(false);
		expect(transport.RpcError.encode(null)).toBe(false);
		expect(transport.RpcError.encode(42)).toBe(false);
		expect(transport.RpcError.encode({ code: 'NOT_AN_INSTANCE' })).toBe(false);
	});

	it('LiveError encode round-trips through decode', () => {
		const transport = realtimeTransport();
		const original = new LiveError('UNAUTHENTICATED', 'Sign in required');

		const encoded = transport.LiveError.encode(original);
		expect(encoded[0]).toBe('UNAUTHENTICATED');
		expect(encoded[1]).toBe('Sign in required');

		const decoded = transport.LiveError.decode(encoded);
		expect(decoded).toBeInstanceOf(LiveError);
		expect(decoded.code).toBe('UNAUTHENTICATED');
		expect(decoded.message).toBe('Sign in required');
	});

	it('LiveError encode returns false for non-LiveError values (and non-RpcError)', () => {
		const transport = realtimeTransport();
		expect(transport.LiveError.encode(new Error('plain'))).toBe(false);
		expect(transport.LiveError.encode(new RpcError('FORBIDDEN', 'x'))).toBe(false);
		expect(transport.LiveError.encode(null)).toBe(false);
	});

	it('preserves the message-falls-back-to-code default for empty messages', () => {
		const transport = realtimeTransport();
		const original = new LiveError('FORBIDDEN');
		const encoded = transport.LiveError.encode(original);
		const decoded = transport.LiveError.decode(encoded);
		expect(decoded.code).toBe('FORBIDDEN');
		// Constructor default: super(message || code), so message === code
		expect(decoded.message).toBe('FORBIDDEN');
	});

	it('composes with extras (user entries appear alongside defaults)', () => {
		class Vector { constructor(x, y) { this.x = x; this.y = y; } }
		const transport = realtimeTransport({
			Vector: {
				encode: (v) => v instanceof Vector && [v.x, v.y],
				decode: ([x, y]) => new Vector(x, y)
			}
		});
		expect(typeof transport.RpcError).toBe('object');
		expect(typeof transport.LiveError).toBe('object');
		expect(typeof transport.Vector).toBe('object');

		const v = new Vector(3, 4);
		const enc = transport.Vector.encode(v);
		const dec = transport.Vector.decode(enc);
		expect(dec).toBeInstanceOf(Vector);
		expect(dec.x).toBe(3);
		expect(dec.y).toBe(4);
	});

	it('lets user extras override the built-in entries (key conflict wins for extras)', () => {
		const customRpcEncode = () => ['CUSTOM'];
		const transport = realtimeTransport({
			RpcError: {
				encode: customRpcEncode,
				decode: (encoded) => ({ custom: encoded })
			}
		});
		expect(transport.RpcError.encode).toBe(customRpcEncode);
	});

	it('rejects non-object extras', () => {
		expect(() => realtimeTransport('not-an-object')).toThrow(/extras must be an object/);
		expect(() => realtimeTransport(42)).toThrow(/extras must be an object/);
	});

	it('rejects malformed extra entries (missing encode or decode)', () => {
		expect(() => realtimeTransport({ Bad: { encode: () => true } })).toThrow(/Bad.*encode, decode/);
		expect(() => realtimeTransport({ Bad: { decode: () => null } })).toThrow(/Bad.*encode, decode/);
		expect(() => realtimeTransport({ Bad: null })).toThrow(/Bad.*encode, decode/);
		expect(() => realtimeTransport({ Bad: { encode: 'fn', decode: 'fn' } })).toThrow(/Bad.*encode, decode/);
	});

	it('returns the same default-only object reference is NOT guaranteed (fresh each call)', () => {
		const a = realtimeTransport();
		const b = realtimeTransport();
		expect(a).not.toBe(b);
		expect(a.RpcError).not.toBe(b.RpcError);
	});
});
