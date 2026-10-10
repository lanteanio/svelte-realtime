import { afterEach, beforeEach, expect, it } from 'vitest';
import { live, __registerCron, _clearCron, _tickCron, setCronPlatform, configureCron } from '../src/server.js';
import { readFileSync } from 'node:fs';

// Use this unit process's real server exports without requiring the browser
// fixture's separate dependency installation. Only the ESM bindings change.
const fixtureSource = readFileSync(new URL('./fixture/src/live/cronjobs.js', import.meta.url), 'utf8');
const fixture = new Function('live', '_tickCron', fixtureSource
	.replace("import { live, _tickCron } from 'svelte-realtime/server';", '')
	.replaceAll('export const ', 'const ') + '\nreturn { statsCron, feedCron, tickNow, resetCron, getCounts, feed, stats };');
const { statsCron, feedCron, tickNow, resetCron, getCounts, feed, stats } = fixture(live, _tickCron);

const published = [];
const platform = { publish: (topic, event, data) => { published.push({ topic, event, data }); } };
const ctx = { publish: platform.publish };
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
beforeEach(async () => {
	_clearCron(); configureCron(null); setCronPlatform(platform);
	__registerCron('fixture/stats', statsCron); __registerCron('fixture/feed', feedCron);
	await resetCron(ctx); published.length = 0;
});
afterEach(() => { _clearCron(); });

it('keeps startup and scheduled ticks from adding unrequested browser fixture data', async () => {
	await _tickCron(); await flush();
	expect(await getCounts()).toMatchObject({ ticks: 0, itemCount: 0 });
	expect(await feed(ctx)).toEqual([]); expect(await stats(ctx)).toBeNull();
	expect(published).toEqual([]);
});

it('consumes each explicit tick once even when another scheduler wake follows', async () => {
	await tickNow(); await _tickCron(); await flush();
	await tickNow(); await _tickCron(); await flush();
	expect(await getCounts()).toMatchObject({ ticks: 2, itemCount: 2 });
	expect((await feed(ctx)).map(item => item.id)).toEqual(['i1', 'i2']);
});

it('serializes reset after an already accepted tick and confirms empty server state', async () => {
	const ticking = tickNow(); const resetting = resetCron(ctx);
	await Promise.all([ticking, resetting]);
	expect(await getCounts()).toMatchObject({ ticks: 0, itemCount: 0 });
	expect(await feed(ctx)).toEqual([]); expect(await stats(ctx)).toBeNull();
	expect(published.slice(-2)).toEqual([
		{ topic: 'feed', event: 'refreshed', data: [] }, { topic: 'stats', event: 'set', data: null }
	]);
});
