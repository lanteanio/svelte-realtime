import { isIP } from 'node:net';

const hostError = () => new TypeError('REALTIME_TEST_DOCKER_SERVICE_HOST must be a plain DNS hostname or IPv4/IPv6 address, without a URL, port or zone');

/** Resolve only the address of services Docker publishes; local test servers stay on loopback. */
export function dockerServiceHost(value = process.env.REALTIME_TEST_DOCKER_SERVICE_HOST) {
	if (value === undefined) return '127.0.0.1';
	if (typeof value !== 'string' || value.length === 0 || value.length > 253 || /[\s/%\\?#@]/.test(value)) throw hostError();
	let host = value;
	if (host.startsWith('[') && host.endsWith(']')) {
		host = host.slice(1, -1);
		if (isIP(host) !== 6) throw hostError();
	} else if (/[\[\]]/.test(host)) throw hostError();
	const family = isIP(host);
	if (family === 4 || family === 6) return host.toLowerCase();
	const labels = host.split('.');
	if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) || !/[a-z]/i.test(labels.at(-1))) throw hostError();
	// WHATWG URLs interpret some number-like names as legacy IPv4 spellings.
	// A service hostname must survive URL parsing without changing its address.
	try { if (new URL('http://' + host).hostname !== host.toLowerCase()) throw hostError(); }
	catch { throw hostError(); }
	return host.toLowerCase();
}

/** Build a service URL using the exact port Docker reported or reserved. */
export function dockerServiceUrl(protocol, port, pathname = '', value = process.env.REALTIME_TEST_DOCKER_SERVICE_HOST) {
	if (!['ws', 'redis'].includes(protocol)) throw new TypeError('Unsupported Docker test service protocol');
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Docker test service port must be an integer from 1 to 65535');
	if (typeof pathname !== 'string' || (pathname !== '' && (!pathname.startsWith('/') || /[\s\\?#]/.test(pathname)))) throw new TypeError('Docker test service path must be an absolute path');
	const host = dockerServiceHost(value);
	return protocol + '://' + (isIP(host) === 6 ? '[' + host + ']' : host) + ':' + port + pathname;
}
