// @ts-check
// DevTools overlay for svelte-realtime (dev-mode only)
// Injected by the Vite plugin via transformIndexHtml

import { now, setIntervalTimer, clearIntervalTimer } from './client-runtime.js';

/** @type {HTMLElement | null} */
let panel = null;
let visible = false;
let activeTab = 'rpcs';
/** @type {HTMLElement | null} */
let previousFocus = null;
/** @type {HTMLButtonElement | null} */
let launcher = null;

/** @type {ReturnType<typeof setInterval> | null} */
let refreshInterval = null;

/** Paths whose recentEvents are currently expanded in the Streams tab. */
/** @type {Set<string>} */
const expandedStreams = new Set();

/** Pretty (false) vs raw (true) JSON rendering for stream payloads. */
let streamsRawMode = false;

/** Mirror of `__devtools.paused` so the toggle survives panel re-renders. */
let streamsPaused = false;

try {
	if (typeof localStorage !== 'undefined') {
		streamsRawMode = localStorage.getItem('svr-dt-raw') === '1';
		streamsPaused = localStorage.getItem('svr-dt-paused') === '1';
	}
} catch {}

/** Force the next render() call to repaint, ignoring _lastRenderedHtml dedupe. */
function _forceRerender() {
	_lastRenderedHtml = '';
	if (!panel) return;
	const content = panel.querySelector('div:last-child');
	if (content) render(/** @type {HTMLElement} */ (content));
}

function toggle() {
	visible = !visible;
	if (visible) previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	if (panel) panel.style.display = visible ? 'flex' : 'none';
	launcher?.setAttribute('aria-expanded', String(visible));
	if (visible) panel?.querySelector('button[aria-label="Close DevTools"]')?.focus();
	else if (previousFocus?.isConnected) previousFocus.focus();
	else launcher?.focus();
	if (visible && !refreshInterval) {
		const content = panel?.querySelector('div:last-child');
		if (content) render(/** @type {HTMLElement} */ (content));
		refreshInterval = setIntervalTimer(() => {
			const content = panel?.querySelector('div:last-child');
			if (content) render(/** @type {HTMLElement} */ (content));
		}, 1000);
	} else if (!visible && refreshInterval) {
		clearIntervalTimer(refreshInterval);
		refreshInterval = null;
	}
}

