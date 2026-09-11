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

const read = (relative) => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');

describe('runtime error reference', () => {
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
