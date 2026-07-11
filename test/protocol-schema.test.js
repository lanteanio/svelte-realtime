// The published extension-frame schema (protocol.schema.json) must accept
// exactly the frames this package emits on the wire and reject shapes it
// never sends - it is the composable companion to the adapter's core
// protocol schema, and a consumer validating mixed traffic trusts it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const schema = JSON.parse(readFileSync(new URL('../protocol.schema.json', import.meta.url), 'utf8'));

// Minimal validator for exactly the subset the schema uses: oneOf over
// $defs refs, type: object, required, const, and type: number. Additional
// properties are permitted by construction.
function matchesDef(def, value) {
	if (def.type === 'object') {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
		for (const key of def.required || []) {
			if (!(key in value)) return false;
		}
		for (const [key, prop] of Object.entries(def.properties || {})) {
			if (key in value && !matchesDef(prop, value[key])) return false;
		}
		return true;
	}
	if ('const' in def) return value === def.const;
	if (def.type === 'number') return typeof value === 'number';
	throw new Error('schema uses a construct this test validator does not cover: ' + JSON.stringify(def));
}

function validates(frame) {
	return schema.oneOf.some((ref) => {
		const name = ref.$ref.replace('#/$defs/', '');
		return matchesDef(schema.$defs[name], frame);
	});
}

describe('protocol.schema.json (svelte-realtime extension frames)', () => {
	it('accepts the proto advertisement exactly as the client emits it', () => {
		// The shape sent by the client after connect: { type: 'proto', v }.
		expect(validates({ type: 'proto', v: 1 })).toBe(true);
		expect(validates({ type: 'proto', v: 7 })).toBe(true);
	});

	it('permits unknown additional fields (forward compatibility)', () => {
		expect(validates({ type: 'proto', v: 2, future: 'field' })).toBe(true);
	});

	it('rejects frames this package never sends', () => {
		expect(validates({ type: 'proto' })).toBe(false); // v is required
		expect(validates({ type: 'proto', v: 'one' })).toBe(false); // v is a number
		expect(validates({ type: 'subscribe', topic: 't' })).toBe(false); // core frame, adapter schema's job
		expect(validates({})).toBe(false);
	});

	it('every oneOf branch resolves to a $defs entry', () => {
		for (const ref of schema.oneOf) {
			const name = ref.$ref.replace('#/$defs/', '');
			expect(schema.$defs[name]).toBeDefined();
		}
	});
});