function init() {
	if (panel) return;

	document.addEventListener('keydown', (e) => {
		if (e.ctrlKey && e.shiftKey && e.key === 'L') {
			e.preventDefault();
			toggle();
		}
		if (e.key === 'Escape' && visible && panel?.contains(document.activeElement)) {
			e.preventDefault();
			toggle();
		}
	});

	panel = document.createElement('div');
	panel.id = 'svelte-realtime-devtools';
	panel.style.colorScheme = 'dark';
	panel.setAttribute('role', 'region');
	panel.setAttribute('aria-label', 'svelte-realtime DevTools');
	panel.style.cssText = `
		color-scheme: dark; display: none; flex-direction: column; box-sizing: border-box; position: fixed; bottom: 10px; right: 10px; width: min(420px, calc(100vw - 20px)); max-height: min(400px, calc(100dvh - 20px));
		background: var(--svr-dt-surface, #1a1a2e); color: var(--svr-dt-text, #f2f4ff); border: 1px solid var(--svr-dt-border, #7d859a); border-radius: 8px;
		font-family: monospace; font-size: 12px; z-index: 99999; overflow: hidden;
		box-shadow: 0 4px 20px rgba(0,0,0,0.5);
	`;

	const header = document.createElement('div');
	header.style.cssText = `
		padding: 6px 10px; background: var(--svr-dt-raised, #16213e); display: flex; justify-content: space-between;
		align-items: center; gap: 8px; flex-shrink: 0; touch-action: none; cursor: move; user-select: none; border-bottom: 1px solid var(--svr-dt-border, #7d859a);
	`;
	header.innerHTML = '<span style="font-weight:bold;color:var(--svr-dt-accent, #ff819a)">svelte-realtime</span>';

	const closeBtn = document.createElement('button');
	closeBtn.textContent = 'x';
	closeBtn.setAttribute('aria-label', 'Close DevTools');
	closeBtn.style.cssText = 'background:none;border:none;color:var(--svr-dt-muted, #b3b8cc);cursor:pointer;font-size:14px;padding:0 4px;';
	closeBtn.onclick = toggle;
	const moveBtn = document.createElement('button');
	moveBtn.type = 'button';
	moveBtn.textContent = 'Move';
	moveBtn.setAttribute('aria-label', 'Move DevTools');
	moveBtn.title = 'Arrow keys move; Home and End dock; click cycles corners';
	header.appendChild(moveBtn);
	header.appendChild(closeBtn);

	/** @param {number} x @param {number} y */
 function movePanel(x, y) {
  if (!panel) return;
  const rect = panel.getBoundingClientRect();
  panel.style.left = Math.max(10, Math.min(x, window.innerWidth - rect.width - 10)) + 'px';
  panel.style.top = Math.max(10, Math.min(y, window.innerHeight - rect.height - 10)) + 'px';
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
 }
 let dragging = false, dx = 0, dy = 0;
 header.onpointerdown = (event) => {
  if (event.button !== 0 || /** @type {Element} */ (event.target).closest('button')) return;
  dragging = true;
  const rect = panel.getBoundingClientRect();
  dx = event.clientX - rect.left;
  dy = event.clientY - rect.top;
  header.setPointerCapture(event.pointerId);
 };
 header.onpointermove = (event) => { if (dragging) movePanel(event.clientX - dx, event.clientY - dy); };
 header.onpointerup = header.onpointercancel = () => { dragging = false; };
 moveBtn.onkeydown = (event) => {
  const rect = panel.getBoundingClientRect();
  const step = event.shiftKey ? 40 : 10;
  const positions = { ArrowLeft: [rect.left - step, rect.top], ArrowRight: [rect.left + step, rect.top], ArrowUp: [rect.left, rect.top - step], ArrowDown: [rect.left, rect.top + step], Home: [10, 10], End: [window.innerWidth, window.innerHeight] };
  const position = positions[event.key];
  if (!position) return;
  event.preventDefault();
  movePanel(position[0], position[1]);
 };
 let corner = 0;
 moveBtn.onclick = () => {
  movePanel(corner % 2 ? window.innerWidth : 10, corner > 1 ? window.innerHeight : 10);
  corner = (corner + 1) % 4;
 };
 window.addEventListener('resize', () => {
  if (!visible) return;
  const rect = panel.getBoundingClientRect();
  movePanel(rect.left, rect.top);
 });

	const tabs = document.createElement('div');
	tabs.setAttribute('role', 'tablist');
	tabs.setAttribute('aria-label', 'DevTools views');
	tabs.style.cssText = 'display:flex;flex-shrink:0;border-bottom:1px solid var(--svr-dt-border, #7d859a);';

	const content = document.createElement('div');
	content.id = 'svr-dt-content';
	content.setAttribute('role', 'tabpanel');
	content.setAttribute('aria-labelledby', 'svr-dt-tab-' + activeTab);
	content.tabIndex = 0;
	content.style.cssText = 'padding:8px;overflow:auto;min-height:0;max-height:320px;';

	const tabNames = ['rpcs', 'streams', 'smooth', 'connection'];
	for (const name of tabNames) {
		const btn = document.createElement('button');
		btn.textContent = name;
		btn.type = 'button';
		btn.id = 'svr-dt-tab-' + name;
		btn.setAttribute('role', 'tab');
		btn.setAttribute('aria-controls', content.id);
		btn.setAttribute('aria-selected', String(name === activeTab));
		btn.tabIndex = name === activeTab ? 0 : -1;
		btn.style.cssText = `
			flex:1;padding:5px;background:none;border:none;color:var(--svr-dt-muted, #b3b8cc);cursor:pointer;
			font-family:monospace;font-size:11px;border-bottom:2px solid transparent;
		`;
		btn.onclick = () => {
			activeTab = name;
			content.setAttribute('aria-labelledby', btn.id);
			_lastRenderedHtml = '';
			for (const b of tabs.children) {
				b.setAttribute('aria-selected', String(b === btn));
				/** @type {HTMLElement} */ (b).tabIndex = b === btn ? 0 : -1;
				/** @type {HTMLElement} */ (b).style.fontWeight = b === btn ? 'bold' : 'normal';
				/** @type {HTMLElement} */ (b).style.borderBottomColor = 'transparent';
				/** @type {HTMLElement} */ (b).style.color = 'var(--svr-dt-muted, #b3b8cc)';
			}
			btn.style.borderBottomColor = 'var(--svr-dt-accent, #ff819a)';
			btn.style.color = 'var(--svr-dt-text, #f2f4ff)';
			render(content);
		};
		if (name === activeTab) {
			btn.style.borderBottomColor = 'var(--svr-dt-accent, #ff819a)';
			btn.style.color = 'var(--svr-dt-text, #f2f4ff)';
		}
		btn.onkeydown = (event) => {
			const index = tabNames.indexOf(name);
			const next = event.key === 'ArrowRight' ? (index + 1) % tabNames.length
				: event.key === 'ArrowLeft' ? (index + tabNames.length - 1) % tabNames.length
				: event.key === 'Home' ? 0 : event.key === 'End' ? tabNames.length - 1 : -1;
			if (next < 0) return;
			event.preventDefault();
			const target = /** @type {HTMLButtonElement} */ (tabs.children[next]);
			target.focus();
			target.click();
		};
		tabs.appendChild(btn);
	}

	panel.appendChild(header);
	panel.appendChild(tabs);
	panel.appendChild(content);
	const styles = document.createElement('style');
 styles.textContent = `
  #svelte-realtime-devtools button, #svr-dt-launcher {
   font: inherit; color: var(--svr-dt-text, #f2f4ff); background: var(--svr-dt-raised, #16213e);
   border: 1px solid var(--svr-dt-border, #7d859a); border-radius: 3px; cursor: pointer;
  }
  #svelte-realtime-devtools div, #svelte-realtime-devtools span, #svelte-realtime-devtools button { min-width: 0; max-width: 100%; overflow-wrap: anywhere; box-sizing: border-box; }
  #svelte-realtime-devtools div { flex-wrap: wrap; }
  #svelte-realtime-devtools [aria-selected="true"] { font-weight: bold; text-decoration: underline; }
  #svelte-realtime-devtools :focus-visible, #svr-dt-launcher:focus-visible {
   outline: 2px solid var(--svr-dt-focus, #ffffff); outline-offset: -2px;
  }
  @media (forced-colors: active) {
   #svelte-realtime-devtools, #svr-dt-launcher {
    --svr-dt-surface: Canvas; --svr-dt-raised: Canvas; --svr-dt-text: CanvasText;
    --svr-dt-muted: CanvasText; --svr-dt-border: ButtonText; --svr-dt-accent: LinkText;
    --svr-dt-focus: Highlight; --svr-dt-success: CanvasText; --svr-dt-warning: CanvasText; --svr-dt-error: CanvasText;
   }
   #svelte-realtime-devtools button { border: 1px solid ButtonText !important; }
  }
 `;
 document.head.appendChild(styles);
 document.body.appendChild(panel);
	launcher = document.createElement('button');
	launcher.type = 'button';
	launcher.id = 'svr-dt-launcher';
	launcher.textContent = 'DevTools';
	launcher.setAttribute('aria-label', 'Toggle svelte-realtime DevTools');
	launcher.setAttribute('aria-controls', panel.id);
	launcher.setAttribute('aria-expanded', 'false');
	launcher.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:99998';
	launcher.onclick = toggle;
	document.body.appendChild(launcher);

	// Event delegation for the Streams tab's interactive controls.
	// innerHTML rewrites blow away inline handlers on each render, so all
	// stream-tab interactions route through data-action attributes here.
	content.addEventListener('click', (e) => {
		const t = /** @type {HTMLElement | null} */ ((/** @type {any} */ (e.target))?.closest?.('[data-action]'));
		if (!t) return;
		const action = t.dataset.action;
		const dt = /** @type {any} */ (window).__svelte_realtime_devtools;
		if (action === 'toggle-stream') {
			const path = t.dataset.streamPath;
			if (path) {
				if (expandedStreams.has(path)) expandedStreams.delete(path);
				else expandedStreams.add(path);
				_forceRerender();
			}
		} else if (action === 'toggle-pause') {
			streamsPaused = !streamsPaused;
			if (dt) dt.paused = streamsPaused;
			try { if (typeof localStorage !== 'undefined') localStorage.setItem('svr-dt-paused', streamsPaused ? '1' : '0'); } catch {}
			_forceRerender();
		} else if (action === 'toggle-raw') {
			streamsRawMode = !streamsRawMode;
			try { if (typeof localStorage !== 'undefined') localStorage.setItem('svr-dt-raw', streamsRawMode ? '1' : '0'); } catch {}
			_forceRerender();
		} else if (action === 'clear-events') {
			if (dt) for (const s of dt.streams.values()) s.recentEvents = [];
			_forceRerender();
		}
	});

	// Sync paused state from localStorage into __devtools on first init
	{
		const dt = /** @type {any} */ (window).__svelte_realtime_devtools;
		if (dt) dt.paused = streamsPaused;
	}

	// Refresh managed by toggle() - no idle timer when hidden
}

