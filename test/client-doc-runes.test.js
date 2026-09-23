// Runtime tests for the document runes' reactivity at the one seam Svelte
// makes subtle: a $state created while a reaction runs belongs to that
// reaction, and reads of it in the same run are deliberately not tracked. The
// document mirrors and the shared document itself are built lazily on first
// access, so a reaction that reaches a mirror (or acquires the document) for
// the first time used to read the seed value once and never re-run, while the
// same read after another caller had built it tracked fine. The module is
// compiled with compileModule and imported, like the other rune probes; the
// adapter channel is a scripted fake.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { compileModule } from 'svelte/compiler';

const SHIPPED_RUNE_PATH = resolve(import.meta.dirname, '../src/client-doc.svelte.js');
// `svelte/reactivity` has no `node` condition, so under node it resolves to the
// server build, whose SvelteMap is an inert Map: a map mirror looks dead there
// no matter what the code does. The browser gets index-client.js, so the probe
// points the compiled module at that entry (the same internal client runtime
// the compiled $state uses, hence one runtime instance).
const CLIENT_REACTIVITY = resolve(import.meta.dirname, '../node_modules/svelte/src/reactivity/index-client.js');
const runeProbeRoot = resolve(import.meta.dirname, '__doc_rune__');
const runeProbeDirs = [];
let runeProbeCounter = 0;
// Effects flush on a microtask; a macrotask turn lets every scheduled run
// settle. (The 'svelte' entry resolves to the server build under node, whose
// flushSync is a no-op, and the compiled runes may not import the client
// runtime directly.)
const flush = () => new Promise((r) => setTimeout(r, 0));

const PROBE_SOURCE = `
/** Read read() from inside an effect, the reaction a component-init effect gets. */
export function watch(read) {
	const log = [];
	const stop = $effect.root(() => {
		$effect.pre(() => { log.push(read()); });
	});
	return { log, stop };
}

/** The same read from inside a $derived, which additionally forbids writing to state. */
export function watchDerived(read) {
	const log = [];
	const stop = $effect.root(() => {
		const value = $derived.by(read);
		$effect.pre(() => { log.push(value); });
	});
	return { log, stop };
}
`;

async function loadRunes(generate = 'client') {
	mkdirSync(runeProbeRoot, { recursive: true });
	const probeDir = mkdtempSync(resolve(runeProbeRoot, 'probe-'));
	runeProbeDirs.push(probeDir);
	writeFileSync(resolve(probeDir, 'client.js'), 'export function _setCrdtDegraded() {}\n');
	if (!existsSync(CLIENT_REACTIVITY)) throw new Error('probe rig: svelte client reactivity entry not found at ' + CLIENT_REACTIVITY);
	const clientReactivityHref = JSON.stringify(pathToFileURL(CLIENT_REACTIVITY).href);
	const compile = (name, source) => {
		const { js } = compileModule(source, { filename: name, generate });
		const specifier = "'svelte/reactivity'";
		const hits = js.code.split(specifier).length - 1;
		// A rewrite that silently matched nothing would leave the inert server
		// map in place and make a dead mirror look green. The server target
		// keeps its own reactivity entry: that is what SSR really loads.
		if (source.includes(specifier) && hits !== 1) throw new Error('probe rig: expected one svelte/reactivity import in ' + name + ', found ' + hits);
		const out = resolve(probeDir, name.replace('.svelte.js', '.js'));
		writeFileSync(out, generate === 'client' ? js.code.replace(specifier, clientReactivityHref) : js.code);
		return out;
	};
	const docOut = compile('client-doc.svelte.js', readFileSync(SHIPPED_RUNE_PATH, 'utf8'));
	const probeOut = compile('probe.svelte.js', PROBE_SOURCE);
	const tag = '?t=' + ++runeProbeCounter;
	const doc = await import(pathToFileURL(docOut).href + tag);
	const probe = await import(pathToFileURL(probeOut).href + tag);
	return { doc, probe };
}

