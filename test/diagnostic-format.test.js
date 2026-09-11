import { describe, expect, it } from 'vitest';
import { diagnosticErrorMessage, formatDiagnostic } from '../src/shared/diagnostic.js';

describe('diagnostic prefix contract', () => {
	it('matches the ecosystem formatter wire shape', () => {
		const line = formatDiagnostic({
			source: 'svelte-realtime',
			component: 'runtime.client',
			event: 'socket.closed',
			severity: 'warn',
			message: 'socket closed',
			attributes: { code: 1006 }
		});
		expect(line).toMatch(/^\[oss-realtime\/diagnostic source=svelte-realtime component=runtime\.client event=socket\.closed severity=warn\] socket closed /);
		const record = JSON.parse(line.slice(line.indexOf('{')));
		expect(record).toMatchObject({
			schemaVersion: 1,
			source: 'svelte-realtime',
			component: 'runtime.client',
			event: 'socket.closed',
			severity: 'warn',
			level: 'warn',
			dataClass: 'operational',
			attributes: { code: 1006 }
		});
	});

	it('keeps bridge diagnostics on one physical line', () => {
		const line = formatDiagnostic({
			source: 'svelte-realtime', component: 'runtime.client', event: 'socket.closed',
			severity: 'warn', message: 'closed', attributes: { value: 'a\u2028b\u2029c' }
		});
		expect(line).not.toContain('\u2028');
		expect(line).not.toContain('\u2029');
		expect(line).toContain('\\u2028');
		expect(line).toContain('\\u2029');
		expect(JSON.parse(line.slice(line.indexOf('{'))).attributes.value).toBe('a\u2028b\u2029c');
	});

	it('ASCII-escapes control, bidi, and right-to-left external values', () => {
		const hostile = String.fromCodePoint(0, 0x85, 0x202e, 0x2066, 0x5e9);
		const line = formatDiagnostic({
			source: 'svelte-realtime',
			component: 'runtime.client',
			event: 'socket.closed',
			severity: 'warn',
			message: 'external=' + hostile,
			attributes: { path: hostile }
		});
		expect(line).not.toMatch(/[\u0000-\u001f\u007f-\uffff]/);
		for (const escaped of ['\\u0000', '\\u0085', '\\u202e', '\\u2066', '\\u05e9']) {
			expect(line).toContain(escaped);
		}
		const record = JSON.parse(line.slice(line.indexOf('{')));
		expect(record.message).toBe('external=\\u0000\\u0085\\u202e\\u2066\\u05e9');
		expect(record.attributes.path).toBe(hostile);
	});

	it('contains thrown values whose accessors and string conversion also throw', () => {
		const hostile = new Proxy({}, {
			get() { throw new Error('getter failed'); }
		});
		expect(diagnosticErrorMessage(hostile)).toBe('Unknown error');
	});
});
