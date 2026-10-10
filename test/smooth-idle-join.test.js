import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

let native;
try { native = await import('uWebSockets.js'); } catch { native = null; }
const workers = [];
const clients = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 5000) {
	const deadline = performance.now() + timeout;
	while (performance.now() < deadline) {
		const value = read();
		if (value) return value;
		await sleep(10);
	}
	throw new Error('Timed out waiting for ' + label);
}
afterEach(async () => {
	for (const client of clients.splice(0)) client.ws.close();
	await Promise.all(workers.splice(0).map(worker => new Promise((resolve, reject) => {
		if (worker.exitCode !== null || worker.signalCode !== null) {
			if (worker.exitCode === 0) resolve();
			else reject(new Error('Realtime instance stopped unexpectedly: ' + worker.stderrText));
			return;
		}
		const timer = setTimeout(() => { worker.kill(); reject(new Error('Realtime instance did not stop')); }, 5000);
		worker.once('exit', code => {
			clearTimeout(timer);
			if (code) reject(new Error('Realtime instance exited with code ' + code + ': ' + worker.stderrText));
			else resolve();
		});
		worker.send({ type: 'stop' });
	})));
});

async function pair(interest) {
	const urls = [];
	const errors = [];
	const local = ['A', 'B'].map(instanceId => fork(
		fileURLToPath(new URL('./helpers/smooth-cluster-instance.js', import.meta.url)),
		[JSON.stringify({ instanceId, interest })],
		{ execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
	));
	workers.push(...local);
	local.forEach((worker, i) => {
		worker.on('error', error => errors.push(error));
		worker.stderr.on('data', data => {
			worker.stderrText = ((worker.stderrText || '') + data).slice(-8192);
			errors.push(new Error(String(data)));
		});
		worker.on('message', message => {
			if (message.type === 'ready') urls[i] = message.url;
			else if (message.type === 'relay' && local[1 - i].connected) local[1 - i].send(message);
		});
	});
	await until(() => {
		if (errors.length) throw errors[0];
		return urls[0] && urls[1];
	}, 'both realtime instances', 10000);
	return urls;
}

async function join(url) {
	const ws = new WebSocket(url);
	const messages = [];
	ws.addEventListener('message', event => messages.push(JSON.parse(event.data)));
	const client = { ws, messages, updates: key => messages.filter(m => m.topic === '__smooth:idle:room' && m.event === 'update' && m.data.key === key) };
	clients.push(client);
	await until(() => ws.readyState === WebSocket.OPEN, 'socket open');
	let sequence = 0;
	client.sync = async () => {
		const id = 's' + ++sequence;
		ws.send(JSON.stringify({ rpc: 'idle/shape/__smooth/sync', id, args: ['room'] }));
		const reply = await until(() => messages.find(m => m.topic === '__rpc' && m.event === id), 'smooth sync');
		expect(reply.data.error).toBeUndefined();
		return reply.data.data;
	};
	client.you = (await client.sync()).you;
	return client;
}

it.skipIf(!native).each([false, true])('announces idle local and remote joins to earlier non-owner subscribers (interest=%s)', async interest => {
	const [ownerUrl, edgeUrl] = await pair(interest);
	await join(ownerUrl); // Establish the owner before the first forwarded sync.
	const earlier = await join(edgeUrl);
	for (const url of [ownerUrl, edgeUrl]) {
		const later = await join(url);
		await until(() => earlier.updates(later.you).length > 0, 'idle later joiner on the earlier subscriber');
		expect(earlier.updates(later.you)[0].data.data).toEqual({ x: 0, y: 0 });
		expect(later.updates(later.you)).toEqual([]);
		// Rebinding the same entity is not another creation announcement.
		const count = earlier.updates(later.you).length;
		await later.sync();
		await sleep(60);
		expect(earlier.updates(later.you)).toHaveLength(count);
	}
}, 30000);