/** A listener list with the facet notification shape the CRDT plugin uses. */
function listenable() {
	let listeners = [];
	return {
		onChange(cb) {
			listeners.push(cb);
			return () => { listeners = listeners.filter((x) => x !== cb); };
		},
		emit(arg) {
			for (const cb of listeners.slice()) cb(arg);
		}
	};
}

/** A scripted CRDT channel: each facet kind notifies in its own delta shape. */
function fakeChannel() {
	const stores = { text: new Map(), map: new Map(), array: new Map() };
	const stateListeners = [];
	const memo = (store, name, make) => {
		let f = store.get(name);
		if (!f) {
			f = make();
			store.set(name, f);
		}
		return f;
	};
	const textFacet = (name) => memo(stores.text, name, () => {
		const base = listenable();
		const f = {
			...base,
			value: '',
			toString() { return f.value; },
			insert(index, content) {
				f.value = f.value.slice(0, index) + content + f.value.slice(index);
				base.emit();
			},
			delete() {}
		};
		return f;
	});
	const arrayFacet = (name) => memo(stores.array, name, () => {
		const base = listenable();
		const items = [];
		return {
			...base,
			items,
			toArray() { return items.slice(); },
			append(...values) {
				const at = items.length;
				items.push(...values);
				base.emit(at > 0 ? [{ retain: at }, { insert: values }] : [{ insert: values }]);
			},
			removeAt(index, count) {
				items.splice(index, count);
				base.emit(index > 0 ? [{ retain: index }, { delete: count }] : [{ delete: count }]);
			}
		};
	});
	const mapFacet = (name) => memo(stores.map, name, () => {
		const base = listenable();
		const entries = new Map();
		return {
			...base,
			entries,
			toJSON() { return Object.fromEntries(entries); },
			has(k) { return entries.has(k); },
			get(k) { return entries.get(k); },
			set(k, v) { entries.set(k, v); base.emit([k]); },
			delete(k) { entries.delete(k); base.emit([k]); }
		};
	});
	return {
		text: textFacet,
		map: mapFacet,
		array: arrayFacet,
		onState(cb) { stateListeners.push(cb); return () => {}; },
		/** Deliver a sync state the way the channel does after an exchange. */
		pushState(state) { for (const cb of stateListeners.slice()) cb(state); },
		resync() {},
		transact(fn) { fn(); },
		destroy() {}
	};
}

