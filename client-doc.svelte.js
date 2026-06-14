/**
 * Rune-backed views over a CRDT document channel: the reactive layer between
 * the adapter's replica channel (svelte-adapter-uws/plugins/crdt/channel) and
 * Svelte 5 templates.
 *
 * Reads are reactive and granular: each container keeps a rune-backed mirror
 * (a SvelteMap for keyed containers, a $state array for ordered ones, a
 * $state string for text) updated from the channel's change notifications,
 * so a write to one map key invalidates only readers of that key. Writes are
 * imperative and synchronous - the channel applies them to the local replica
 * and the change notification updates the mirror in the same tick, so the
 * template re-renders against the just-written value with no round trip.
 *
 * Mounts of the same document share ONE channel through a reference-counted
 * cache: the second component mounting `board.map(id)` attaches to the live
 * replica instead of constructing a second one, and the last `destroy()`
 * tears the channel down (releasing the server-side reference). This is what
 * makes `destroy()` safe to call per-component.
 *
 * Sync failures fold into `realtime.health` as the document input: a replica
 * whose sync exchange is failing marks health degraded until one succeeds.
 *
 * @module svelte-realtime/doc
 */

import { SvelteMap } from 'svelte/reactivity';
import { _setCrdtDegraded } from './client.js';

/**
 * The shared per-document state one or more mounted views attach to: the
 * channel, the rune-backed lifecycle fields, and the per-container mirrors.
 */
class SharedDoc {
	/** @type {any} */
	channel;
	synced = $state(false);
	degraded = $state(false);
	/** @type {{ read: boolean, write: boolean, comment: boolean } | null} */
	access = $state(null);
	status = $state('idle');
	/** @type {Map<string, { facet: any, holder: any, off: () => void }>} */
	#containers = new Map();
	/** @type {Array<() => void>} */
	#unsubs = [];
	#healthFlagged = false;
	#destroyed = false;

	/**
	 * @param {any} channel
	 * @param {import('svelte/store').Readable<string> | undefined} status
	 */
	constructor(channel, status) {
		this.channel = channel;
		channel.onState(({ synced, degraded, access }) => {
			this.synced = synced;
			this.access = access;
			this.degraded = degraded;
			if (degraded !== this.#healthFlagged) {
				this.#healthFlagged = degraded;
				_setCrdtDegraded(degraded);
			}
		});
		if (status && typeof status.subscribe === 'function') {
			this.#unsubs.push(status.subscribe((s) => { this.status = s; }));
		}
	}

	/**
	 * Resolve (lazily wiring) one container's facet + reactive mirror. The
	 * mirror seeds synchronously from the replica and stays in lock-step via
	 * the facet's change notifications - both local writes and remote merges
	 * land in the same code path.
	 * @param {'map' | 'array' | 'text'} kind
	 * @param {string} name
	 */
	container(kind, name) {
		const key = kind + '\u0000' + name;
		let entry = this.#containers.get(key);
		if (entry) return entry;
		if (kind === 'map') {
			const facet = this.channel.map(name);
			const holder = new MapMirror();
			for (const [k, v] of Object.entries(facet.toJSON())) holder.value.set(k, v);
			const off = facet.onChange((changedKeys) => {
				for (const k of changedKeys) {
					if (facet.has(k)) holder.value.set(k, facet.get(k));
					else holder.value.delete(k);
				}
			});
			entry = { facet, holder, off };
		} else if (kind === 'array') {
			const facet = this.channel.array(name);
			const holder = new ListMirror();
			holder.value.push(...facet.toArray());
			const off = facet.onChange((delta) => {
				const arr = holder.value;
				let i = 0;
				for (const step of delta) {
					if (step.retain) i += step.retain;
					else if (step.insert) {
						arr.splice(i, 0, ...step.insert);
						i += step.insert.length;
					} else if (step.delete) {
						arr.splice(i, step.delete);
					}
				}
			});
			entry = { facet, holder, off };
		} else {
			const facet = this.channel.text(name);
			const holder = new TextMirror();
			holder.value = facet.toString();
			const off = facet.onChange(() => {
				holder.value = facet.toString();
			});
			entry = { facet, holder, off };
		}
		this.#containers.set(key, entry);
		return entry;
	}

