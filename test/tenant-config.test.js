import { expect, it } from 'vitest';
import { live } from '../src/server.js';

const policy = () => ({ metadata: { entitlement: 'pro', caps: { windowMs: 1000, actions: 10, bytes: 2048, recipientDeliveries: 50, storedBytes: 4096 } } });

it('stores a frozen copy of typed tenant metadata and exposes later validated declarations', () => {
	const input = policy();
	const tenant = live.tenant('metadata-owner', input);
	expect(tenant.config).toEqual(input);
	expect(tenant.config).not.toBe(input);
	expect(tenant.config.metadata).not.toBe(input.metadata);
	expect(tenant.config.metadata.caps).not.toBe(input.metadata.caps);
	for (const value of [tenant.config, tenant.config.metadata, tenant.config.metadata.caps]) expect(Object.isFrozen(value)).toBe(true);
	input.metadata.caps.actions = 999;
	expect(tenant.config.metadata.caps.actions).toBe(10);
	expect(() => { tenant.config.metadata.caps.actions = 999; }).toThrow(TypeError);
	live.tenant('metadata-owner', { metadata: { entitlement: 'free' } });
	expect(tenant.config).toEqual({ metadata: { entitlement: 'free' } });
	expect(live.tenant('metadata-empty', {}).config).toEqual({});
	expect(live.tenant('metadata-absent').config).toBeNull();
});

const invalid = [
	null, [], 1, 'metadata', new Date(), Object.create({ metadata: {} }),
	{ unknown: true }, { metadata: null }, { metadata: [] }, { metadata: { unknown: true } },
	{ metadata: { entitlement: 7 } }, { metadata: { entitlement: '' } }, { metadata: { entitlement: 'a'.repeat(65) } }, { metadata: { entitlement: 'pro plan' } },
	{ metadata: { caps: null } }, { metadata: { caps: [] } }, { metadata: { caps: {} } }, { metadata: { caps: { windowMs: 0 } } },
	{ metadata: { caps: { windowMs: '1000' } } }, { metadata: { caps: { windowMs: 1000, unknown: 1 } } },
	{ [Symbol('extra')]: true }, Object.defineProperty({}, 'hidden', { value: true })
];
for (const field of ['windowMs', 'actions', 'bytes', 'recipientDeliveries', 'storedBytes']) {
	for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10', false]) invalid.push({ metadata: { caps: { windowMs: 1000, [field]: value } } });
}
it.each(invalid.map((value, index) => [index, value]))('rejects invalid tenant metadata case %s without replacing a valid policy', (_index, value) => {
	const tenant = live.tenant('metadata-stable', policy());
	const previous = tenant.config;
	let error;
	try { live.tenant('metadata-stable', value); } catch (caught) { error = caught; }
	expect(error).toMatchObject({ code: 'VALIDATION' });
	expect(tenant.config).toBe(previous);
});

it('rejects accessors without executing configuration code', () => {
	let reads = 0;
	for (const config of [
		Object.defineProperty({}, 'metadata', { get() { reads++; return {}; } }),
		{ metadata: Object.defineProperty({}, 'entitlement', { get() { reads++; return 'pro'; } }) },
		{ metadata: { caps: Object.defineProperty({ windowMs: 1000 }, 'actions', { get() { reads++; return 1; } }) } }
	]) expect(() => live.tenant('metadata-accessor', config)).toThrow();
	expect(reads).toBe(0);
});

it('accepts zero declared caps and normalizes omitted fields', () => {
	const config = { metadata: { entitlement: undefined, caps: { windowMs: 1, actions: 0, bytes: 0, recipientDeliveries: 0, storedBytes: 0 } } };
	expect(live.tenant('metadata-zero', config).config).toEqual({ metadata: { caps: config.metadata.caps } });
});
