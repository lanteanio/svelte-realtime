// The /__realtime admin handler from realtime({ admin }). The focus is the
// fail-closed auth gate (only a strict `true` admits; a non-true return or a
// thrown check denies) plus the introspect serving + opt-ins. The handler is a
// framework-agnostic Web Request -> Response router, so it is tested with plain
// `Request` objects, no adapter required.

import { describe, it, expect } from 'vitest';
import { realtime, __register, live } from '../src/server.js';

const adminFor = (requires) => /** @type {any} */ (realtime({ admin: { requires } })).admin;
const req = (url = 'http://localhost/__realtime/introspect', init) => new Request(url, init);

describe('realtime({ admin }) - the /__realtime admin handler', () => {
	it('has no admin hook when admin is not configured (fail-closed by absence)', () => {
		expect(/** @type {any} */ (realtime()).admin).toBeUndefined();
	});

	it('throws when admin.requires is not a function (auth is mandatory)', () => {
		expect(() => realtime({ admin: /** @type {any} */ ({}) })).toThrow(/requires must be a function/);
		expect(() => realtime({ admin: /** @type {any} */ ({ requires: 'nope' }) })).toThrow(/requires must be a function/);
	});

	it('denies with 403 unless requires returns a strict true', async () => {
		expect((await adminFor(() => false)(req())).status).toBe(403);
		expect((await adminFor(() => undefined)(req())).status).toBe(403);
		expect((await adminFor(() => ({}))(req())).status).toBe(403); // truthy, but not === true
		expect((await adminFor(() => { throw new Error('boom'); })(req())).status).toBe(403); // a throwing gate denies
		expect((await adminFor(async () => false)(req())).status).toBe(403); // async false
	});

	it('serves the introspect snapshot (200 JSON, counts-only) when admitted', async () => {
		const res = await adminFor(() => true)(req());
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('application/json');
		expect(res.headers.get('cache-control')).toBe('no-store'); // never cache an admin snapshot
		const body = await res.json();
		expect(typeof body.handlers.total).toBe('number');
		expect(typeof body.shuttingDown).toBe('boolean');
		expect(body.handlers.paths).toBeUndefined(); // PII-free by default
		expect(body.topics.top).toBeUndefined();
	});

	it('honors the ?handlers=true / ?topics=true opt-ins', async () => {
		__register('admin-test/echo', live(async () => 'ok'));
		const res = await adminFor(() => true)(req('http://localhost/__realtime/introspect?handlers=true&topics=true'));
		const body = await res.json();
		expect(Array.isArray(body.handlers.paths)).toBe(true);
		expect(body.handlers.paths).toContain('admin-test/echo');
		expect(Array.isArray(body.topics.top)).toBe(true);
	});

	it('404s an unknown /__realtime sub-path', async () => {
		expect((await adminFor(() => true)(req('http://localhost/__realtime/nope'))).status).toBe(404);
	});

	it('passes the request to the auth gate (header-based check)', async () => {
		let seen = null;
		const admin = adminFor((request) => { seen = request; return request.headers.get('x-admin') === 'yes'; });
		const ok = await admin(req('http://localhost/__realtime/introspect', { headers: { 'x-admin': 'yes' } }));
		expect(ok.status).toBe(200);
		expect(seen).toBeInstanceOf(Request);
		const denied = await admin(req('http://localhost/__realtime/introspect', { headers: { 'x-admin': 'no' } }));
		expect(denied.status).toBe(403);
	});

	it('is mount-prefix agnostic: matches the command at any mount path', async () => {
		const admin = adminFor(() => true);
		// default prefix, a custom websocket.adminPath, a nested prefix, and a
		// bare +server.js route all resolve the same `introspect` command.
		expect((await admin(req('http://localhost/__realtime/introspect'))).status).toBe(200);
		expect((await admin(req('http://localhost/__admin/introspect'))).status).toBe(200);
		expect((await admin(req('http://localhost/ops/realtime/introspect'))).status).toBe(200);
		expect((await admin(req('http://localhost/introspect'))).status).toBe(200);
	});

	it('tolerates a single trailing slash', async () => {
		expect((await adminFor(() => true)(req('http://localhost/__realtime/introspect/'))).status).toBe(200);
		expect((await adminFor(() => true)(req('http://localhost/__admin/introspect/'))).status).toBe(200);
	});

	it('404s a bare mount with no command segment', async () => {
		expect((await adminFor(() => true)(req('http://localhost/__realtime'))).status).toBe(404);
		expect((await adminFor(() => true)(req('http://localhost/__realtime/'))).status).toBe(404);
	});
});
