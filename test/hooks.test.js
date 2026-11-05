import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { realtimeTransport } from '../src/hooks.js';
import { LiveError } from '../src/server.js';
import { RpcError } from '../src/client.js';

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

describe('realtimeTransport() across module copies', () => {
	// Vite development runs svelte-realtime/server in Node while the shared
	// hooks module runs in the SSR graph, so an error from a live function
	// comes from a different evaluation of its class, and of the brand
	// module, than the one hooks imported. Node's own loader gives the test
	// that separate evaluation.
	const nativeImport = (path) => createRequire(import.meta.url)(fileURLToPath(new URL(path, import.meta.url)));

	it('encodes a LiveError created by another evaluation of its module', () => {
		const { LiveError: OtherLiveError } = nativeImport('../src/server/live-error.js');
		expect(OtherLiveError).not.toBe(LiveError);
		const transport = realtimeTransport();
		const error = new OtherLiveError('NOT_FOUND', 'Missing', { params: { id: 7 } });
		expect(transport.LiveError.encode(error)).toEqual(['NOT_FOUND', 'Missing', { params: { id: 7 } }]);
		expect(transport.RpcError.encode(error)).toBe(false);
	});

	it('encodes an RpcError created by another evaluation of its module', () => {
		const { RpcError: OtherRpcError } = nativeImport('../src/client/rpc-error.js');
		expect(OtherRpcError).not.toBe(RpcError);
		const transport = realtimeTransport();
		const error = new OtherRpcError('FORBIDDEN', 'Denied');
		error.issues = [{ path: ['a'] }];
		expect(transport.RpcError.encode(error)).toEqual(['FORBIDDEN', 'Denied', [{ path: ['a'] }], {}]);
		expect(transport.LiveError.encode(error)).toBe(false);
	});

	it('recognizes subclasses and ignores look-alike plain objects', () => {
		class Gone extends LiveError {}
		const transport = realtimeTransport();
		expect(transport.LiveError.encode(new Gone('GONE', 'Removed'))).toEqual(['GONE', 'Removed', {}]);
		expect(transport.LiveError.encode({ code: 'GONE', message: 'Removed', name: 'LiveError' })).toBe(false);
		expect(transport.RpcError.encode(Object.create(Error.prototype))).toBe(false);
	});

	it.each([['LiveError', LiveError], ['RpcError', RpcError]])('keeps the %s brand off own and enumerable keys', (_name, Ctor) => {
		const error = new Ctor('X', 'y');
		expect(Object.getOwnPropertySymbols(error)).toEqual([]);
		expect(Object.keys(error)).toEqual(['code']);
		expect(JSON.parse(JSON.stringify({ ...error }))).toEqual({ code: 'X' });
	});
});

for (const kind of ['LiveError', 'RpcError']) {
	it(`${kind} hydrates structured metadata and accepts older tuples`, () => {
		const Ctor = kind === 'LiveError' ? LiveError : RpcError;
		const transport = realtimeTransport()[kind];
		const metadata = { params: { count: 3 }, details: ['retry'] };
		const original = new Ctor('LIMIT', 'Limit reached', metadata);
		const decoded = transport.decode(transport.encode(original));
		expect(decoded).toMatchObject({ code: 'LIMIT', message: 'Limit reached', ...metadata });
		const old = transport.decode(['LIMIT', 'Old fallback']);
		expect(old.message).toBe('Old fallback');
		expect(old.params).toBeUndefined(); expect(old.details).toBeUndefined();
		const [code, message] = transport.encode(original);
		const legacyDecoded = new Ctor(code, message);
		expect(legacyDecoded.message).toBe('Limit reached');
	});
}
