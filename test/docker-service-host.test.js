import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dockerServiceHost, dockerServiceUrl } from './helpers/docker-service-host.js';

beforeEach(() => vi.stubEnv('REALTIME_TEST_DOCKER_SERVICE_HOST', undefined));
afterEach(() => vi.unstubAllEnvs());

it('keeps default Docker endpoints on loopback with their real ports', () => {
	expect(dockerServiceHost()).toBe('127.0.0.1');
	expect(dockerServiceUrl('ws', 52202, '/ws')).toBe('ws://127.0.0.1:52202/ws');
	expect(dockerServiceUrl('redis', 63879)).toBe('redis://127.0.0.1:63879');
});

it('changes both Docker service endpoints through the explicit test environment', () => {
	vi.stubEnv('REALTIME_TEST_DOCKER_SERVICE_HOST', 'host.docker.internal');
	expect(dockerServiceHost()).toBe('host.docker.internal');
	expect(dockerServiceUrl('ws', 52202, '/ws')).toBe('ws://host.docker.internal:52202/ws');
	expect(dockerServiceUrl('redis', 63879)).toBe('redis://host.docker.internal:63879');
});

it.each([
	['localhost', 'localhost'], ['DOCKER.Example', 'docker.example'], ['192.168.65.254', '192.168.65.254'],
	['::1', '[::1]'], ['[::1]', '[::1]'], ['2001:db8::1234', '[2001:db8::1234]'], ['::ffff:192.0.2.1', '[::ffff:192.0.2.1]']
])('preserves the selected service host %s and brackets IPv6 once', (value, authority) => {
	const ws = dockerServiceUrl('ws', 52202, '/ws', value);
	const redis = dockerServiceUrl('redis', 63879, '', value);
	expect(ws).toBe('ws://' + authority + ':52202/ws');
	expect(redis).toBe('redis://' + authority + ':63879');
	expect(new URL(ws).port).toBe('52202');
	expect(new URL(redis).port).toBe('63879');
});

it.each([
	'', ' ', ' host.docker.internal', 'host.docker.internal ', 'host\nname', 'http://host.docker.internal',
	'ws://host.docker.internal/ws', 'redis://localhost', '//localhost', 'localhost:52202', '127.0.0.1:52202',
	'user@localhost', 'localhost/path', 'localhost?query', 'localhost#fragment', 'localhost\\path', '%6cocalhost',
	'fe80::1%eth0', '[::1]:52202', '[::1', '::1]', '[127.0.0.1]', '[]', '[not-an-ip]',
	'bad..host', '-bad.host', 'bad-.host', 'bad_host', 'localhost.', '256.1.1.1', '127.1', '127.000.0.1',
	'2130706433', '0x7f000001', 'example.123', 'a'.repeat(64) + '.example', 'a.'.repeat(128) + 'example'
])('refuses a URL-shaped or ambiguous Docker service host %j', value => {
	expect(() => dockerServiceHost(value)).toThrow('REALTIME_TEST_DOCKER_SERVICE_HOST');
	expect(() => dockerServiceUrl('ws', 52202, '/ws', value)).toThrow('REALTIME_TEST_DOCKER_SERVICE_HOST');
});

it.each([0, 65536, -1, 1.5, '52202', NaN])('refuses a malformed service port %j instead of changing it', port => {
	expect(() => dockerServiceUrl('ws', port, '/ws')).toThrow('port');
});
