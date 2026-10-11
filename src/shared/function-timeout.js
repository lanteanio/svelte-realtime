// @ts-check

/** @param {number | undefined} timeout */
export function validateFunctionTimeout(timeout) {
	if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 2147483647)) {
		throw new Error('live timeout must be an integer between 1 and 2147483647 milliseconds');
	}
	return timeout;
}
