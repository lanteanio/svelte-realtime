// @ts-check

/**
 * Insert `script` once before the closing head (or body) tag of an HTML
 * response, without buffering a streamed page or splitting UTF-8 characters.
 * Non-HTML and encoded responses pass through untouched.
 * @param {any} res
 * @param {string} script
 */
export function _injectDevtools(res, script) {
	if (res.req?.method === 'HEAD') return;
	const write = res.write;
	const end = res.end;
	const writeHead = res.writeHead;
	let pending = Buffer.alloc(0);
	let injected = false;
	/** @type {boolean | undefined} */
	let html;
	const isHtml = () => html ??= String(res.getHeader('content-type') || '').includes('text/html') && !res.getHeader('content-encoding');
	const removeLength = () => { if (!res.headersSent) res.removeHeader('content-length'); };
	if (writeHead) res.writeHead = function (/** @type {number} */ status, /** @type {any[]} */ ...args) {
		const index = typeof args[0] === 'string' ? 1 : 0;
		const headers = args[index];
		/** @type {Array<[string, any]>} */
		const entries = Array.isArray(headers)
			? Array.from({ length: headers.length / 2 }, (_, i) => [headers[i * 2], headers[i * 2 + 1]])
			: Object.entries(headers || {});
		const type = entries.find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? res.getHeader('content-type');
		const encoding = entries.find(([key]) => key.toLowerCase() === 'content-encoding')?.[1] ?? res.getHeader('content-encoding');
		html = String(type || '').includes('text/html') && !encoding;
		if (html) {
			removeLength();
			if (headers) {
				const filtered = entries.filter(([key]) => key.toLowerCase() !== 'content-length');
				args[index] = Array.isArray(headers) ? filtered.flat() : Object.fromEntries(filtered);
			}
		}
		return writeHead.call(this, status, ...args);
	};
	/**
	 * @param {any} chunk
	 * @param {BufferEncoding | undefined} encoding
	 * @param {boolean} final
	 */
	const transform = (chunk, encoding, final) => {
		const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk || []);
		const data = pending.length ? Buffer.concat([pending, bytes]) : bytes;
		pending = Buffer.alloc(0);
		// latin1 keeps one character per byte, so a match remains a byte offset
		// even when a UTF-8 character straddles streamed chunks.
		const text = data.toString('latin1');
		const head = text.search(/<\/head>/i);
		const body = text.search(/<\/body>/i);
		const index = head >= 0 ? head : body;
		if (index >= 0) {
			injected = true;
			return Buffer.concat([data.subarray(0, index), Buffer.from(script), data.subarray(index)]);
		}
		if (final) return data;
		// Six trailing bytes are enough to retain a split closing tag.
		const split = Math.max(0, data.length - 6);
		pending = data.subarray(split);
		return data.subarray(0, split);
	};
	if (write) res.write = function (/** @type {any} */ chunk, /** @type {any} */ encoding, /** @type {any} */ callback) {
		if (!isHtml() || injected) return write.apply(this, arguments);
		removeLength();
		if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
		const output = transform(chunk, encoding, false);
		if (!output.length) {
			if (callback) queueMicrotask(callback); // determinism-allow: completes a Vite dev-server HTTP write, outside the realtime runtime
			return true;
		}
		return write.call(this, output, callback);
	};
	res.end = function (/** @type {any} */ chunk, /** @type {any} */ encoding, /** @type {any} */ callback) {
		if (!isHtml() || injected) return end.apply(this, arguments);
		removeLength();
		if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
		if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
		return end.call(this, transform(chunk, encoding, true), callback);
	};
}
