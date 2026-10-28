/** JSON values accepted as public error metadata. */
export type ErrorJsonValue = null | boolean | number | string | readonly ErrorJsonValue[] | { readonly [key: string]: ErrorJsonValue };

/** Explicit public error fields, bounded to 4096 serialized UTF-8 bytes together. */
export interface ErrorMetadata {
	readonly params?: { readonly [key: string]: ErrorJsonValue };
	readonly details?: ErrorJsonValue;
	/** Milliseconds the caller should wait before retrying the failed operation. */
	readonly retryAfter?: number;
}

/** @internal */
export function copyErrorMetadata(value: unknown): ErrorMetadata;
