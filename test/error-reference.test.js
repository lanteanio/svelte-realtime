import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import svelteRealtime from '../src/vite.js';
import { _buildCtx, _getCtxHelpers } from '../src/server/ctx.js';
import { LiveError } from '../src/server/live-error.js';
import {
	REALTIME_ERROR_IDS,
	REALTIME_ERROR_REGISTRY,
	realtimeErrorCode,
	realtimeErrorDefinition,
	realtimeErrorMessage
} from '../src/error-registry.js';
import {
	renderErrorReference,
	validateErrorRegistry
} from '../scripts/generate-error-reference.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { renderRuntimeInventory, scanRuntimeErrors } from '../scripts/runtime-error-inventory.js';

const read = (relative) => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');

describe('runtime error reference', () => {
	it('indexes legacy emitted codes and operational prefixes beyond the guidance registry', () => {
		const generated = renderErrorReference();
		expect(generated).toContain('id="live-error-rate-limited"');
		expect(generated).toContain('rpc.execution.non-live-error');
		expect(generated).toContain('Coverage listing only');
	});

	it('validates the owning registry and rejects unknown ids', () => {
		expect(validateErrorRegistry()).toEqual([]);
		expect(() => realtimeErrorDefinition('REALTIME-ERR-NOT-REGISTERED')).toThrow(
			/Unknown svelte-realtime error id/
		);
		expect(new Set(REALTIME_ERROR_REGISTRY.map((entry) => entry.id))).toEqual(
			new Set(Object.values(REALTIME_ERROR_IDS))
		);
	});

	it('keeps the shipped generated reference byte-exact', () => {
		const generated = read('docs/errors.md');
		expect(generated).toBe(renderErrorReference());
		for (const entry of REALTIME_ERROR_REGISTRY) {
			expect(generated).toContain('<a id="' + entry.anchor + '"></a>');
			expect(generated).toContain('`' + entry.messagePrefix + '`');
			expect(generated).toContain(entry.help);
		}
		expect(validateErrorRegistry([{
			...REALTIME_ERROR_REGISTRY[0],
			id: 'REALTIME-ERR-MISSING-SOURCE',
			anchor: 'realtime-err-missing-source',
			help: 'docs/errors.md#realtime-err-missing-source',
			messagePrefix: 'missing source',
			sources: ['src/not-present.js']
		}])).toContain('entry 0 has a missing or out-of-root source: src/not-present.js');
	});

	it('binds INVALID_USER_ID documentation to an actual ctx.signal failure', () => {
		const platform = mockPlatform();
		const ctx = _buildCtx(null, null, platform, _getCtxHelpers(platform), null);
		const definition = realtimeErrorDefinition(REALTIME_ERROR_IDS.INVALID_USER_ID);
		let thrown;
		try {
			ctx.signal('bad\nid', 'event', {});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(LiveError);
		expect(thrown.code).toBe(realtimeErrorCode(definition.id));
		expect(thrown.message.startsWith(definition.messagePrefix)).toBe(true);
		expect(thrown.message).toContain('[' + definition.id + ']');
		expect(thrown.message).toContain(definition.help);
		expect(platform.published).toEqual([]);
	});

	it('binds the $live resolution prefix to the actual Vite diagnostic', () => {
		const plugin = svelteRealtime({ dir: '__missing-error-reference__' });
		plugin.configResolved({
			root: fileURLToPath(new URL('.', import.meta.url)),
			build: {},
			command: 'build'
		});
		let emitted = '';
		const context = {
			error(message) {
				emitted = String(message);
				throw new Error(emitted);
			}
		};
		expect(() => plugin.load.call(context, '\0live:missing-module', { ssr: false })).toThrow();
		expect(emitted.startsWith(
			realtimeErrorDefinition(REALTIME_ERROR_IDS.LIVE_RESOLVE).messagePrefix
		)).toBe(true);
		expect(emitted).toContain(REALTIME_ERROR_IDS.LIVE_RESOLVE);
	});
});


describe('runtime emission inventory', () => {
	const scan = source => scanRuntimeErrors([{ path: 'src/example.js', source }]);
	it('parses code instead of comments and indexes literal, template, reply and registry-backed prefixes', () => {
		const inventory = scan([
			"// new LiveError('GHOST', 'not emitted')",
			"new LiveError('RATE_LIMITED', 'Wait for ' + seconds);",
			"new LiveError('RATE_LIMITED', `Retry ${seconds} seconds later`);",
			"new LiveError(realtimeErrorCode(REALTIME_ERROR_IDS.INVALID_USER_ID), realtimeErrorMessage(REALTIME_ERROR_IDS.INVALID_USER_ID));",
			"const reply = {ok:false, code:'NOT_FOUND', error:'No such endpoint'};",
			"new LiveError(computedCode, applicationMessage);"
		].join('\n'));
		expect(inventory.errors.map(row => row.key)).toEqual(['INVALID_USER_ID', 'NOT_FOUND', 'RATE_LIMITED']);
		expect(inventory.errors.find(row => row.key === 'RATE_LIMITED').prefixes).toEqual(['Retry ', 'Wait for ']);
		expect(inventory.errors.find(row => row.key === 'INVALID_USER_ID').prefixes).toEqual(['ctx.signal:']);
		expect(inventory.dynamicSites).toEqual(['src/example.js:6']);
	});

	it('indexes conditional operational events and keeps distinct event punctuation', () => {
		const inventory = scan([
			"emitOperationalEvent({component:'server', severity:'error', event: ready ? 'rpc.a' : 'rpc-a', message:'Could not send ' + name});",
			"console.warn('[svelte-realtime] alarm for ' + topic);"
		].join('\n'));
		expect(inventory.diagnostics).toHaveLength(3);
		expect(new Set(inventory.diagnostics.map(row => row.anchor)).size).toBe(3);
		expect(inventory.diagnostics.find(row => row.key === 'rpc.a').prefixes).toEqual(['Could not send ']);
		const changed = scan("emitOperationalEvent({component:'server', severity:'error', event:'rpc.a', message:'Changed wording'});");
		expect(changed.diagnostics[0].anchor).toBe(inventory.diagnostics.find(row => row.key === 'rpc.a').anchor);
	});

	it('lists unresolved conditional branches without losing known prefixes', () => {
		const inventory = scan("new LiveError(ready ? 'VALIDATION' : computedCode, ready ? 'Known ' + detail : message);");
		expect(inventory.errors[0].key).toBe('VALIDATION');
		expect(inventory.errors[0].prefixes).toEqual(['Known ']);
		expect(inventory.dynamicSites).toEqual(['src/example.js:1']);
	});

	it('lists a dynamic console branch alongside its known prefix', () => {
		const inventory = scan("console.warn(ready ? '[svelte-realtime] Known' : dynamicMessage);");
		expect(inventory.diagnostics[0].prefixes).toEqual(['[svelte-realtime] Known']);
		expect(inventory.dynamicSites).toEqual(['src/example.js:1']);
	});

	it('keeps source changes reviewable and escapes literal prefixes in generated Markdown', () => {
		const before = scan("new LiveError('VALIDATION', 'before');");
		const after = scan("new LiveError('VALIDATION', '<script>|after\\n');");
		expect(before.errors[0].anchor).toBe(after.errors[0].anchor);
		expect(renderRuntimeInventory(before)).not.toBe(renderRuntimeInventory(after));
		expect(renderRuntimeInventory(after)).toContain('&lt;script&gt;&#124;after\\n');
		expect(renderRuntimeInventory(after)).not.toContain('<script>');
	});
});
