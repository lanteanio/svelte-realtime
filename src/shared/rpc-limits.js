/** Maximum calls accepted in one RPC batch envelope, shared by both endpoints. */
export const MAX_RPC_BATCH_CALLS = 50;

/** Conservative stream coalescing budget; an individual request may be larger. */
export const STREAM_BATCH_BYTES = 64 * 1024;