/** @param {HTMLElement} el */
function render(el) {
	/** @type {any} */
	let devtools = null;
	try {
		// Dynamic import to avoid SSR issues
		devtools = window.__svelte_realtime_devtools;
	} catch { return; }
	if (!devtools) {
		el.textContent = 'Use a realtime client on this page to begin inspecting requests.';
		return;
	}

	if (activeTab === 'rpcs') {
		renderRpcs(el, devtools);
	} else if (activeTab === 'streams') {
		renderStreams(el, devtools);
	} else if (activeTab === 'smooth') {
		renderSmooth(el, devtools);
	} else if (activeTab === 'connection') {
		renderConnection(el, devtools);
	}
}

/**
 * Escape a string for safe insertion into HTML.
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** @type {string} */
let _lastRenderedHtml = '';

/**
 * Reconcile keyed elements in place so focused controls and text selections
 * survive telemetry updates. Newly parsed markup remains inert until patched.
 * @param {HTMLElement} element
 * @param {string} html
 */
function patchContent(element, html) {
 const template = document.createElement('template');
 template.innerHTML = html;
 /** @param {Node} node */
 const key = (node) => node instanceof HTMLElement ? node.dataset.key || node.dataset.action || node.id : '';
 /** @param {Node} parent @param {Node} desired */
 function patch(parent, desired) {
  const retained = new Set();
  for (const source of Array.from(desired.childNodes)) {
   const nodeKey = key(source);
   let target = Array.from(parent.childNodes).find(node => !retained.has(node) && node.nodeType === source.nodeType && node.nodeName === source.nodeName && (nodeKey ? key(node) === nodeKey : !key(node)));
   if (!target) target = source.cloneNode(false);
   const position = parent.childNodes[retained.size];
   if (position !== target) parent.insertBefore(target, position || null);
   retained.add(target);
   if (target instanceof Element && source instanceof Element) {
    for (const attribute of Array.from(target.attributes)) if (!source.hasAttribute(attribute.name)) target.removeAttribute(attribute.name);
    for (const attribute of Array.from(source.attributes)) if (target.getAttribute(attribute.name) !== attribute.value) target.setAttribute(attribute.name, attribute.value);
    patch(target, source);
   } else if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue;
  }
  for (const node of Array.from(parent.childNodes)) if (!retained.has(node)) parent.removeChild(node);
 }
 patch(element, template.content);
}

