import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
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
	DECISIONS,
	checkSiblingDocuments,
	renderErrorReference,
	validateDecisions,
	validateErrorRegistry,
	validateGuidance
} from '../scripts/generate-error-reference.js';
import { CODE_GUIDANCE, EVENT_GUIDANCE } from '../scripts/error-guidance.js';
import { mockPlatform } from './helpers/mock-platform.js';
import { _lazyQueue } from '../src/server/state.js';
import { _resetLazy, _resolveAllLazy } from '../src/server/lazy.js';
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
		expect(generated).toContain('printed through [`REALTIME-ERR-LAZY-REGISTRATION`](#realtime-err-lazy-registration)');
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

	it('refuses a computed emission site without a recorded reason, and a reason that matches nothing', () => {
		const inventory = withExtra('export function relay(reply) { throw new LiveError(reply.code, reply.message); }');
		expect(validateDecisions(inventory)).toEqual([
			'dynamic emission site "src/example.js::relay()::new LiveError" (1 site) has no DYNAMIC_SITE_REASONS entry in scripts/error-decisions.js'
		]);
		expect(() => renderErrorReference(undefined, inventory)).toThrow(/relay\(\)::new LiveError/);
		const stale = { ...DECISIONS, dynamic: { ...DECISIONS.dynamic, 'src/gone.js::gone()::new LiveError': { count: 1, reason: 'x' } } };
		expect(validateDecisions(scanRuntimeErrors(), stale)).toEqual([
			'DYNAMIC_SITE_REASONS["src/gone.js::gone()::new LiveError"] matches no computed emission site'
		]);
	});

	it('refuses a new computed site in a function whose sites were already decided', () => {
		const decided = { ...DECISIONS, dynamic: { ...DECISIONS.dynamic, 'src/example.js::relay()::new LiveError': { count: 1, reason: 'Forwards the reply.' } } };
		const one = withExtra('export function relay(reply) { throw new LiveError(reply.code, reply.message); }');
		expect(validateDecisions(one, decided)).toEqual([]);
		const moved = withExtra('\n\n// moved\nexport function relay(reply) {\n\n throw new LiveError(reply.code, reply.message); }');
		expect(validateDecisions(moved, decided)).toEqual([]);
		const two = withExtra('export function relay(reply) { if (reply.retry) throw new LiveError(reply.retryCode, reply.message); throw new LiveError(reply.code, reply.message); }');
		expect(validateDecisions(two, decided)).toEqual([
			'DYNAMIC_SITE_REASONS["src/example.js::relay()::new LiveError"] records 1 site(s) but the function now has 2; decide the changed sites and update the count'
		]);
	});

	it('refuses a server console failure without a stable ID or a recorded reason', () => {
		const inventory = withExtra("export function tick() { console.error('[svelte-realtime] tick store failed:', new Error('x')); }");
		expect(validateDecisions(inventory)).toEqual([
			'console line "src/example.js::[svelte-realtime] tick store failed:" is neither printed through the error registry nor given a CONSOLE_REASONS entry in scripts/error-decisions.js'
		]);
		const reasoned = { ...DECISIONS, console: { ...DECISIONS.console, 'src/example.js::[svelte-realtime] tick store failed:': 'Recorded.' } };
		expect(validateDecisions(inventory, reasoned)).toEqual([]);
		expect(validateDecisions(scanRuntimeErrors(), reasoned)).toEqual([
			'CONSOLE_REASONS["src/example.js::[svelte-realtime] tick store failed:"] matches no console line'
		]);
		const routed = withExtra("export function tick(err) { console.error(realtimeErrorMessage(REALTIME_ERROR_IDS.LAZY_REGISTRATION, ' x'), err); }");
		expect(routed.consoleSites.find((site) => site.path === 'src/example.js').registered).toBe(true);
		expect(validateDecisions(routed)).toEqual([
			'console line in src/example.js prints through REALTIME-ERR-LAZY-REGISTRATION, whose sources do not list that file'
		]);
		const listed = REALTIME_ERROR_REGISTRY.map((entry) => entry.id === REALTIME_ERROR_IDS.LAZY_REGISTRATION ? { ...entry, sources: [...entry.sources, 'src/example.js'] } : entry);
		expect(validateDecisions(routed, DECISIONS, listed)).toEqual([]);
	});

	it('treats aliased console printers as console lines', () => {
		for (const source of [
			"const warn = console.warn; export function tick() { warn('[svelte-realtime] aliased failure'); }",
			"const log = console.error.bind(console); export function tick() { log('[svelte-realtime] aliased failure'); }",
			"const { warn: say } = console; export function tick() { say('[svelte-realtime] aliased failure'); }"
		]) {
			expect(validateDecisions(withExtra(source)), source).toEqual([
				'console line "src/example.js::[svelte-realtime] aliased failure" is neither printed through the error registry nor given a CONSOLE_REASONS entry in scripts/error-decisions.js'
			]);
		}
	});

	it('refuses a registry entry that nothing emits, ignoring keys named only in comments', () => {
		const entry = REALTIME_ERROR_REGISTRY.find((item) => item.id === REALTIME_ERROR_IDS.DOC_PERSIST);
		expect(validateErrorRegistry([{ ...entry, sources: ['src/server/room.js'] }])).toEqual([
			'entry 0 (REALTIME-ERR-DOC-PERSIST) is not emitted through REALTIME_ERROR_IDS in any of its sources'
		]);
		const relativePath = 'test/.registry-comment-' + process.pid + '.js';
		const file = fileURLToPath(new URL('../' + relativePath, import.meta.url));
		writeFileSync(file, "// console.error(realtimeErrorMessage(REALTIME_ERROR_IDS.DOC_PERSIST));\nconst text = 'REALTIME_ERROR_IDS.DOC_PERSIST';\n");
		try {
			expect(validateErrorRegistry([{ ...entry, sources: [relativePath] }])).toEqual([
				'entry 0 (REALTIME-ERR-DOC-PERSIST) is not emitted through REALTIME_ERROR_IDS in any of its sources'
			]);
		} finally {
			rmSync(file, { force: true });
		}
	});

	it('fails when a present sibling checkout lacks the linked document', () => {
		const parent = mkdtempSync(join(tmpdir(), 'realtime-siblings-'));
		try {
			mkdirSync(join(parent, 'svelte-adapter-uws'));
			mkdirSync(join(parent, 'svelte-adapter-uws-extensions', 'docs'), { recursive: true });
			writeFileSync(join(parent, 'svelte-adapter-uws-extensions', 'docs', 'errors.md'), '# errors\n');
			const errors = checkSiblingDocuments(parent);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatch(/^svelte-adapter-uws: the local checkout at .* has no docs\/errors\.md/);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it('checks sibling error references only where a sibling checkout exists', () => {
		expect(checkSiblingDocuments(fileURLToPath(new URL('./__no-siblings-here__', import.meta.url)))).toEqual([]);
		const generated = renderErrorReference();
		expect(generated).toContain('[svelte-adapter-uws errors](https://github.com/lanteanio/svelte-adapter-uws/blob/');
		expect(generated).toContain('[svelte-adapter-uws-extensions errors](https://github.com/lanteanio/svelte-adapter-uws-extensions/blob/');
	});
});

describe('registry-backed console lines', () => {
	it('prints a failed lazy registration under its stable error ID', async () => {
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const saved = _lazyQueue.splice(0);
		_resetLazy();
		try {
			_lazyQueue.push({ type: 'cron', path: 'jobs/nightly', loader: async () => { throw new Error('module boom'); } });
			await _resolveAllLazy();
			const definition = realtimeErrorDefinition(REALTIME_ERROR_IDS.LAZY_REGISTRATION);
			expect(errSpy).toHaveBeenCalledTimes(1);
			expect(errSpy.mock.calls[0][0]).toBe(realtimeErrorMessage(definition.id, " 'jobs/nightly'"));
			expect(errSpy.mock.calls[0][1].message).toBe('module boom');
		} finally {
			errSpy.mockRestore();
			_lazyQueue.length = 0;
			_lazyQueue.push(...saved);
			_resetLazy();
		}
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
			return { inventory, text: renderErrorReference([], inventory, { VALIDATION: guidance('Documented.') }, {}, { dynamic: {}, excluded: {}, console: {} }) };
		};
		const before = render("new LiveError('VALIDATION', 'before');");
		const after = render("new LiveError('VALIDATION', '<script>|after\\n');");
		expect(before.inventory.errors[0].anchor).toBe(after.inventory.errors[0].anchor);
		expect(before.text).not.toBe(after.text);
		expect(after.text).toContain('&lt;script&gt;&#124;after\\n');
		expect(after.text).not.toContain('<script>');
	});
});

