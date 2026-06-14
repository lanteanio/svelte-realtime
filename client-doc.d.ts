import type { Readable } from 'svelte/store';

/** The per-document access record the guard resolved to. */
export interface DocAccess {
	/** May subscribe: receives the initial diff and live updates. */
	read: boolean;
	/** May emit document updates that mutate shared state. */
	write: boolean;
	/**
	 * Reserved: gates the comment-marks surface when the rich-text marks
	 * layer lands. Carried in full today; granting it changes nothing yet.
	 */
	comment: boolean;
}

/** Lifecycle surface every document view exposes. */
declare class DocView {
	/** Connection status of the underlying realtime connection. */
	readonly status: string;
	/** True after a successful sync on the current connection. */
	readonly synced: boolean;
	/** True while the sync exchange is failing and recovery is pending. */
	readonly degraded: boolean;
	/** The access record, or null before the first sync reply. */
	readonly access: DocAccess | null;
	/** True when the guard granted read but not write (disable inputs up front). */
	readonly readOnly: boolean;
	/** Re-run the sync exchange now (also runs on every reconnect). */
	resync(): void;
	/**
	 * Release this mount. The underlying replica is shared and reference
	 * counted; the document tears down when the last mounted view destroys.
	 */
	destroy(): void;
}

/**
 * A reactive keyed container. Reads are tracked per key; writes apply to the
 * local replica synchronously (no pending state) and merge everywhere.
 * Values are plain JSON values with replace-on-write semantics.
 */
export class DocMap<V = unknown> extends DocView {
	get(key: string): V | undefined;
	has(key: string): boolean;
	readonly size: number;
	keys(): IterableIterator<string>;
	values(): IterableIterator<V>;
	entries(): IterableIterator<[string, V]>;
	toJSON(): Record<string, V>;
	/** Throws on a read-only mount. */
	set(key: string, value: V): void;
	delete(key: string): void;
	clear(): void;
}

/**
 * A reactive ordered container. Positions are stable under concurrent
 * insert/delete (each element carries a CRDT identity).
 */
export class DocList<V = unknown> extends DocView {
	at(index: number): V | undefined;
	readonly length: number;
	/** The reactive backing array - read-only by contract (iterate with {#each}). */
	toArray(): V[];
	toJSON(): V[];
	/** Throws on a read-only mount. */
	push(...items: V[]): void;
	insert(index: number, ...items: V[]): void;
	delete(index: number, length?: number): void;
}

/** A reactive collaborative text container (character-level concurrent insert). */
export class DocText extends DocView {
	toString(): string;
	/** The reactive text value (`text.value` in templates). */
	readonly value: string;
	readonly length: number;
	/** Throws on a read-only mount. */
	insert(index: number, content: string): void;
	delete(index: number, length?: number): void;
}

/**
 * The root view of a `live.doc` export: named containers over one document,
 * all sharing the topic's single update stream.
 */
export class DocHandle extends DocView {
	map<V = unknown>(name?: string): DocMap<V>;
	array<V = unknown>(name?: string): DocList<V>;
	text(name?: string): DocText;
	/** Batch several mutations into one transaction = one wire update. */
	transact(fn: () => void): void;
}

/**
 * Acquire (constructing on first use) the shared document for a cache key.
 * Generated client stubs call this; it is not a public API.
 * @internal
 */
export function _acquireDoc(
	cacheKey: string,
	kind: 'doc' | 'map' | 'array',
	makeChannel: () => unknown,
	status?: Readable<string>
): DocHandle | DocMap | DocList;

/** Test seam: drop every cached document (destroying their channels). @internal */
export function _resetDocCache(): void;
