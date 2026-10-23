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
	validateErrorRegistry,
	validateGuidance
} from '../scripts/generate-error-reference.js';
import { CODE_GUIDANCE, EVENT_GUIDANCE } from '../scripts/error-guidance.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { isInformational, runtimeSources, scanRuntimeErrors } from '../scripts/runtime-error-inventory.js';

const read = (relative) => readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
const guidance = (text) => ({ cause: text, consequence: text, automaticRecovery: text, nextAction: text });

describe('runtime error reference', () => {
	it('gives every emitted code and failure event full guidance', () => {
		const inventory = scanRuntimeErrors();
		expect(validateGuidance(inventory)).toEqual([]);
		const generated = renderErrorReference();
		for (const row of inventory.errors) {
			const section = generated.slice(generated.indexOf('<a id="' + row.anchor + '"></a>'));
			expect(section.split('\n').slice(0, 7).join('\n'), row.key).toContain('- Cause: ' + CODE_GUIDANCE[row.key].cause);
		}
		for (const row of inventory.diagnostics.filter((entry) => entry.kind === 'structured event' && !isInformational(entry))) {
			expect(generated, row.key).toContain('- Next action: ' + EVENT_GUIDANCE[row.key].nextAction);
		}
		expect(generated).toContain('id="live-error-invalid-user-id"');
		expect(generated).toContain('id="diagnostic-rpc.execution.non-live-error"');
		expect(generated).toContain('Listing only');
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

describe('guidance gate', () => {
	const withExtra = (source) => scanRuntimeErrors([...runtimeSources(), { path: 'src/example.js', source }]);

	it('refuses a new runtime code until it has guidance', () => {
		const inventory = withExtra("new LiveError('BRAND_NEW_CODE', 'Something new');");
		expect(validateGuidance(inventory)).toEqual([
			'runtime code BRAND_NEW_CODE (emitted in src/example.js) has no CODE_GUIDANCE entry in scripts/error-guidance.js'
		]);
		expect(() => renderErrorReference(undefined, inventory)).toThrow(/BRAND_NEW_CODE/);
		const codes = { ...CODE_GUIDANCE, BRAND_NEW_CODE: guidance('Documented.') };
		expect(renderErrorReference(undefined, inventory, codes)).toContain('id="live-error-brand-new-code"');
	});

	it('refuses a new failure event until it has guidance, but lists a new informational event', () => {
		const failure = withExtra("emitOperationalEvent({ component: 'x', event: 'brand.new.failed', severity: 'error', message: 'Broke' });");
		expect(validateGuidance(failure)).toEqual([
			'event brand.new.failed (severity error, emitted in src/example.js) has no EVENT_GUIDANCE entry in scripts/error-guidance.js'
		]);
		const unresolved = withExtra("emitOperationalEvent({ component: 'x', event: 'brand.new.failed', severity: level, message: 'Broke' });");
		expect(validateGuidance(unresolved)).toHaveLength(1);
		const info = withExtra("emitOperationalEvent({ component: 'x', event: 'brand.new.started', severity: 'info', message: 'Started' });");
		expect(validateGuidance(info)).toEqual([]);
		expect(renderErrorReference(undefined, info)).toContain('id="diagnostic-brand.new.started"');
	});

	it('refuses guidance for a code or event nothing emits', () => {
		const inventory = scanRuntimeErrors();
		expect(validateGuidance(inventory, { ...CODE_GUIDANCE, GHOST: guidance('x') })).toEqual([
			'CODE_GUIDANCE.GHOST documents a code that nothing in src emits'
		]);
		expect(validateGuidance(inventory, CODE_GUIDANCE, { ...EVENT_GUIDANCE, 'ghost.event': guidance('x') })).toEqual([
			'EVENT_GUIDANCE["ghost.event"] documents an event that nothing in src emits'
		]);
	});

	it('refuses incomplete or non-ASCII guidance', () => {
		const inventory = scanRuntimeErrors();
		const [first] = Object.keys(CODE_GUIDANCE);
		const errors = validateGuidance(inventory, {
			...CODE_GUIDANCE,
			[first]: { ...CODE_GUIDANCE[first], nextAction: 'Retry ' + String.fromCharCode(0x2014) + ' later', automaticRecovery: '' }
		});
		expect(errors).toContain('CODE_GUIDANCE["' + first + '"] is missing automaticRecovery');
		expect(errors).toContain('CODE_GUIDANCE["' + first + '"].nextAction must be printable ASCII');
	});

	it('renders the same reference when unrelated lines move in a runtime source', () => {
		const files = runtimeSources();
		const shifted = files.map((file) => file.path === 'src/client/stream.js' || file.path === 'src/server/dispatch.js'
			? { ...file, source: '// moved\n\n\n' + file.source.replace('\n', '\n\n// unrelated\n') }
			: file);
		expect(renderErrorReference(undefined, scanRuntimeErrors(shifted))).toBe(renderErrorReference(undefined, scanRuntimeErrors(files)));
	});
});

describe('runtime emission inventory', () => {
	const scan = source => scanRuntimeErrors([{ path: 'src/example.js', source }]);
	it('parses code instead of comments and indexes literal, template, reply and registry-backed messages', () => {
		const inventory = scan([
			"// new LiveError('GHOST', 'not emitted')",
			"new LiveError('RATE_LIMITED', 'Wait for ' + seconds);",
			"new LiveError('RATE_LIMITED', `Retry ${seconds} seconds later`);",
			"new LiveError(realtimeErrorCode(REALTIME_ERROR_IDS.INVALID_USER_ID), realtimeErrorMessage(REALTIME_ERROR_IDS.INVALID_USER_ID));",
			"const reply = {ok:false, code:'NOT_FOUND', error:'No such endpoint'};",
			"function handle() { new LiveError(computedCode, applicationMessage); }"
		].join('\n'));
		expect(inventory.errors.map(row => row.key)).toEqual(['INVALID_USER_ID', 'NOT_FOUND', 'RATE_LIMITED']);
		expect(inventory.errors.find(row => row.key === 'RATE_LIMITED').prefixes).toEqual(['Retry <seconds> seconds later', 'Wait for <seconds>']);
		expect(inventory.errors.find(row => row.key === 'INVALID_USER_ID').prefixes).toEqual(['ctx.signal:']);
		expect(inventory.dynamicSites).toEqual([{ path: 'src/example.js', scope: 'handle()', kind: 'new LiveError', count: 1 }]);
	});

	it('renders whole messages with named placeholders instead of only the leading literal', () => {
		const inventory = scan([
			"new RpcError('TIMEOUT', `RPC '${path}' timed out after ${Math.round(ms / 1000)}s`);",
			"new RpcError('TIMEOUT', 'Batch ' + call.rpc + ' timed out after ' + (attempt + 1) + ' tries');"
		].join('\n'));
		expect(inventory.errors[0].prefixes).toEqual([
			'Batch <rpc> timed out after <value> tries',
			"RPC '<path>' timed out after <value>s"
		]);
	});

	it('indexes the literal side of a fallback as code and message', () => {
		const inventory = scan("function onReply(data) { return new RpcError(data.code || 'UNKNOWN', data.error ?? 'Unknown error'); }");
		expect(inventory.errors.map(row => [row.key, row.prefixes])).toEqual([['UNKNOWN', ['Unknown error']]]);
		expect(inventory.dynamicSites).toEqual([{ path: 'src/example.js', scope: 'onReply()', kind: 'new RpcError', count: 1 }]);
	});

	it('keys dynamic sites by enclosing function, kind and count, never by line', () => {
		const source = [
			'class Pool {',
			'  drain() { items.forEach((item) => { throw new LiveError(item.code, item.message); }); }',
			'}',
			'const settle = () => { new LiveError(code, msg); new LiveError(other, msg); };',
			'handlers.fail = function () { console.warn(message); };'
		].join('\n');
		const sites = scan(source).dynamicSites;
		expect(sites).toEqual([
			{ path: 'src/example.js', scope: 'drain()', kind: 'new LiveError', count: 1 },
			{ path: 'src/example.js', scope: 'fail()', kind: 'console.warn', count: 1 },
			{ path: 'src/example.js', scope: 'settle()', kind: 'new LiveError', count: 2 }
		]);
		expect(scan('\n\n// moved\n' + source).dynamicSites).toEqual(sites);
	});

	it('indexes conditional operational events and keeps distinct event punctuation', () => {
		const inventory = scan([
			"emitOperationalEvent({component:'server', severity:'error', event: ready ? 'rpc.a' : 'rpc-a', message:'Could not send ' + name});",
			"console.warn('[svelte-realtime] alarm for ' + topic);"
		].join('\n'));
		expect(inventory.diagnostics).toHaveLength(3);
		expect(new Set(inventory.diagnostics.map(row => row.anchor)).size).toBe(3);
		expect(inventory.diagnostics.find(row => row.key === 'rpc.a').prefixes).toEqual(['Could not send <name>']);
		const changed = scan("emitOperationalEvent({component:'server', severity:'error', event:'rpc.a', message:'Changed wording'});");
		expect(changed.diagnostics[0].anchor).toBe(inventory.diagnostics.find(row => row.key === 'rpc.a').anchor);
	});

	it('pairs an event conditional with a severity conditional on the same test', () => {
		const inventory = scan("emitOperationalEvent({component:'x', event: late ? 'drain.timed-out' : 'drain.completed', severity: late ? 'warn' : 'info', message:'Drain'});");
		expect(inventory.diagnostics.map(row => [row.key, row.severities, isInformational(row)])).toEqual([
			['drain.completed', ['info'], true],
			['drain.timed-out', ['warn'], false]
		]);
		const unpaired = scan("emitOperationalEvent({component:'x', event: late ? 'drain.timed-out' : 'drain.completed', severity: slow ? 'warn' : 'info', message:'Drain'});");
		expect(unpaired.diagnostics.every(row => !isInformational(row))).toBe(true);
	});

	it('lists unresolved conditional branches without losing known messages', () => {
		const inventory = scan("new LiveError(ready ? 'VALIDATION' : computedCode, ready ? 'Known ' + detail : message);");
		expect(inventory.errors[0].key).toBe('VALIDATION');
		expect(inventory.errors[0].prefixes).toEqual(['Known <detail>']);
		expect(inventory.dynamicSites).toEqual([{ path: 'src/example.js', scope: 'module scope', kind: 'new LiveError', count: 1 }]);
	});

	it('lists a dynamic console branch alongside its known text', () => {
		const inventory = scan("console.warn(ready ? '[svelte-realtime] Known' : dynamicMessage);");
		expect(inventory.diagnostics[0].prefixes).toEqual(['[svelte-realtime] Known']);
		expect(inventory.dynamicSites).toEqual([{ path: 'src/example.js', scope: 'module scope', kind: 'console.warn', count: 1 }]);
	});

	it('keeps code anchors stable and escapes literal messages in generated Markdown', () => {
		const render = (source) => {
			const inventory = scan(source);
			return { inventory, text: renderErrorReference([], inventory, { VALIDATION: guidance('Documented.') }, {}) };
		};
		const before = render("new LiveError('VALIDATION', 'before');");
		const after = render("new LiveError('VALIDATION', '<script>|after\\n');");
		expect(before.inventory.errors[0].anchor).toBe(after.inventory.errors[0].anchor);
		expect(before.text).not.toBe(after.text);
		expect(after.text).toContain('&lt;script&gt;&#124;after\\n');
		expect(after.text).not.toContain('<script>');
	});
});

describe('client and plain error coverage', () => {
	it('indexes emitted client codes and lock errors with their literal messages', () => {
		const inventory = scanRuntimeErrors();
		const row = (code) => inventory.errors.find(entry => entry.key === code);
		for (const code of ['QUEUE_FULL', 'STALE', 'STREAM_ERROR', 'LOAD_MORE_ERROR', 'SOURCE_ERROR', 'OFFLINE_CLEAR_FAILED', 'OFFLINE_SCOPE_CHANGED', 'OFFLINE_CLEARED', 'LOCK_CLEARED', 'UNKNOWN', 'INVALID_USER_ID']) expect(row(code), code).toBeDefined();
		expect(row('LOCK_CLEARED').prefixes).toContain('lock: cleared');
		expect(row('LOCK_TIMEOUT').prefixes).toContain('lock: timed out after <maxWaitMs>ms waiting for the lock');
		expect(row('UNKNOWN').prefixes).toEqual(expect.arrayContaining(['Unknown error', 'Upload failed']));
		expect(row('STREAM_ERROR').prefixes).toContain('Stream failed');
		expect(row('LOAD_MORE_ERROR').prefixes).toContain('Load more failed');
		expect(row('TIMEOUT').prefixes).toContain("RPC '<path>' timed out after <value>s");
		expect(renderErrorReference()).toContain("<code>RPC '&lt;path&gt;' timed out after &lt;value&gt;s</code>");
	});
	it('resolves plain Error declarations only in their lexical scope', () => {
		const inventory = scanRuntimeErrors([{path:'src/example.js', source: "{const err = new Error('first'); err.code='ONE';} {const err = new Error('second'); err.code='TWO';}"}]);
		expect(inventory.errors.map(row => [row.key, row.prefixes])).toEqual([['ONE',['first']],['TWO',['second']]]);
	});
});


it('does not infer error codes through shadowed helper parameters or calls', () => {
	for (const source of [
		"function outer(code){function inner(code){return new RpcError(code)}} outer('OUTER')",
		"function outer(code){function inner({code}){return new RpcError(code)}} outer('OUTER')",
		"function fail(code){return new RpcError(code)}; function caller(fail){fail('NOT_LOCAL')}",
		"function fail(code){return new RpcError(code)}; function caller(){const fail = other; fail('NOT_LOCAL')}",
		"const err = new Error('outer'); function inner(err){err.code='NOT_ERROR'}"
	]) expect(scanRuntimeErrors([{path:'src/example.js', source}]).errors).toEqual([]);
});