	destroy() {
		if (this.#destroyed) return;
		this.#destroyed = true;
		for (const off of this.#unsubs) off();
		this.#unsubs = [];
		for (const entry of this.#containers.values()) {
			try { entry.off(); } catch { /* the channel may already be down */ }
		}
		this.#containers.clear();
		if (this.#healthFlagged) {
			this.#healthFlagged = false;
			_setCrdtDegraded(false);
		}
	}
}

/** Rune holder for a keyed container (per-key reactive). */
class MapMirror {
	value = new SvelteMap();
}

/** Rune holder for an ordered container (per-index reactive via the proxy). */
class ListMirror {
	value = $state([]);
}

/** Rune holder for a text container (strings are atomic values). */
class TextMirror {
	value = $state('');
}

/** Lifecycle surface every view forwards to its shared document. */
class DocView {
	/** @type {SharedDoc} */
	_shared;
	/** @type {() => void} */
	#release;
	#released = false;

	/**
	 * @param {SharedDoc} shared
	 * @param {() => void} release
	 */
	constructor(shared, release) {
		this._shared = shared;
		this.#release = release;
	}

	/** Connection status of the underlying realtime connection. */
	get status() {
		return this._shared.status;
	}

	/** True after a successful sync on the current connection. */
	get synced() {
		return this._shared.synced;
	}

	/** True while the sync exchange is failing and recovery is pending. */
	get degraded() {
		return this._shared.degraded;
	}

	/** The `{read, write, comment}` access record, or null before the first sync. */
	get access() {
		return this._shared.access;
	}

	/** True when the guard granted read but not write (disable inputs up front). */
	get readOnly() {
		return this._shared.access !== null && !this._shared.access.write;
	}

	/** Re-run the sync exchange now (also runs on every reconnect). */
	resync() {
		this._shared.channel.resync();
	}

	/**
	 * Release this mount. The underlying replica is shared and reference
	 * counted: the document tears down (and releases its server reference)
	 * when the LAST mounted view destroys.
	 */
	destroy() {
		if (this.#released) return;
		this.#released = true;
		this.#release();
	}
}

/**
 * A reactive keyed container over the document. Reads track the rune mirror;
 * writes apply to the local replica synchronously and merge everywhere.
 */
export class DocMap extends DocView {
	#name;

	/**
	 * @param {SharedDoc} shared
	 * @param {string} name
	 * @param {() => void} release
	 */
	constructor(shared, name, release) {
		super(shared, release);
		this.#name = name;
	}

	#entry() {
		return this._shared.container('map', this.#name);
	}

	/** @param {string} key */
	get(key) {
		return this.#entry().holder.value.get(key);
	}

	/** @param {string} key */
	has(key) {
		return this.#entry().holder.value.has(key);
	}

	get size() {
		return this.#entry().holder.value.size;
	}

	keys() {
		return this.#entry().holder.value.keys();
	}

	values() {
		return this.#entry().holder.value.values();
	}

	entries() {
		return this.#entry().holder.value.entries();
	}

	toJSON() {
		return Object.fromEntries(this.#entry().holder.value);
	}

	/** Applies locally now, merges everywhere. Throws on a read-only mount. */
	set(key, value) {
		this.#entry().facet.set(key, value);
	}

	/** @param {string} key */
	delete(key) {
		this.#entry().facet.delete(key);
	}

	clear() {
		this.#entry().facet.clear();
	}
}

/**
 * A reactive ordered container over the document. Positions are stable under
 * concurrent insert/delete (each element carries a CRDT identity).
 */
export class DocList extends DocView {
	#name;

	/**
	 * @param {SharedDoc} shared
	 * @param {string} name
	 * @param {() => void} release
	 */
	constructor(shared, name, release) {
		super(shared, release);
		this.#name = name;
	}

	#entry() {
		return this._shared.container('array', this.#name);
	}

	/** @param {number} index */
	at(index) {
		return this.#entry().holder.value[index];
	}

	get length() {
		return this.#entry().holder.value.length;
	}

	/** The reactive backing array - read-only by contract (iterate with {#each}). */
	toArray() {
		return this.#entry().holder.value;
	}

	toJSON() {
		return [...this.#entry().holder.value];
	}

	/** Applies locally now, merges everywhere. Throws on a read-only mount. */
	push(...items) {
		this.#entry().facet.push(...items);
	}

	insert(index, ...items) {
		this.#entry().facet.insert(index, ...items);
	}

	delete(index, length = 1) {
		this.#entry().facet.delete(index, length);
	}
}

/** A reactive collaborative text container (character-level concurrent insert). */
export class DocText extends DocView {
	#name;

	/**
	 * @param {SharedDoc} shared
	 * @param {string} name
	 * @param {() => void} release
	 */
	constructor(shared, name, release) {
		super(shared, release);
		this.#name = name;
	}

	#entry() {
		return this._shared.container('text', this.#name);
	}

	toString() {
		return this.#entry().holder.value;
	}

	/** The reactive text value (`text.value` in templates). */
	get value() {
		return this.#entry().holder.value;
	}

	get length() {
		return this.#entry().holder.value.length;
	}

	/** Applies locally now, merges everywhere. Throws on a read-only mount. */
	insert(index, content) {
		this.#entry().facet.insert(index, content);
	}

	delete(index, length = 1) {
		this.#entry().facet.delete(index, length);
	}
}

/**
 * The root view of a `live.doc` export: named containers over one document,
 * all sharing the topic's single update stream.
 */
export class DocHandle extends DocView {
	/** A keyed container by name. @param {string} [name] */
	map(name = 'root') {
		return new DocMap(this._shared, name, () => {});
	}

	/** An ordered container by name. @param {string} [name] */
	array(name = 'root') {
		return new DocList(this._shared, name, () => {});
	}

	/** A collaborative text container by name. @param {string} [name] */
	text(name = 'root') {
		return new DocText(this._shared, name, () => {});
	}

	/**
	 * Batch several mutations into ONE transaction = one wire update (the
	 * multi-field atomic edit).
	 * @param {() => void} fn
	 */
	transact(fn) {
		this._shared.channel.transact(fn);
	}
}

/**
 * The reference-counted channel cache: one live replica per document per
 * page, however many components mount it.
 * @type {Map<string, { shared: SharedDoc, refs: number }>}
 */
const _docCache = new Map();

/** Test seam: drop every cached document (destroying their channels). */
export function _resetDocCache() {
	for (const entry of _docCache.values()) {
		try { entry.shared.channel.destroy(); } catch { /* test teardown */ }
		entry.shared.destroy();
	}
	_docCache.clear();
}

/**
 * Acquire (constructing on first use) the shared document for a cache key and
 * return the view the export kind names. Generated client stubs call this;
 * it is not a public API.
 *
 * @param {string} cacheKey - export path + serialized room args
 * @param {'doc' | 'map' | 'array'} kind
 * @param {() => any} makeChannel
 * @param {import('svelte/store').Readable<string>} [status]
 * @internal
 */
export function _acquireDoc(cacheKey, kind, makeChannel, status) {
	let entry = _docCache.get(cacheKey);
	if (!entry) {
		const channel = makeChannel();
		entry = { shared: new SharedDoc(channel, status), refs: 0 };
		_docCache.set(cacheKey, entry);
	}
	entry.refs++;
	const release = () => {
		entry.refs--;
		if (entry.refs > 0) return;
		if (_docCache.get(cacheKey) === entry) _docCache.delete(cacheKey);
		const channel = entry.shared.channel;
		entry.shared.destroy();
		try { channel.destroy(); } catch { /* never throw out of a component teardown */ }
	};
	if (kind === 'map') return new DocMap(entry.shared, 'root', release);
	if (kind === 'array') return new DocList(entry.shared, 'root', release);
	return new DocHandle(entry.shared, release);
}
