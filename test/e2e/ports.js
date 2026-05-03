// Pick a free OS-assigned port for the dev e2e server.
//
// The Windows Hyper-V dynamic exclusion range can include any sub-range
// of 49152-65535 at boot, so a hardcoded port may fail to bind with
// EACCES. Asking the OS for a port via listen(0) returns one that is
// guaranteed bindable from userspace.
//
// We cache the allocation in process.env.E2E_DEV_PORT so child processes
// (dev-server.js, Playwright workers) inherit the same value.

import { createServer } from 'node:net';

function pickFreePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			if (!addr || typeof addr === 'string') {
				srv.close();
				return reject(new Error('listen(0) returned no address'));
			}
			const port = addr.port;
			srv.close(() => resolve(port));
		});
	});
}

async function getOrAllocate(envVar) {
	if (process.env[envVar]) return Number(process.env[envVar]);
	const port = await pickFreePort();
	process.env[envVar] = String(port);
	return port;
}

export const DEV_PORT = await getOrAllocate('E2E_DEV_PORT');
export const PROD_PORT = await getOrAllocate('E2E_PROD_PORT');