/** @param {HTMLElement} el @param {any} dt */
function renderRpcs(el, dt) {
	const pending = dt.pending ? Array.from(dt.pending.values()) : [];
	const history = dt.history || [];

	let html = '';
	if (pending.length > 0) {
		html += '<div style="color:var(--svr-dt-warning, #ffe18a);margin-bottom:6px">Pending (' + esc(String(pending.length)) + ')</div>';
		for (const p of pending) {
			const elapsed = now() - p.startTime;
			html += `<div style="padding:2px 0;color:var(--svr-dt-muted, #b3b8cc)">${esc(p.path)} <span style="color:var(--svr-dt-muted, #b3b8cc)">${esc(String(elapsed))}ms</span></div>`;
		}
		html += '<hr style="border-color:var(--svr-dt-border, #7d859a);margin:6px 0">';
	}

	const entries = history.filter(Boolean).sort((a, b) => (b.seq || 0) - (a.seq || 0));
	html += '<div style="margin-bottom:4px">History (' + esc(String(entries.length)) + ')</div>';
	for (let i = 0; i < entries.length; i++) {
		const h = entries[i];
		const color = h.ok ? 'var(--svr-dt-success, #79db8f)' : 'var(--svr-dt-error, #ff9595)';
		html += `<div data-key="rpc:${h.seq}" data-rpc-history style="padding:2px 0"><span style="color:${color}">${h.ok ? 'OK' : 'ERR'}</span> ${esc(h.path)} <span style="color:var(--svr-dt-muted, #b3b8cc)">${esc(String(h.duration))}ms</span></div>`;
	}
	if (entries.length === 0) html += '<div style="color:var(--svr-dt-muted, #b3b8cc)">Call a realtime function to see its result and duration here.</div>';

	if (html !== _lastRenderedHtml) {
		_lastRenderedHtml = html;
		patchContent(el, html);
	}
}

