const textEncoder = new TextEncoder();

/**
 * Encode a JSON object to ArrayBuffer, mimicking how the adapter delivers text frames.
 * @param {any} obj
 * @returns {ArrayBuffer}
 */
export function toArrayBuffer(obj) {
	return textEncoder.encode(JSON.stringify(obj)).buffer;
}
