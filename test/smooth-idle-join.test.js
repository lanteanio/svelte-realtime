import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
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

async function pair(interest, options = {}) {
	const urls = [];
	const errors = [];
	const local = ['A', 'B'].map(instanceId => fork(
		fileURLToPath(new URL('./helpers/smooth-cluster-instance.js', import.meta.url)),
		[JSON.stringify({ instanceId, interest, ...options })],
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

const budgetRuntime = process.env.REALTIME_SMOOTH_BUDGET_RUNTIME;
const installedSmooth = await import('svelte-adapter-uws/plugins/smooth');
let installedHasBudget = false;
try { installedSmooth.createSmoothAuthority({ apply: state => state, maxCommandsPerTick: 0 }); }
catch { installedHasBudget = true; }

for (const maxCommandsPerTick of [undefined, 1, 2]) it.skipIf(!native || (maxCommandsPerTick !== undefined && !budgetRuntime && !installedHasBudget))('paces local and relayed command bursts on the owner (budget=' + maxCommandsPerTick + ')', async () => {
	const [ownerUrl, edgeUrl] = await pair(false, {
		maxCommandsPerTick,
		...(budgetRuntime && { runtimeUrl: pathToFileURL(resolve(budgetRuntime)).href })
	});
	const local = await join(ownerUrl);
	const remote = await join(edgeUrl);
	const send = (client, count) => client.ws.send(JSON.stringify({
		rpc: 'idle/shape/__smooth/command',
		args: ['room', Array.from({ length: count }, (_, index) => ({ id: index + 1, cmd: { dx: 1 } }))]
	}));
	const acks = client => client.messages.filter(message => message.topic === '__smooth:idle:room' && message.event === 'ack').map(message => message.data);
	send(local, 5);
	send(remote, 11);
	await until(() => acks(local).at(-1)?.id === 5 && acks(remote).at(-1)?.id === 11, 'both ordered command tails');
	for (const [client, count] of [[local, 5], [remote, 11]]) {
		const expected = maxCommandsPerTick === undefined ? [count]
			: Array.from({ length: Math.ceil(count / maxCommandsPerTick) }, (_, index) => Math.min(count, (index + 1) * maxCommandsPerTick));
		expect(acks(client).map(ack => ack.id)).toEqual(expected);
		expect(acks(client).map(ack => ack.state.x)).toEqual(expected);
	}
}, 30000);

it.skipIf(!native || (!budgetRuntime && !installedHasBudget))('keeps trusted server injections unpaced beside relayed client commands', async () => {
	const [ownerUrl, edgeUrl] = await pair(false, {
		maxCommandsPerTick: 1, injectAfterCommand: true,
		...(budgetRuntime && { runtimeUrl: pathToFileURL(resolve(budgetRuntime)).href })
	});
	await join(ownerUrl);
	const remote = await join(edgeUrl);
	remote.ws.send(JSON.stringify({
		rpc: 'idle/shape/__smooth/command',
		args: ['room', [1, 2, 3].map(id => ({ id, cmd: { dx: 1 } }))]
	}));
	const acks = () => remote.messages.filter(message => message.event === 'ack').map(message => message.data);
	await until(() => acks().at(-1)?.id === 3, 'injected and client command states');
	expect(acks().map(ack => ack.id)).toEqual([1, 2, 3]);
	expect(acks().map(ack => ack.state.x)).toEqual([1, 302, 303]);
}, 30000);