/**
 * Format `lastEventTime` as a relative age string ("12s ago", "3m ago",
 * "never"). Bucketed coarsely so the rendered HTML doesn't churn every
 * tick of the 1s refresh.
 * @param {number | null | undefined} t
 * @returns {string}
 */
function _ageString(t) {
	if (!t) return 'never';
	const ms = now() - t;
	if (ms < 1000) return 'just now';
	if (ms < 60_000) return Math.floor(ms / 1000) + 's ago';
	if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm ago';
	return Math.floor(ms / 3_600_000) + 'h ago';
}

/**
 * Render a payload value for the recent-events list. Returns a JSON
 * string truncated to ~200 chars in pretty mode (~500 chars in raw
 * mode) so a malformed-large-payload doesn't blow out the panel.
 * @param {any} value
 * @param {boolean} raw
 * @returns {string}
 */
function _renderPayload(value, raw) {
	if (value === undefined) return '';
	let str;
	try { str = JSON.stringify(value); } catch { str = String(value); }
	const cap = raw ? 500 : 200;
	if (str.length > cap) str = str.slice(0, cap) + '... [+' + (str.length - cap) + ']';
	return str;
}

/** @param {HTMLElement} el @param {any} dt */
function renderStreams(el, dt) {
	const streams = dt.streams ? Array.from(dt.streams.values()) : [];

	const pauseLabel = streamsPaused ? 'Resume' : 'Pause';
	const pauseColor = streamsPaused ? 'var(--svr-dt-warning, #ffe18a)' : 'var(--svr-dt-muted, #b3b8cc)';
	const modeLabel = streamsRawMode ? 'Raw' : 'Pretty';

	let html = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:10px">` +
		`<span style="color:var(--svr-dt-muted, #b3b8cc)">Active (${esc(String(streams.length))})</span>` +
		`<span style="flex:1"></span>` +
		`<button data-action="toggle-raw" aria-label="Raw payload format" aria-pressed="${streamsRawMode}" style="background:none;border:1px solid var(--svr-dt-border, #7d859a);color:var(--svr-dt-muted, #b3b8cc);cursor:pointer;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:3px">${esc(modeLabel)}</button>` +
		`<button data-action="toggle-pause" aria-label="Pause event capture" aria-pressed="${streamsPaused}" style="background:none;border:1px solid var(--svr-dt-border, #7d859a);color:${pauseColor};cursor:pointer;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:3px">${esc(pauseLabel)}</button>` +
		`<button data-action="clear-events" style="background:none;border:1px solid var(--svr-dt-border, #7d859a);color:var(--svr-dt-muted, #b3b8cc);cursor:pointer;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:3px">Clear events</button>` +
		`</div>`;

	for (const s of streams) {
		const merge = s.merge ? esc(s.merge) : '?';
		const topic = esc(s.topic || '?');
		const subs = esc(String(s.subCount));
		const lastEvt = s.lastEvent
			? `last:${esc(s.lastEvent)} ${esc(_ageString(s.lastEventTime))}`
			: 'no events yet';
		const errPart = s.error
			? `<div style="padding:1px 0 1px 12px;color:var(--svr-dt-error, #ff9595)">err: ${esc(s.error.code)} - ${esc(s.error.message)}</div>`
			: '';
		const expanded = expandedStreams.has(s.path);
		const recentCount = (s.recentEvents && s.recentEvents.length) || 0;
		const eventsId = 'svr-dt-events-' + encodeURIComponent(s.path);
		const chevron = expanded ? '[-]' : '[+]';
		const chevronColor = recentCount > 0 ? 'var(--svr-dt-muted, #b3b8cc)' : 'var(--svr-dt-muted, #b3b8cc)';

		html += `<div data-key="stream:${esc(s.path)}" style="padding:4px 0;border-bottom:1px solid var(--svr-dt-border, #7d859a)">` +
			`<button type="button" data-action="toggle-stream" data-stream-path="${esc(s.path)}" aria-expanded="${expanded}" aria-controls="${esc(eventsId)}" style="background:none;border:none;color:inherit;font:inherit;text-align:start;cursor:pointer;display:flex;align-items:center;gap:4px">` +
			`<span style="color:${chevronColor};width:10px;display:inline-block">${chevron}</span>` +
			`<span>${esc(s.path)}</span>` +
			(recentCount > 0 ? `<span style="color:var(--svr-dt-muted, #b3b8cc);font-size:10px;margin-left:6px">(${recentCount})</span>` : '') +
			`</button>` +
			`<div style="padding:1px 0 1px 16px;color:var(--svr-dt-muted, #b3b8cc)">topic:${topic} merge:${merge} subs:${subs}</div>` +
			`<div style="padding:1px 0 1px 16px;color:var(--svr-dt-muted, #b3b8cc)">${lastEvt}</div>` +
			errPart;

		html += `<div id="${esc(eventsId)}"${expanded ? '' : ' hidden'}>`;
		if (expanded) {
			if (recentCount === 0) {
				html += `<div style="padding:4px 0 4px 24px;color:var(--svr-dt-muted, #b3b8cc);font-style:italic">${streamsPaused ? 'Resume capture, then trigger a stream update.' : 'Trigger a stream update to capture an event.'}</div>`;
			} else {
				const recent = /** @type {Array<{event: string, data: any, ts: number}>} */ (s.recentEvents);
				html += `<div style="padding:2px 0 4px 24px">`;
				for (let i = recent.length - 1; i >= 0; i--) {
					const ev = recent[i];
					const time = new Date(ev.ts).toLocaleTimeString('en', { // determinism-allow: formats a captured event timestamp for display, not a clock read
						hour12: false,
						hour: '2-digit',
						minute: '2-digit',
						second: '2-digit'
					});
					const payload = _renderPayload(ev.data, streamsRawMode);
					if (streamsRawMode) {
						html += `<div style="padding:1px 0;color:var(--svr-dt-muted, #b3b8cc);word-break:break-all"><span style="color:var(--svr-dt-muted, #b3b8cc)">${esc(time)}</span> <span style="color:var(--svr-dt-accent, #ff819a)">${esc(ev.event)}</span> ${esc(payload)}</div>`;
					} else {
						html += `<div style="display:flex;gap:6px;padding:1px 0;align-items:baseline"><span style="color:var(--svr-dt-muted, #b3b8cc);tabular-nums;flex-shrink:0">${esc(time)}</span><span style="color:var(--svr-dt-accent, #ff819a);flex-shrink:0">${esc(ev.event)}</span><span style="color:var(--svr-dt-muted, #b3b8cc);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(payload)}</span></div>`;
					}
				}
				html += `</div>`;
			}
		}

		html += `</div></div>`;
	}
	if (streams.length === 0) html += '<div style="color:var(--svr-dt-muted, #b3b8cc)">Subscribe to a live stream to inspect its events here.</div>';

	if (html !== _lastRenderedHtml) {
		_lastRenderedHtml = html;
		patchContent(el, html);
	}
}

