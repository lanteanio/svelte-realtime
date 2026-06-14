// @ts-check

/**
 * Cross-module mutable client state. Only genuinely cross-module scalars live on
 * this holder; per-module lets travel with their owning module. The hot scalars
 * (batchCollector / terminated / config / isOffline) are plain properties - a
 * property read costs the same as a local read with no getter/setter call - so
 * the per-RPC and per-send gates keep their cost. Mirrors the server state holder.
 *
 * @type {{
 *   batchCollector: Array<{ rpc: string, id: string, args: any[] }> | null,
 *   terminated: boolean,
 *   config: any,
 *   isOffline: boolean,
 *   maxOptimisticQueueDepth: number
 * }}
 */
export const clientState = {
	batchCollector: null,
	terminated: false,
	config: {},
	isOffline: false,
	maxOptimisticQueueDepth: 1_000
};