describe('document runes: reactions that build what they read', () => {
	afterEach(() => {
		for (const dir of runeProbeDirs) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		runeProbeDirs.length = 0;
		if (existsSync(runeProbeRoot) && readdirSync(runeProbeRoot).length === 0) {
			rmSync(runeProbeRoot, { recursive: true, force: true });
		}
	});

	it('an init-time effect that creates the text mirror by reading it re-runs on every change', async () => {
		const { doc, probe } = await loadRunes();
		const channel = fakeChannel();
		channel.text('body').insert(0, 'seed');
		const handle = doc._acquireDoc('probe:init', 'doc', () => channel);
		// The first read of text('body') happens INSIDE the effect's first run.
		const { log, stop } = probe.watch(() => handle.text('body').value);
		await flush();
		expect(log).toEqual(['seed']);

		channel.text('body').insert(4, '-one');
		await flush();
		expect(log).toEqual(['seed', 'seed-one']);

		channel.text('body').insert(8, '-two');
		await flush();
		expect(log).toEqual(['seed', 'seed-one', 'seed-one-two']);
		stop();
		handle.destroy();
	});

	it('init-time effects on a map and an array mirror re-run on every change', async () => {
		const { doc, probe } = await loadRunes();
		const channel = fakeChannel();
		channel.array('items').append('a', 'b');
		channel.map('meta').set('title', 'x');
		const handle = doc._acquireDoc('probe:kinds', 'doc', () => channel);
		const lengths = probe.watch(() => handle.array('items').length);
		const sizes = probe.watch(() => handle.map('meta').size);
		await flush();
		// The container content that predates the mount seeds the mirror.
		expect(lengths.log).toEqual([2]);
		expect(sizes.log).toEqual([1]);

		channel.array('items').append('c');
		channel.map('meta').set('author', 'y');
		await flush();
		expect(lengths.log).toEqual([2, 3]);
		expect(sizes.log).toEqual([1, 2]);

		channel.array('items').removeAt(0, 1);
		channel.map('meta').delete('title');
		await flush();
		expect(lengths.log).toEqual([2, 3, 2]);
		expect(sizes.log).toEqual([1, 2, 1]);
		lengths.stop();
		sizes.stop();
		handle.destroy();
	});

	it('a reaction that acquires the document itself tracks the lifecycle fields', async () => {
		const { doc, probe } = await loadRunes();
		const channel = fakeChannel();
		// A `$derived(notes.doc(room).synced)` builds the shared document on its
		// own first run, so the document's own runes hit the same seam.
		let handle = null;
		const { log, stop } = probe.watch(() => {
			handle ??= doc._acquireDoc('probe:state', 'doc', () => channel);
			return handle.synced;
		});
		await flush();
		expect(log).toEqual([false]);

		channel.pushState({ synced: true, degraded: false, access: { read: true, write: true, comment: true } });
		await flush();
		expect(log).toEqual([false, true]);

		channel.pushState({ synced: false, degraded: true, access: { read: true, write: true, comment: true } });
		await flush();
		expect(log).toEqual([false, true, false]);
		stop();
		handle.destroy();
	});

	it('a $derived that is the first reader tracks the mirror and may not write to it', async () => {
		// A $derived is the stricter case: state created in the reaction is
		// untracked there too, and writing to state from inside one throws
		// outright. Seeding the mirror after it escaped its effect root would
		// be exactly that write.
		const { doc, probe } = await loadRunes();
		const channel = fakeChannel();
		channel.text('body').insert(0, 'seed');
		const handle = doc._acquireDoc('probe:derived', 'doc', () => channel);
		const { log, stop } = probe.watchDerived(() => handle.text('body').value);
		await flush();
		expect(log).toEqual(['seed']);

		channel.text('body').insert(4, '-more');
		await flush();
		expect(log).toEqual(['seed', 'seed-more']);
		stop();
		handle.destroy();
	});

	it('the server target hands back a seeded document, not an undefined holder', async () => {
		// The server target compiles `$effect.root` to a no-op and drops its
		// callback, so a holder built only inside one would be undefined and
		// every read of it would throw. The shipped SSR namespace is inert and
		// never loads this module, but anything that imports it under the
		// server build (a consumer's own test run) still gets a working view.
		const { doc } = await loadRunes('server');
		const channel = fakeChannel();
		channel.text('body').insert(0, 'rendered on the server');
		channel.map('meta').set('title', 'x');
		channel.array('items').append('a', 'b');
		const handle = doc._acquireDoc('probe:ssr', 'doc', () => channel);
		expect(handle.synced).toBe(false);
		expect(handle.access).toBe(null);
		expect(handle.text('body').value).toBe('rendered on the server');
		expect(handle.map('meta').size).toBe(1);
		expect(handle.array('items').length).toBe(2);
		handle.destroy();
	});

	it('an effect whose first run happens after another reader created the mirror tracks too (unchanged behaviour)', async () => {
		const { doc, probe } = await loadRunes();
		const channel = fakeChannel();
		const handle = doc._acquireDoc('probe:late', 'doc', () => channel);
		handle.text('body').value; // created outside any effect
		const { log, stop } = probe.watch(() => handle.text('body').value);
		await flush();
		channel.text('body').insert(0, 'x');
		await flush();
		expect(log).toEqual(['', 'x']);
		stop();
		handle.destroy();
	});
});
