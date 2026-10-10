import { afterEach, expect, it } from 'vitest';
import { DIAGNOSTIC_PREFIX as adapterPrefix, parseDiagnostic, setOperationalEventSink as adapterSink, emitOperationalEvent as adapterEmit } from 'svelte-adapter-uws/observability';
import { DIAGNOSTIC_PREFIX, formatDiagnostic, setOperationalEventSink, emitOperationalEvent } from '../src/shared/diagnostic.js';

const restores = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });
const event = source => ({ source, component: 'runtime.contract', event: 'contract.delivery', severity: 'warn', message: 'Delivery check' });

it('formats the installed adapter diagnostic identity and parses as its canonical envelope', () => {
	expect(DIAGNOSTIC_PREFIX).toBe(adapterPrefix);
	expect(DIAGNOSTIC_PREFIX).toBe('lantean/diagnostic');
	expect(parseDiagnostic(formatDiagnostic(event('svelte-realtime')))).toMatchObject({ format: 'canonical', record: { source: 'svelte-realtime', event: 'contract.delivery', severity: 'warn' } });
});
it('delivers realtime events to an adapter-installed sink', () => {
	const records = []; restores.push(adapterSink(record => records.push(record)));
	emitOperationalEvent(event('svelte-realtime'));
	expect(records).toHaveLength(1);
	expect(records[0]).toMatchObject(event('svelte-realtime'));
});
it('delivers adapter events through a realtime-installed sink and restores interleaved registrations', () => {
	const outer = [], inner = [];
	const restoreOuter = adapterSink(record => outer.push(record)); restores.push(restoreOuter);
	const restoreInner = setOperationalEventSink(record => inner.push(record)); restores.push(restoreInner);
	adapterEmit(event('svelte-adapter-uws'));
	expect(inner).toHaveLength(1); expect(outer).toHaveLength(0);
	restoreInner(); restoreInner();
	emitOperationalEvent(event('svelte-realtime'));
	expect(outer).toHaveLength(1); expect(inner).toHaveLength(1);
});

it('installs shared sinks without invoking inherited symbol setters', () => {
	const slots = ['lantean.operational-event-sink.v1', 'lantean.operational-event-sink-registry.v1'].map(Symbol.for);
	const own = slots.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
	const inherited = slots.map(key => Object.getOwnPropertyDescriptor(Object.prototype, key));
	let swallowed = 0;
	let restore;
	try {
		for (const key of slots) {
			delete globalThis[key];
			Object.defineProperty(Object.prototype, key, { configurable: true, set() { swallowed++; } });
		}
		const records = [];
		restore = setOperationalEventSink(record => records.push(record));
		emitOperationalEvent(event('svelte-realtime'));
		adapterEmit(event('svelte-adapter-uws'));
		expect(swallowed).toBe(0);
		expect(records.map(record => record.source)).toEqual(['svelte-realtime', 'svelte-adapter-uws']);
	} finally {
		restore?.();
		for (let i = 0; i < slots.length; i++) {
			delete globalThis[slots[i]];
			delete Object.prototype[slots[i]];
			if (own[i]) Object.defineProperty(globalThis, slots[i], own[i]);
			if (inherited[i]) Object.defineProperty(Object.prototype, slots[i], inherited[i]);
		}
	}
});
