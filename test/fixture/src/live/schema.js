// Live module backing the schema-validation e2e tests.
//
//   submitForm({ text, count })   -> validated against a Zod-like schema
//                                    requiring text (1-100 chars) +
//                                    count (positive integer). Echoes the
//                                    received payload on success.
//   submitNested({ user, items }) -> validates nested shape; surfaces the
//                                    failing path so clients can render
//                                    field-level errors.

import { live } from 'svelte-realtime/server';

const flatSchema = {
	safeParse(input) {
		const issues = [];
		if (!input || typeof input !== 'object') {
			issues.push({ path: [], message: 'must be an object' });
			return { success: false, error: { issues } };
		}
		if (typeof input.text !== 'string') {
			issues.push({ path: ['text'], message: 'text must be a string' });
		} else if (input.text.length < 1 || input.text.length > 100) {
			issues.push({ path: ['text'], message: 'text length must be 1-100' });
		}
		if (typeof input.count !== 'number') {
			issues.push({ path: ['count'], message: 'count must be a number' });
		} else if (!Number.isInteger(input.count) || input.count <= 0) {
			issues.push({ path: ['count'], message: 'count must be a positive integer' });
		}
		if (issues.length) return { success: false, error: { issues } };
		return { success: true, data: input };
	}
};

const nestedSchema = {
	safeParse(input) {
		const issues = [];
		if (!input || typeof input !== 'object') {
			issues.push({ path: [], message: 'must be an object' });
			return { success: false, error: { issues } };
		}
		if (!input.user || typeof input.user !== 'object') {
			issues.push({ path: ['user'], message: 'user must be an object' });
		} else if (typeof input.user.name !== 'string') {
			issues.push({ path: ['user', 'name'], message: 'user.name must be a string' });
		}
		if (!Array.isArray(input.items)) {
			issues.push({ path: ['items'], message: 'items must be an array' });
		} else {
			for (let i = 0; i < input.items.length; i++) {
				if (typeof input.items[i] !== 'string') {
					issues.push({ path: ['items', i], message: 'each item must be a string' });
				}
			}
		}
		if (issues.length) return { success: false, error: { issues } };
		return { success: true, data: input };
	}
};

export const submitForm = live.validated(flatSchema, async (ctx, input) => {
	return { received: input, at: Date.now() };
});

export const submitNested = live.validated(nestedSchema, async (ctx, input) => {
	return { received: input };
});
