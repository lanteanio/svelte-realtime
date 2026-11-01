import { parentPort } from 'node:worker_threads';
import { realtime, live, __registerAggregate, _activateDerived, _resetAggregates, configureForget } from '../../src/server.js';

let nextId = 0;
const pending = new Map();
function storeCall(method, args) {
	const id = ++nextId;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		parentPort.postMessage({ store: { id, method, args } });
	});
}
const store = {
	namespace: 'aggregate-test',
	issueErasure: () => storeCall('issueErasure', []),
	readGeneration: topic => storeCall('readGeneration', [topic]),
	advanceGeneration: (topic, token) => storeCall('advanceGeneration', [topic, token])
};
realtime({ privacySecret: 'generation-test-secret', aggregateGenerationStore: store });
const aggregate = live.aggregate('source', { count: { init: () => 0, reduce: value => value + 1 } }, {
	topic: 'output', forget: 'reset', privacy: { strategy: 'perturb', epsilon: 1, sensitivity: 1 }
});
__registerAggregate('worker/aggregate', aggregate);
let last;
const platform = { publish(topic, _event, value) { if (topic === 'output') last = value; return true; } };
_activateDerived(platform); configureForget({ platform });
parentPort.on('message', async message => {
	if (message.storeResult) {
		const { id, value, error } = message.storeResult, waiter = pending.get(id);
		pending.delete(id);
		if (error) waiter.reject(new Error(error)); else waiter.resolve(value);
		return;
	}
	const { id, operation, token } = message;
	try {
		let value;
		if (operation === 'ready') value = await aggregate();
		else if (operation === 'add') { platform.publish('source', 'add', {}); value = last; }
		else if (operation === 'erase') value = await live.forget('person', { aggregateErasure: token });
		else if (operation === 'close') _resetAggregates();
		else throw new Error('Unknown operation');
		parentPort.postMessage({ id, value });
	} catch { parentPort.postMessage({ id, error: 'Worker operation failed' }); }
});
