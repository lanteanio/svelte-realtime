import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

let server, browser, page, origin;
beforeAll(async () => {
	server = createServer(async (req, res) => {
		if (req.url === '/') {
			res.setHeader('Content-Type', 'text/html');
			res.end('<button id="host">Host control</button><script type="module">import { configureDevtools } from "/src/devtools.js"; window.configureDevtools = configureDevtools; import { __devtools } from "/src/client/devtools-instrument.js"; window.realDevtools = __devtools;</script>');
			return;
		}
		if (!/^\/src\/[a-z/-]+\.js$/.test(req.url)) { res.writeHead(404).end(); return; }
		try {
			const body = await readFile(new URL('..' + req.url, import.meta.url));
			res.setHeader('Content-Type', 'text/javascript');
			res.end(body);
		} catch { res.writeHead(404).end(); }
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	origin = 'http://127.0.0.1:' + server.address().port;
	browser = await chromium.launch({ headless: true });
}, 30000);
beforeEach(async () => {
	await page?.close();
	page = await browser.newPage();
	await page.goto(origin);
	await page.getByRole('button', { name: 'Toggle svelte-realtime DevTools' }).waitFor();
});
afterAll(async () => {
	await browser?.close();
	if (server) await new Promise(resolve => server.close(resolve));
});
describe('DevTools focus', () => {
	it('opens a named non-modal region and restores focus through close and Escape', async () => {
		await page.locator('#host').focus();
		await page.keyboard.press('Control+Shift+L');
		const region = page.getByRole('region', { name: 'svelte-realtime DevTools' });
		expect(await region.isVisible()).toBe(true);
		expect(await page.getByRole('button', { name: 'Close DevTools' }).evaluate(el => el === document.activeElement)).toBe(true);
		await page.keyboard.press('Escape');
		expect(await region.isVisible()).toBe(false);
		expect(await page.locator('#host').evaluate(el => el === document.activeElement)).toBe(true);
		const launcher = page.getByRole('button', { name: 'Toggle svelte-realtime DevTools' });
		await launcher.click();
		expect(await launcher.getAttribute('aria-expanded')).toBe('true');
		await page.getByRole('button', { name: 'Close DevTools' }).click();
		expect(await launcher.evaluate(el => el === document.activeElement)).toBe(true);
		expect(await launcher.getAttribute('aria-expanded')).toBe('false');
	});
});
async function streamsFixture() {
 await page.evaluate(() => { window.__svelte_realtime_devtools = window.realDevtools; Object.assign(window.realDevtools, { pending: new Map(), history: [], streams: new Map([['chat', { path: 'chat', topic: 'chat', subCount: 1, recentEvents: [], lastEventTime: Date.now(), lastEvent: 'update' }]]) }); });
 await page.getByRole('button', { name: 'Toggle svelte-realtime DevTools' }).click();
}
it('provides roving tabs and keyboard stream expansion with readable toggle states', async () => {
 await streamsFixture();
 const rpcs = page.getByRole('tab', { name: 'rpcs', exact: true });
 await rpcs.focus();
 await page.keyboard.press('ArrowRight');
 const streams = page.getByRole('tab', { name: 'streams', exact: true });
 expect(await streams.getAttribute('aria-selected')).toBe('true');
 expect(await rpcs.getAttribute('tabindex')).toBe('-1');
 expect(await page.getByRole('tabpanel', { name: 'streams' }).count()).toBe(1);
 const expand = page.locator('[data-action="toggle-stream"]');
 await expand.focus();
 await page.keyboard.press('Enter');
 expect(await expand.getAttribute('aria-expanded')).toBe('true');
 expect(await page.locator('[id="' + await expand.getAttribute('aria-controls') + '"]').isVisible()).toBe(true);
 const pause = page.getByRole('button', { name: 'Pause event capture' });
 expect(await pause.getAttribute('aria-pressed')).toBe('false');
 await pause.click();
 expect(await pause.getAttribute('aria-pressed')).toBe('true');
 await streams.focus();
 await page.keyboard.press('End');
 expect(await page.getByRole('tab', { name: 'connection', exact: true }).getAttribute('aria-selected')).toBe('true');
 await page.keyboard.press('Home');
 expect(await rpcs.getAttribute('aria-selected')).toBe('true');
});

it('retains controls and focused stream nodes across ticks, toggles, and list insertion', async () => {
 await streamsFixture();
 await page.getByRole('tab', { name: 'streams', exact: true }).click();
 const pause = page.getByRole('button', { name: 'Pause event capture' });
 await pause.focus();
 await page.evaluate(() => { window.savedControl = document.activeElement; });
 await page.waitForTimeout(1200);
 expect(await pause.evaluate(el => el === document.activeElement && el === window.savedControl)).toBe(true);
 await pause.click();
 expect(await pause.evaluate(el => el === document.activeElement && el === window.savedControl)).toBe(true);
 const expander = page.locator('[data-action="toggle-stream"]');
 await expander.focus();
 await page.keyboard.press('Enter');
 expect(await expander.evaluate(el => el === document.activeElement)).toBe(true);
 await page.evaluate(() => {
  window.savedStream = document.activeElement;
  const dt = window.__svelte_realtime_devtools;
  dt.streams = new Map([['first', { path: 'first', subCount: 1, recentEvents: [] }], ...dt.streams]);
 });
 await page.waitForTimeout(1200);
 expect(await page.locator('[data-stream-path="chat"]').evaluate(el => el === document.activeElement && el === window.savedStream)).toBe(true);
});

it('fits a narrow viewport and remains reachable after movement and resize', async () => {
 await page.setViewportSize({ width: 320, height: 240 });
 await streamsFixture();
 const panel = page.getByRole('region', { name: 'svelte-realtime DevTools' });
 const inside = async () => {
  const rect = await panel.boundingBox();
  const size = page.viewportSize();
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(size.width);
  expect(rect.y + rect.height).toBeLessThanOrEqual(size.height);
 };
 await inside();
 const move = page.getByRole('button', { name: 'Move DevTools' });
 await move.focus();
 await page.keyboard.press('Home');
 await page.keyboard.press('ArrowLeft');
 await page.keyboard.press('ArrowUp');
 await inside();
 await page.keyboard.press('End');
 await inside();
 await page.setViewportSize({ width: 250, height: 200 });
 await page.waitForFunction(() => document.getElementById('svelte-realtime-devtools').getBoundingClientRect().bottom <= innerHeight);
 await inside();
 await move.click();
 await inside();
});

it('honors host theme tokens and keeps selected tabs identifiable in forced colors', async () => {
 await page.evaluate(() => { document.documentElement.style.setProperty('--svr-dt-surface', 'rgb(20, 30, 40)'); });
 await streamsFixture();
 expect(await page.locator('#svelte-realtime-devtools').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(20, 30, 40)');
 await page.emulateMedia({ forcedColors: 'active' });
 expect(await page.getByRole('tab', { name: 'rpcs', exact: true }).evaluate(el => getComputedStyle(el).textDecorationLine)).toContain('underline');
});

it('renders readable text and a high-contrast inset keyboard outline', async () => {
 await streamsFixture();
 await page.getByRole('tab', { name: 'streams', exact: true }).click();
 await page.locator('[data-action="toggle-stream"]').click();
 const pairs = await page.locator('#svelte-realtime-devtools').evaluate(root => {
  return [...root.querySelectorAll('*')].filter(el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && el.getBoundingClientRect().height > 0).map(el => {
   let bg = el;
   while (bg && getComputedStyle(bg).backgroundColor === 'rgba(0, 0, 0, 0)') bg = bg.parentElement;
   return [el.textContent, getComputedStyle(el).color, getComputedStyle(bg).backgroundColor];
  });
 });
 const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
 const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
 for (const [text, foreground, background] of pairs) expect(contrast(foreground, background), text).toBeGreaterThanOrEqual(4.5);
 await page.getByRole('tab', { name: 'streams', exact: true }).focus();
 await page.keyboard.press('ArrowRight');
 const focus = await page.getByRole('tab', { name: 'smooth', exact: true }).evaluate(el => {
  const style = getComputedStyle(el);
  return { width: style.outlineWidth, color: style.outlineColor, offset: style.outlineOffset, background: getComputedStyle(document.getElementById('svelte-realtime-devtools')).backgroundColor };
 });
 expect(focus.width).toBe('2px');
 expect(focus.offset).toBe('-2px');
 expect(contrast(focus.color, focus.background)).toBeGreaterThanOrEqual(3);
});

it('wraps long diagnostic identifiers without clipping them', async () => {
 await page.setViewportSize({ width: 320, height: 600 });
 await streamsFixture();
 await page.evaluate(() => {
  const long = 'identifier'.repeat(80);
  const dt = window.__svelte_realtime_devtools;
  dt.pending.set('p', { path: long, startTime: Date.now() });
  dt.history = [{ path: long, ok: false, duration: 1, seq: 1 }];
  dt.streams = new Map([[long, { path: long, topic: long, subCount: 1, recentEvents: [], error: { code: long, message: long } }]]);
  dt.smooth = new Set([() => ({ topic: long, self: long, overflowed: true })]);
 });
 for (const name of ['streams', 'smooth', 'rpcs']) {
  await page.getByRole('tab', { name, exact: true }).click();
  const rows = await page.locator('#svr-dt-content').evaluate(root => [...root.querySelectorAll('div, button')].filter(el => el.getBoundingClientRect().width > 0).map(el => [el.scrollWidth, el.clientWidth]));
  for (const [scroll, client] of rows) expect(scroll).toBeLessThanOrEqual(client + 1);
 }
});

it('shows every retained RPC record from empty history through the full ring', async () => {
 await streamsFixture();
 const counts = await page.evaluate(() => {
  const results = [];
  for (let count = 0; count <= 50; count++) {
   window.__svelte_realtime_devtools.history = Array.from({ length: count }, (_, seq) => ({ seq, path: 'call/' + seq, ok: true, duration: seq }));
   document.getElementById('svr-dt-tab-rpcs').click();
   results.push(document.querySelectorAll('[data-rpc-history]').length);
  }
  return results;
 });
 expect(counts).toEqual(Array.from({ length: 51 }, (_, count) => count));
 expect(await page.locator('[data-rpc-history]').first().textContent()).toContain('call/49');
 expect(await page.locator('[data-rpc-history]').last().textContent()).toContain('call/0');
});

it('explains how to populate empty views and describes prediction recovery', async () => {
 await streamsFixture();
 expect(await page.locator('#svr-dt-content').textContent()).toContain('Call a realtime function');
 await page.evaluate(() => { window.__svelte_realtime_devtools.streams.clear(); });
 await page.getByRole('tab', { name: 'streams', exact: true }).click();
 expect(await page.locator('#svr-dt-content').textContent()).toContain('Subscribe to a live stream');
 await page.getByRole('tab', { name: 'smooth', exact: true }).click();
 expect(await page.locator('#svr-dt-content').textContent()).toContain('Create a live.smooth view');
 await page.evaluate(() => { window.__svelte_realtime_devtools.smooth = new Set([() => ({ overflowed: true })]); });
 await page.getByRole('tab', { name: 'smooth', exact: true }).click();
 expect(await page.locator('#svr-dt-content').textContent()).toContain('Prediction paused - waiting for resync (Command window full)');
});

it('keeps emoji, combining marks, and joined sequences intact at the preview boundary', async () => {
 await streamsFixture();
 await page.getByRole('tab', { name: 'streams', exact: true }).click();
 await page.locator('[data-action="toggle-stream"]').click();
 for (const grapheme of ['\u{1f600}', 'e\u0301', '\u{1f469}\u200d\u{1f4bb}', '\u{1f1e9}\u{1f1ea}']) {
  await page.evaluate(value => {
   window.__svelte_realtime_devtools.streams.get('chat').recentEvents = [{ event: 'update', ts: Date.now(), data: 'a'.repeat(198) + value + 'tail' }];
   document.getElementById('svr-dt-tab-streams').click();
  }, grapheme);
  const text = await page.locator('#svr-dt-content').textContent();
  expect(text).toContain('a'.repeat(198) + grapheme + '... [+5 code units]');
  expect(text.isWellFormed()).toBe(true);
 }
});

it('formats telemetry by locale and isolates identifiers in right-to-left presentation', async () => {
 await streamsFixture();
 await page.evaluate(async () => {
  window.configureDevtools({ locale: 'ar-EG', messages: { streams: 'Streams translated' } });
  const stream = window.__svelte_realtime_devtools.streams.get('chat');
  stream.subCount = 1234;
 });
 const tab = page.getByRole('tab', { name: 'Streams translated', exact: true });
 await tab.click();
 expect(await page.locator('#svelte-realtime-devtools').getAttribute('dir')).toBe('rtl');
 expect(await page.locator('#svelte-realtime-devtools').getAttribute('lang')).toBe('ar-EG');
 expect(await page.locator('#svr-dt-content').textContent()).toContain(new Intl.NumberFormat('ar-EG').format(1234));
 expect(await page.locator('[data-action="toggle-stream"] bdi').getAttribute('dir')).toBe('auto');
 expect(await page.locator('#svr-dt-content').textContent()).toContain(new Intl.RelativeTimeFormat('ar-EG', { numeric: 'auto' }).format(0, 'second'));
});

it('keeps focus on reordered stream controls and falls back when the stream leaves', async () => {
 await streamsFixture();
 await page.getByRole('tab', { name: 'streams', exact: true }).click();
 await page.locator('[data-stream-path="chat"]').focus();
 await page.evaluate(() => {
  const dt = window.__svelte_realtime_devtools;
  window.focusedRow = document.activeElement;
  dt.streams.set('other', { path: 'other', subCount: 1, recentEvents: [] });
  document.getElementById('svr-dt-tab-streams').click();
  dt.streams = new Map([...dt.streams].reverse());
  document.getElementById('svr-dt-tab-streams').click();
 });
 expect(await page.locator('[data-stream-path="chat"]').evaluate(el => el === window.focusedRow && el === document.activeElement)).toBe(true);
 await page.evaluate(() => {
  window.__svelte_realtime_devtools.streams.delete('other');
  document.getElementById('svr-dt-tab-streams').click();
 });
 expect(await page.locator('[data-stream-path="chat"]').evaluate(el => el === document.activeElement)).toBe(true);
 await page.evaluate(() => {
  window.__svelte_realtime_devtools.streams.delete('chat');
  document.getElementById('svr-dt-tab-streams').click();
 });
 expect(await page.getByRole('tabpanel').evaluate(el => el === document.activeElement)).toBe(true);
});

it('reclamps a moved panel when telemetry grows and when reopened after a resize', async () => {
 await page.setViewportSize({ width: 600, height: 600 });
 await streamsFixture();
 await page.getByRole('button', { name: 'Move DevTools' }).focus();
 await page.keyboard.press('End');
 await page.evaluate(() => {
  window.__svelte_realtime_devtools.history = Array.from({ length: 50 }, (_, seq) => ({ seq, path: 'call/' + seq, ok: true, duration: 1 }));
  document.getElementById('svr-dt-tab-rpcs').click();
 });
 const panel = page.getByRole('region', { name: 'svelte-realtime DevTools' });
 let rect = await panel.boundingBox();
 expect(rect.y + rect.height).toBeLessThanOrEqual(600);
 await page.getByRole('button', { name: 'Close DevTools' }).click();
 await page.setViewportSize({ width: 320, height: 240 });
 await page.getByRole('button', { name: 'Toggle svelte-realtime DevTools' }).click();
 rect = await panel.boundingBox();
 expect(rect.x + rect.width).toBeLessThanOrEqual(320);
 expect(rect.y + rect.height).toBeLessThanOrEqual(240);
});

it('shows connection state, cause, and an appropriate recovery action', async () => {
 await streamsFixture();
 await page.evaluate(() => { window.__svelte_realtime_devtools.connection = { state: 'failed', since: Date.now() - 5000, failure: { class: 'TERMINAL', kind: 'ws-close', code: 4401 } }; });
 await page.getByRole('tab', { name: 'connection', exact: true }).click();
 expect(await page.locator('#svr-dt-connection').textContent()).toBe('Connection stopped');
 expect(await page.getByRole('tabpanel').textContent()).toContain('TERMINAL');
 expect(await page.getByRole('tabpanel').textContent()).toContain('4401');
 expect(await page.getByRole('tabpanel').textContent()).toContain('Check your session, then reload');
 await page.evaluate(() => { window.__svelte_realtime_devtools.connection = { state: 'open', since: Date.now(), failure: null }; });
 await page.getByRole('tab', { name: 'connection', exact: true }).click();
 expect(await page.locator('#svr-dt-connection').textContent()).toBe('Connected');
 expect(await page.getByRole('tabpanel').textContent()).not.toContain('TERMINAL');
});

it('announces meaningful transitions once while ordinary telemetry ticks stay quiet', async () => {
 await streamsFixture();
 const status = page.getByRole('status');
 expect(await status.getAttribute('aria-live')).toBe('polite');
 expect(await status.getAttribute('aria-atomic')).toBe('true');
 await page.evaluate(() => {
  window.announcements = [];
  new MutationObserver(() => window.announcements.push(document.querySelector('[role="status"]').textContent)).observe(document.querySelector('[role="status"]'), { childList: true, subtree: true, characterData: true });
  window.__svelte_realtime_devtools.connection = { state: 'open', since: Date.now() };
  document.getElementById('svr-dt-tab-streams').click();
 });
 await page.waitForTimeout(1200);
 expect(await page.evaluate(() => window.announcements)).toEqual(['Connection: Connected.']);
 await page.getByRole('button', { name: 'Pause event capture' }).click();
 expect(await status.textContent()).toBe('Event capture paused.');
 await page.getByRole('button', { name: 'Clear events', exact: true }).click();
 expect(await status.textContent()).toBe('Captured stream events cleared.');
 await page.evaluate(() => {
  window.__svelte_realtime_devtools.streams.get('chat').error = { code: 'FORBIDDEN' };
  document.getElementById('svr-dt-tab-streams').click();
 });
 expect(await status.textContent()).toBe('Streams with errors: 1.');
});

it('offers Undo clear and preserves events received after clearing', async () => {
 await streamsFixture();
 await page.evaluate(() => { window.realDevtools.streams.get('chat').recentEvents = [{ event: 'before', data: 1, ts: Date.now() }]; });
 await page.getByRole('tab', { name: 'streams', exact: true }).click();
 await page.locator('[data-action="toggle-stream"]').click();
 await page.getByRole('button', { name: 'Clear events', exact: true }).click();
 expect(await page.locator('#svr-dt-content').textContent()).not.toContain('before');
 await page.evaluate(() => { window.realDevtools.streams.get('chat').recentEvents.push({ event: 'after', data: 2, ts: Date.now() }); });
 await page.getByRole('button', { name: 'Undo clear (1)', exact: true }).click();
 expect(await page.locator('#svr-dt-content').textContent()).toContain('before');
 expect(await page.locator('#svr-dt-content').textContent()).toContain('after');
});