describe('code and message resolution', () => {
	const scanFiles = (files) => scanRuntimeErrors(Object.entries(files).map(([path, source]) => ({ path, source })));

	it('resolves codes and messages bound to local constants', () => {
		const inventory = scanFiles({ 'src/example.js': "function deny(authed) { const code = authed ? 'FORBIDDEN' : 'UNAUTHENTICATED'; const message = 'Access denied'; throw new LiveError(code, message); }" });
		expect(inventory.errors.map((row) => [row.key, row.prefixes])).toEqual([['FORBIDDEN', ['Access denied']], ['UNAUTHENTICATED', ['Access denied']]]);
		expect(inventory.dynamicSites).toEqual([]);
	});

	it('follows an exported helper to its call sites in importing files', () => {
		const inventory = scanFiles({
			'src/client/state.js': 'export function _lost(code, message) { for (const fail of pending) fail(new RpcError(code, message)); }',
			'src/client/connection.js': "import { _lost } from './state.js'; function onClose() { _lost('DISCONNECTED', 'WebSocket connection replaced'); }"
		});
		expect(inventory.errors).toHaveLength(1);
		expect(inventory.errors[0].key).toBe('DISCONNECTED');
		expect(inventory.errors[0].prefixes).toEqual(['WebSocket connection replaced']);
		expect(inventory.errors[0].sources).toEqual(['src/client/connection.js', 'src/client/state.js']);
		expect(inventory.dynamicSites).toEqual([]);
		const forwarded = scanFiles({
			'src/client/state.js': 'export function _lost(code, message) { return new RpcError(code, message); }',
			'src/client/connection.js': "import { _lost } from './state.js'; function onReply(data) { _lost(data.code, 'Server error'); }"
		});
		expect(forwarded.dynamicSites.map((site) => site.scope)).toEqual(['_lost()']);
	});

	it('follows a method helper to the calls of that method in its file', () => {
		const inventory = scanFiles({ 'src/example.js': "const upload = { fail(code, error) { abort(new LiveError(code, error)); } }; upload.fail('FLOW_BACKPRESSURE', 'chunk exceeds credit');" });
		expect(inventory.errors.map((row) => [row.key, row.prefixes])).toEqual([['FLOW_BACKPRESSURE', ['chunk exceeds credit']]]);
		expect(inventory.dynamicSites).toEqual([]);
	});

	it('inlines module constants and hides internal names in placeholders', () => {
		const inventory = scanFiles({ 'src/example.js': "const CAP = 5000; const PREFIX = '[svelte-realtime] '; function warn(size) { console.warn(PREFIX + 'gate at ' + CAP + ' of ' + _SMOOTH_SYNC_MAX_PER_WINDOW + ' for ' + size); }" });
		expect(inventory.consoleSites.map((site) => site.text)).toEqual(['[svelte-realtime] gate at 5000 of <value> for <size>']);
	});

	it('expands a conditional with literal text inside a message into one pattern per branch', () => {
		const source = "export function report(name, initFailed, err) { console.error('[svelte-realtime] live.aggregate \\'' + name + '\\': ' + (initFailed ? 'init threw; the window keeps its state.' : 'window publish failed; it retries.') + '\\n  ' + err.message); }";
		const inventory = scanFiles({ 'src/server/example.js': source });
		expect(inventory.consoleSites.map((site) => site.text)).toEqual([
			"[svelte-realtime] live.aggregate '<name>': init threw; the window keeps its state.\n  <message>",
			"[svelte-realtime] live.aggregate '<name>': window publish failed; it retries.\n  <message>"
		]);
		const reworded = scanFiles({ 'src/server/example.js': source.replace('it retries.', 'it retries later.') });
		expect(reworded.consoleSites.map((site) => site.text)).toContain("[svelte-realtime] live.aggregate '<name>': window publish failed; it retries later.\n  <message>");
	});

	it('names placeholders after the property, hiding only underscore and SCREAMING names', () => {
		const inventory = scanFiles({ 'src/server/example.js': "export function warn(entry, call) { console.warn('[svelte-realtime] late (misfireMs=' + entry.misfireMs + ') for ' + call.path + ' cap ' + entry._cap + ' of ' + LIMITS.MAX_ROWS); }" });
		expect(inventory.consoleSites.map((site) => site.text)).toEqual(['[svelte-realtime] late (misfireMs=<misfireMs>) for <path> cap <value> of <value>']);
	});

	it('treats a message branch without literal text as computed', () => {
		const inventory = scanFiles({ 'src/server/example.js': "export function note(msg, verbose) { console.warn(msg + (verbose ? ' (details)' : '')); }" });
		expect(inventory.consoleSites.map((site) => site.text)).toEqual(['<msg> (details)']);
		expect(inventory.dynamicSites).toEqual([{ path: 'src/server/example.js', scope: 'note()', kind: 'console.warn', count: 1 }]);
	});

	it('keeps collected text and marks the site computed when a + chain exceeds the variant cap', () => {
		const branches = ['a', 'b', 'c', 'd', 'e'].map((flag) => " + (" + flag + " ? ' " + flag + "1' : ' " + flag + "2')").join('');
		const inventory = scanFiles({ 'src/server/example.js': "export function many(a, b, c, d, e) { console.warn('[svelte-realtime] prefix:'" + branches + " + ' tail'); }" });
		const texts = inventory.consoleSites.map((site) => site.text);
		expect(texts.length).toBeGreaterThan(0);
		expect(texts.length).toBeLessThanOrEqual(16);
		for (const text of texts) {
			expect(text.startsWith('[svelte-realtime] prefix:'), text).toBe(true);
			expect(text.endsWith(' tail'), text).toBe(true);
		}
		expect(inventory.dynamicSites).toEqual([{ path: 'src/server/example.js', scope: 'many()', kind: 'console.warn', count: 1 }]);
	});

	it('marks a template over the variant cap as computed', () => {
		const holes = ['a', 'b', 'c', 'd', 'e'].map((flag) => '${' + flag + " ? '" + flag + "1' : '" + flag + "2'}").join('-');
		const inventory = scanFiles({ 'src/server/example.js': 'export function many(a, b, c, d, e) { console.warn(`[svelte-realtime] ' + holes + ' done`); }' });
		for (const text of inventory.consoleSites.map((site) => site.text)) expect(text.startsWith('[svelte-realtime] ')).toBe(true);
		expect(inventory.dynamicSites).toEqual([{ path: 'src/server/example.js', scope: 'many()', kind: 'console.warn', count: 1 }]);
	});

	it('resolves console aliases through their binding, not their name', () => {
		const sites = (source) => scanFiles({ 'src/server/example.js': source }).consoleSites.map((site) => site.method + ' ' + site.text);
		expect(sites("function a() { const warn = console.warn; warn('[svelte-realtime] one'); } function b(warn) { warn('[svelte-realtime] two'); }")).toEqual(['console.warn [svelte-realtime] one']);
		expect(sites("const c = console; c.warn('[svelte-realtime] object alias');")).toEqual(['console.warn [svelte-realtime] object alias']);
		expect(sites("console['error']('[svelte-realtime] computed member');")).toEqual(['console.error [svelte-realtime] computed member']);
		expect(sites("globalThis.console.error('[svelte-realtime] qualified');")).toEqual(['console.error [svelte-realtime] qualified']);
		expect(sites("function f(log = console.error) { log('[svelte-realtime] default param'); }")).toEqual(['console.error [svelte-realtime] default param']);
		expect(sites("function f(console) { console.warn('[svelte-realtime] shadowed'); }")).toEqual([]);
	});

	it('indexes the real connection-replaced message under DISCONNECTED', () => {
		expect(scanRuntimeErrors().errors.find((row) => row.key === 'DISCONNECTED').prefixes).toContain('WebSocket connection replaced');
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