/**
 * The "smooth" tab: a per-channel inspector for live `live.smooth` views. Pulls
 * each registered channel's `stats()` snapshot on the panel's refresh tick (the
 * accessors live in `dt.smooth`), so it costs nothing until the panel is open.
 * @param {HTMLElement} el @param {any} dt
 */
function renderSmooth(el, dt) {
	const accessors = dt.smooth ? [...dt.smooth] : [];
	let html = `<div style="color:var(--svr-dt-muted, #b3b8cc);margin-bottom:6px;font-size:10px">Smoothed channels (${esc(String(accessors.length))})</div>`;
	let shown = 0;
	for (const statsFn of accessors) {
		let s;
		try { s = statsFn(); } catch { s = null; }
		if (s === undefined) {
			html += `<div style="padding:4px 0;color:var(--svr-dt-warning, #ffe18a)">telemetry unavailable (needs svelte-adapter-uws &gt;= 0.6.0-next.35)</div>`;
			shown++;
			continue;
		}
		if (!s) continue;
		shown++;
		const topic = esc(s.topic || '(connecting)');
		const self = s.self ? esc(s.self) : '-';
		const status = s.overflowed
			? `<span style="color:var(--svr-dt-warning, #ffe18a)">Prediction paused - waiting for resync (Command window full)</span>`
			: `<span style="color:var(--svr-dt-success, #79db8f)">predicting</span>`;
		const unacked = Number(s.unacked) || 0;
		const cap = Number(s.windowCap) || 0;
		const unackedColor = cap > 0 && unacked / cap > 0.5 ? 'var(--svr-dt-warning, #ffe18a)' : 'var(--svr-dt-muted, #b3b8cc)';
		const divergence = Number(s.lastDivergence) || 0;
		const divColor = divergence > 0 ? 'var(--svr-dt-warning, #ffe18a)' : 'var(--svr-dt-muted, #b3b8cc)';
		const clockColor = s.clockSynced ? 'var(--svr-dt-success, #79db8f)' : 'var(--svr-dt-error, #ff9595)';
		html += `<div style="padding:4px 0;border-bottom:1px solid var(--svr-dt-border, #7d859a)">` +
			`<div style="display:flex;align-items:center;gap:6px"><span>${topic}</span> ${status}</div>` +
			`<div style="padding:1px 0 1px 12px;color:var(--svr-dt-muted, #b3b8cc)">self:${self} remote:${esc(String(Number(s.remoteCount) || 0))} clock:<span style="color:${clockColor}">${s.clockSynced ? 'synced' : 'unsynced'}</span></div>` +
			`<div style="padding:1px 0 1px 12px;color:var(--svr-dt-muted, #b3b8cc)">unacked:<span style="color:${unackedColor}">${esc(String(unacked))}</span>/${esc(String(cap))} ` +
				`divergence:<span style="color:${divColor}">${esc(divergence.toFixed(2))}</span>` +
				(s.correcting ? ` <span style="color:var(--svr-dt-warning, #ffe18a)">easing</span>` : '') +
				`</div>` +
			`<div style="padding:1px 0 1px 12px;color:var(--svr-dt-muted, #b3b8cc)">interp delay:${esc((Number(s.interpDelayMs) || 0).toFixed(0))}ms</div>` +
			`</div>`;
	}
	if (shown === 0) html += '<div style="color:var(--svr-dt-muted, #b3b8cc)">Create a live.smooth view to inspect prediction and interpolation.</div>';

	if (html !== _lastRenderedHtml) {
		_lastRenderedHtml = html;
		patchContent(el, html);
	}
}

/** @param {HTMLElement} el @param {any} dt */
function renderConnection(el, dt) {
	const pending = dt.pending ? dt.pending.size : 0;
	const html = `
		<div style="padding:2px 0">Pending RPCs: ${esc(String(pending))}</div>
		<div style="padding:2px 0">History entries: ${esc(String((dt.history || []).filter(Boolean).length))}</div>
		<div style="padding:2px 0">Active streams: ${esc(String(dt.streams ? dt.streams.size : 0))}</div>
		<div style="padding:4px 0;color:var(--svr-dt-muted, #b3b8cc);font-size:11px">Press Ctrl+Shift+L to toggle</div>
	`;

	if (html !== _lastRenderedHtml) {
		_lastRenderedHtml = html;
		patchContent(el, html);
	}
}

// Auto-init when loaded
if (typeof window !== 'undefined') {
	init();
}
