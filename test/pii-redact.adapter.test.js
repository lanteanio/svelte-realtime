import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const workers = [];
let socket;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label) {
	const deadline = performance.now() + 10000;
	while (performance.now() < deadline) {
		const value = read();
		if (value) return value;
		await sleep(5);
	}
	throw new Error('Timed out waiting for ' + label);
}
afterEach(async () => {
	socket?.close();
	await Promise.all(workers.splice(0).map(worker => new Promise((resolve, reject) => {
		if (worker.exitCode !== null) return reject(new Error(worker.stderrText || 'Instance stopped early'));
		const timer = setTimeout(() => { worker.kill(); reject(new Error('Instance did not stop')); }, 5000);
		worker.once('exit', code => { clearTimeout(timer); code ? reject(new Error(worker.stderrText)) : resolve(); });
		worker.send({ type: 'stop' });
	})));
});

it('never relays failed pattern redaction to a native peer or its replay buffer', async () => {
	const ready = [];
	const replies = new Map();
	const errors = [];
	for (const role of ['publisher', 'receiver']) {
		const worker = fork(fileURLToPath(new URL('./helpers/redact-cluster-instance.js', import.meta.url)), [role], {
			execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
		});
		workers.push(worker);
		worker.on('error', error => errors.push(error));
		worker.stderr.on('data', data => { worker.stderrText = (worker.stderrText || '') + data; });
		worker.on('message', message => {
			if (message.type === 'ready') ready.push({ role, url: message.url });
			else if (message.type === 'relay') workers[1].send(message);
			else if (message.type === 'published') replies.set(message.id, message);
		});
	}
	await until(() => { if (errors.length) throw errors[0]; return ready.length === 2; }, 'both instances');
	socket = new WebSocket(ready.find(instance => instance.role === 'receiver').url);
	const frames = [];
	socket.addEventListener('message', event => frames.push(JSON.parse(event.data)));
	await until(() => socket.readyState === WebSocket.OPEN, 'native peer socket');
	for (const [rpc, args] of [['private/feed', ['room']], ['private/typing', []]]) {
		socket.send(JSON.stringify({ rpc, id: rpc, args, stream: true }));
		const response = await until(() => frames.find(frame => frame.topic === '__rpc' && frame.event === rpc), 'stream admission');
		expect(response.data.error).toBeUndefined();
	}
	let replaySeq = 0;
	for (const method of ['publish', 'out-of-band', 'publishThrottled', 'publishDebounced', 'batch']) {
		workers[0].send({ type: 'publish', method, id: method });
		const reply = await until(() => replies.get(method), 'publisher result');
		expect(reply.exact).toBe(false);
		expect(reply.rejectedSeq).toBe(replaySeq);
		if (method === 'publish' || method === 'out-of-band') replaySeq++;
		await until(() => frames.some(frame => frame.topic === 'private:typing' && frame.data.typing === method), 'unaffected sibling via ' + method);
		await until(() => frames.some(frame => frame.topic === 'private:room' && frame.data.text === method), 'safe protected publish');
		expect(frames.filter(frame => frame.topic === 'private:room' && frame.event === 'set').map(frame => frame.data))
			.toEqual(['publish', 'out-of-band', 'publishThrottled', 'publishDebounced', 'batch'].slice(0, replies.size).map(text => ({ text })));
		expect(JSON.stringify(frames)).not.toContain('NEVER-SEND');
	}
}, 30000);
