// Private execution metadata: never copied into application data or the wire.
const fences = new WeakMap();

/** Keep an asynchronous call's ownership condition through middleware. */
export function _setResponseFence(ctx, valid, failure = { code: 'UNAVAILABLE', error: 'Response became stale before delivery; retry' }) {
	if (ctx === null || (typeof ctx !== 'object' && typeof ctx !== 'function')) return;
	const prior = fences.get(ctx);
	const fence = { valid, failure, prior };
	fences.set(ctx, fence);
}

/** Bind the final middleware envelope to the call that produced it. */
export function _bindResponseFence(ctx, response, requestId) {
	const fence = fences.get(ctx);
	if (fence && response && response.ok !== false) fences.set(response, { ...fence, requestId });
}

/** Resolve the first invalid condition without depending on a result's value type. */
export function _responseFenceFailure(source) {
	for (let fence = source && fences.get(source); fence; fence = fence.prior) {
		if (!fence.valid()) return fence.failure;
	}
	return null;
}

function check(source, response, requestId) {
	const failure = _responseFenceFailure(source);
	if (failure === null) return response;
	const { data: _data, ...rest } = response;
	return { ...rest, ok: false, code: failure.code, error: failure.error,
		requestId: response.requestId ?? fences.get(source)?.requestId ?? requestId };
}

/** Validate at the last synchronous boundary before a single or batch send. */
export function _fenceResponse(source, response, requestId) {
	if (Array.isArray(source.batch)) {
		let results = null;
		for (let i = 0; i < source.batch.length; i++) {
			const prior = source.batch[i];
			const next = check(prior, response.batch[i], prior.requestId ?? prior.id);
			if (next !== response.batch[i]) {
				results ??= response.batch.slice();
				results[i] = next;
			}
		}
		return results ? { ...response, batch: results } : response;
	}
	return check(source, response, requestId);
}
