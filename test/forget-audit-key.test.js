import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { configureForget, live, _resetForget } from '../src/server.js';
import { _pushRegistry } from '../src/server/push.js';

const userId = 'account@example.test';
const keyA = 'a'.repeat(32);
const keyB = 'b'.repeat(32);
const unkeyed = createHash('sha256').update(userId).digest('hex').slice(0, 32);
const keyed = key => createHmac('sha256', key).update(userId).digest('hex').slice(0, 32);
async function record(options = {}) {
	let result;
	await live.forget(userId, { ...options, onForget(value) { result = value; } });
	return result;
}
beforeEach(() => { _resetForget(); _pushRegistry.clear(); });
afterEach(() => { _resetForget(); _pushRegistry.clear(); });

it('preserves the default pseudonymous identifier and audit record shape', async () => {
	const audit = await record();
	expect(audit.userIdHash).toBe(unkeyed);
	expect(Object.keys(audit).sort()).toEqual(['at', 'cascade', 'rowsAffected', 'surfaces', 'tenantId', 'userIdHash']);
	expect(JSON.stringify(audit)).not.toContain(userId);
});

it('configures a stable HMAC identifier with different identifiers for different keys', async () => {
	configureForget({ hashKey: keyA });
	expect((await record()).userIdHash).toBe(keyed(keyA));
	expect((await record()).userIdHash).toBe(keyed(keyA));
	expect(keyed(keyA)).not.toBe(unkeyed);
	configureForget({ hashKey: keyB });
	expect((await record()).userIdHash).toBe(keyed(keyB));
	expect(keyed(keyB)).not.toBe(keyed(keyA));
});

it('supports per-call overrides and explicit unkeyed calls without changing the default', async () => {
	configureForget({ hashKey: keyA });
	expect((await record({ hashKey: keyB })).userIdHash).toBe(keyed(keyB));
	expect((await record({ hashKey: null })).userIdHash).toBe(unkeyed);
	expect((await record()).userIdHash).toBe(keyed(keyA));
	configureForget({ hashKey: null });
	expect((await record()).userIdHash).toBe(unkeyed);
	configureForget({ hashKey: keyA });
	configureForget(null);
	expect((await record()).userIdHash).toBe(unkeyed);
});

it('owns configured byte keys and captures the key chosen when erasure starts', async () => {
	const bytes = new Uint8Array(32).fill(9);
	const expected = keyed(bytes);
	configureForget({ hashKey: bytes });
	bytes.fill(0);
	const pending = record();
	configureForget({ hashKey: keyB });
	expect((await pending).userIdHash).toBe(expected);
	expect((await record()).userIdHash).toBe(keyed(keyB));
});

it('captures per-call byte keys before yielding to asynchronous erasure', async () => {
	const bytes = new Uint8Array(32).fill(7);
	const expected = keyed(bytes);
	const pending = record({ hashKey: bytes });
	bytes.fill(0);
	expect((await pending).userIdHash).toBe(expected);
});

it('uses literal UTF-8 and exact byte-view contents as the HMAC key', async () => {
	const text = '\u00e9'.repeat(16);
	expect((await record({ hashKey: text })).userIdHash).toBe(keyed(text));
	const bytes = Buffer.alloc(64, 1);
	bytes.fill(2, 16, 48);
	expect((await record({ hashKey: bytes.subarray(16, 48) })).userIdHash).toBe(keyed(bytes.subarray(16, 48)));
});

it('rejects invalid call keys before any in-memory or durable erasure even without a hook', async () => {
	const purgeUser = vi.fn(async () => 0);
	configureForget({ store: { purgeUser } });
	_pushRegistry.set(userId, { ws: {}, platform: {} });
	for (const hashKey of ['', 'short-secret', new Uint8Array(31), 42, {}, [], true]) {
		await expect(live.forget(userId, { hashKey })).rejects.toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringContaining('hashKey') });
		expect(_pushRegistry.has(userId)).toBe(true);
	}
	expect(purgeUser).not.toHaveBeenCalled();
});

it('validates a configuration atomically without replacing its working store or key', async () => {
	const original = vi.fn(async () => 0);
	const replacement = vi.fn(async () => 0);
	configureForget({ store: { purgeUser: original }, hashKey: keyA });
	expect(() => configureForget({ store: { purgeUser: replacement }, hashKey: 'short-secret' })).toThrow(/hashKey/);
	expect(() => configureForget({ store: {}, hashKey: keyB })).toThrow(/purgeUser/);
	const audit = await record();
	expect(audit.userIdHash).toBe(keyed(keyA));
	expect(original).toHaveBeenCalledOnce();
	expect(replacement).not.toHaveBeenCalled();
	expect(JSON.stringify(audit)).not.toContain(keyA);
});
