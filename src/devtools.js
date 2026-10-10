// @ts-check
// DevTools overlay for svelte-realtime (dev-mode only)
// Injected by the Vite plugin via transformIndexHtml

import { now, monotonicNow, setTimer, clearTimer, setIntervalTimer, clearIntervalTimer } from './client-runtime.js';

/** @type {Intl.LocalesArgument | undefined} */
let locale;
let messages = {};
let numberFormat = new Intl.NumberFormat();
let timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
let relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
let direction = 'ltr';

/** @param {string} template @param {Record<string, string | number>} [values] */
function message(template, values = {}) {
 return (messages[template] ?? template).replace(/\{(\w+)\}/g, (match, key) => key in values ? String(values[key]) : match);
}
/** @param {number} value @param {Intl.NumberFormatOptions} [options] */
function number(value, options) { return options ? new Intl.NumberFormat(locale, options).format(value) : numberFormat.format(value); }
/** @param {number} value @param {number} [maximumFractionDigits] */
function duration(value, maximumFractionDigits = 3) { return number(value, { style: 'unit', unit: 'millisecond', unitDisplay: 'short', maximumFractionDigits }); }
/** @param {unknown} value */
function isolated(value) { return '<bdi dir="auto">' + esc(String(value)) + '</bdi>'; }

/** Configure the overlay's locale, reading direction, and translated labels.
 * @param {import('./devtools.js').DevtoolsPresentation} options
 */
export function configureDevtools(options = {}) {
 const nextLocale = options.locale;
 const nextNumber = new Intl.NumberFormat(nextLocale);
 const nextTime = new Intl.DateTimeFormat(nextLocale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
 const nextRelative = new Intl.RelativeTimeFormat(nextLocale, { numeric: 'auto' });
 const language = new Intl.Locale(nextNumber.resolvedOptions().locale);
 locale = nextLocale;
 numberFormat = nextNumber;
 timeFormat = nextTime;
 relativeFormat = nextRelative;
 messages = options.messages || {};
 direction = options.direction || language.getTextInfo?.().direction || language.textInfo?.direction || (/^(ar|fa|he|ur|ps|dv)(-|$)/.test(language.language) ? 'rtl' : 'ltr');
 if (panel) {
  panel.lang = nextNumber.resolvedOptions().locale;
  panel.dir = direction;
  panel.setAttribute('aria-label', message('svelte-realtime DevTools'));
  for (const el of panel.querySelectorAll('[data-label]')) {
   const key = /** @type {HTMLElement} */ (el).dataset.label;
   el.textContent = message(key);
  }
  for (const el of [...panel.querySelectorAll('[data-aria-label]'), ...(launcher ? [launcher] : [])]) el.setAttribute('aria-label', message(/** @type {HTMLElement} */ (el).dataset.ariaLabel));
  for (const el of panel.querySelectorAll('[data-title]')) el.setAttribute('title', message(/** @type {HTMLElement} */ (el).dataset.title));
  _forceRerender();
 }
}

/** @type {HTMLElement | null} */
let panel = null;
let visible = false;
let activeTab = 'rpcs';
/** @type {HTMLElement | null} */
let previousFocus = null;
/** @type {HTMLButtonElement | null} */
let launcher = null;
/** @type {HTMLElement | null} */
let statusMessage = null;
let lastConnection = '';
let lastErrors = '';
let lastRpcFailure = 0;
let announcementTimer = null;
const automaticAnnouncementInterval = 5000;
let automaticAnnouncementDue = 0;
let automaticConnection = null;
let automaticErrors = null;
let automaticRpcFailures = 0;

/** @param {string} text @param {boolean} [automatic] */
function announce(text, automatic = false) {
 if (!statusMessage) return;
 if (!automatic) automaticAnnouncementDue = monotonicNow() + automaticAnnouncementInterval;
 if (announcementTimer !== null) clearTimer(announcementTimer);
 announcementTimer = null;
 if (statusMessage.textContent === text) {
  statusMessage.textContent = '';
  announcementTimer = setTimer(() => { statusMessage.textContent = text; announcementTimer = null; }, 50);
 } else statusMessage.textContent = text;
}


/** @type {ReturnType<typeof setInterval> | null} */
let refreshInterval = null;

/** Paths whose recentEvents are currently expanded in the Streams tab. */
/** @type {Set<string>} */
const expandedStreams = new Set();

/** Pretty (false) vs raw (true) JSON rendering for stream payloads. */
let streamsRawMode = false;

/** Mirror of `__devtools.paused` so the toggle survives panel re-renders. */
let streamsPaused = true;

try {
	if (typeof localStorage !== 'undefined') {
		streamsRawMode = localStorage.getItem('svr-dt-raw') === '1';
	}
} catch {}

/** Force the next render() call to repaint, ignoring _lastRenderedHtml dedupe. */
function _forceRerender() {
	_lastRenderedHtml = '';
	if (!panel) return;
	const content = panel.querySelector('#svr-dt-content');
	if (content) render(/** @type {HTMLElement} */ (content));
}

function toggle() {
	visible = !visible;
	if (visible) previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	if (panel) panel.style.display = visible ? 'flex' : 'none';
	launcher?.setAttribute('aria-expanded', String(visible));
	if (visible) panel?.querySelector('#svr-dt-close')?.focus();
	else if (previousFocus?.isConnected) previousFocus.focus();
	else launcher?.focus();
	if (visible && !refreshInterval) {
		const content = panel?.querySelector('#svr-dt-content');
		if (content) render(/** @type {HTMLElement} */ (content));
		refreshInterval = setIntervalTimer(() => {
			const content = panel?.querySelector('#svr-dt-content');
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
	panel.lang = numberFormat.resolvedOptions().locale;
	panel.dir = direction;
	panel.style.colorScheme = 'dark';
	panel.setAttribute('role', 'region');
	panel.setAttribute('aria-label', message('svelte-realtime DevTools'));
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

	const badge = document.createElement('span');
	badge.id = 'svr-dt-connection';
	header.appendChild(badge);

	const closeBtn = document.createElement('button');
	closeBtn.id = 'svr-dt-close';
	closeBtn.textContent = 'x';
	closeBtn.dataset.ariaLabel = 'Close DevTools';
	closeBtn.setAttribute('aria-label', message('Close DevTools'));
	closeBtn.style.cssText = 'background:none;border:none;color:var(--svr-dt-muted, #b3b8cc);cursor:pointer;font-size:14px;padding:0 4px;';
	closeBtn.onclick = toggle;
	const moveBtn = document.createElement('button');
	moveBtn.type = 'button';
	moveBtn.textContent = message('Move');
	moveBtn.dataset.label = 'Move';
	moveBtn.dataset.ariaLabel = 'Move DevTools';
	moveBtn.setAttribute('aria-label', message('Move DevTools'));
	moveBtn.dataset.title = 'Arrow keys move; Home and End dock; click cycles corners';
	moveBtn.title = message(moveBtn.dataset.title);
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
	tabs.dataset.ariaLabel = 'DevTools views';
	tabs.setAttribute('aria-label', message('DevTools views'));
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
		btn.textContent = message(name);
		btn.dataset.label = name;
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
			const next = event.key === (direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight') ? (index + 1) % tabNames.length
				: event.key === (direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft') ? (index + tabNames.length - 1) % tabNames.length
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
 const privacy = document.createElement('div');
 privacy.style.cssText = 'display:flex;gap:8px;padding:4px 8px;flex-shrink:0;align-items:center';
 const captureMode = document.createElement('span');
 captureMode.id = 'svr-dt-capture-mode';
 privacy.appendChild(captureMode);
 const clearCapture = document.createElement('button');
 clearCapture.type = 'button';
 clearCapture.dataset.label = 'Clear captured data';
 clearCapture.textContent = message('Clear captured data');
 clearCapture.onclick = () => {
  const dt = /** @type {any} */ (window).__svelte_realtime_devtools;
  dt?.clear();
  streamsPaused = true;
  announce(message('Captured data cleared. Payload capture disabled.'));
  _forceRerender();
 };
 privacy.appendChild(clearCapture);
 panel.appendChild(privacy);
	panel.appendChild(content);
	statusMessage = document.createElement('div');
	statusMessage.setAttribute('role', 'status');
	statusMessage.setAttribute('aria-live', 'polite');
	statusMessage.setAttribute('aria-atomic', 'true');
	statusMessage.style.cssText = 'padding:4px 8px;flex-shrink:0';
	panel.appendChild(statusMessage);
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
	launcher.textContent = message('DevTools');
	launcher.dataset.ariaLabel = 'Toggle svelte-realtime DevTools';
	launcher.setAttribute('aria-label', message('Toggle svelte-realtime DevTools'));
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
			announce(message(streamsPaused ? 'Event capture paused.' : 'Event capture resumed.'));
			_forceRerender();
		} else if (action === 'toggle-raw') {
			streamsRawMode = !streamsRawMode;
			try { if (typeof localStorage !== 'undefined') localStorage.setItem('svr-dt-raw', streamsRawMode ? '1' : '0'); } catch {}
			_forceRerender();
		} else if (action === 'undo-clear') {
			dt?.undoClearEvents();
			announce(message('Cleared events restored.'));
			_forceRerender();
		} else if (action === 'clear-events') {
			if (dt) dt.clearEvents();
			announce(message('Captured stream events cleared.'));
			_forceRerender();
		}
	});

	// Apply the initial paused capture state to the instrumentation.
	{
		const dt = /** @type {any} */ (window).__svelte_realtime_devtools;
		if (dt) dt.paused = streamsPaused;
	}

	window.addEventListener('svelte-realtime-devtools-clear', () => {
  automaticRpcFailures = 0;
  if (announcementTimer !== null) clearTimer(announcementTimer);
  announcementTimer = null;
  _forceRerender();
 });

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
		el.textContent = message('Use a realtime client on this page to begin inspecting requests.');
		constrainPanel();
		return;
	}

	const captureMode = document.getElementById('svr-dt-capture-mode');
	if (captureMode) captureMode.textContent = message(devtools.unsafeCapturePayloads ? 'Unsafe payload capture enabled' : 'Metadata only');
	announceTransitions(devtools);
	const badge = document.getElementById('svr-dt-connection');
	if (badge) badge.textContent = message(connectionLabel(devtools.connection?.state || 'idle'));
	if (activeTab === 'rpcs') {
		renderRpcs(el, devtools);
	} else if (activeTab === 'streams') {
		renderStreams(el, devtools);
	} else if (activeTab === 'smooth') {
		renderSmooth(el, devtools);
	} else if (activeTab === 'connection') {
		renderConnection(el, devtools);
	}
	constrainPanel();
}

/** @param {any} dt */
function announceTransitions(dt) {
 const connection = dt.connection?.state || 'idle';
 if (lastConnection !== connection) {
  lastConnection = connection;
  automaticConnection = connection;
 }
 const errors = [...(dt.streams?.values() || [])].filter(stream => stream.error);
 const signature = JSON.stringify(errors.map(stream => [stream.path, stream.error.code]));
 if (signature !== lastErrors) {
  if (errors.length || (lastErrors && lastErrors !== '[]')) automaticErrors = errors.length;
  lastErrors = signature;
 }
 const failures = (dt.history || []).filter(entry => entry && !entry.ok && (entry.seq || 0) > lastRpcFailure);
 if (failures.length) {
  lastRpcFailure = Math.max(lastRpcFailure, ...failures.map(entry => entry.seq));
  automaticRpcFailures += failures.length;
 }
 if (automaticConnection === null && automaticErrors === null && !automaticRpcFailures) return;
 const time = monotonicNow();
 if (time < automaticAnnouncementDue) return;
 const updates = [];
 if (automaticConnection !== null) updates.push(message('Connection: {state}.', { state: message(connectionLabel(automaticConnection)) }));
 if (automaticErrors !== null) updates.push(automaticErrors
  ? message('Streams with errors: {count}.', { count: number(automaticErrors) })
  : message('Stream errors cleared.'));
 if (automaticRpcFailures) updates.push(automaticRpcFailures === 1
  ? message('An RPC failed. Open RPCs to inspect the result.')
  : message('{count} RPC failures. Open RPCs to inspect the results.', { count: number(automaticRpcFailures) }));
 automaticConnection = null;
 automaticErrors = null;
 automaticRpcFailures = 0;
 automaticAnnouncementDue = time + automaticAnnouncementInterval;
 announce(updates.join(' '), true);
}
function constrainPanel() {
 if (!panel || !visible || !panel.style.top) return;
 const rect = panel.getBoundingClientRect();
 panel.style.left = Math.max(10, Math.min(rect.left, window.innerWidth - rect.width - 10)) + 'px';
 panel.style.top = Math.max(10, Math.min(rect.top, window.innerHeight - rect.height - 10)) + 'px';
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
 const focused = element.contains(document.activeElement) ? document.activeElement : null;
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
 if (focused instanceof HTMLElement && document.activeElement !== focused) {
  if (focused.isConnected) focused.focus({ preventScroll: true });
  else element.focus({ preventScroll: true });
 }
}

/** @param {HTMLElement} el @param {any} dt */
function renderRpcs(el, dt) {
	const pending = dt.pending ? Array.from(dt.pending.values()) : [];
	const history = dt.history || [];

	let html = '';
	if (pending.length > 0) {
		html += '<div style="color:var(--svr-dt-warning, #ffe18a);margin-bottom:6px">' + esc(message('Pending ({count})', { count: number(pending.length) })) + '</div>';
		for (const p of pending) {
			const elapsed = now() - p.startTime;
			html += `<div style="padding:2px 0;color:var(--svr-dt-muted, #b3b8cc)">${isolated(p.path)} <span style="color:var(--svr-dt-muted, #b3b8cc)">${esc(duration(elapsed))}</span></div>`;
		}
		html += '<hr style="border-color:var(--svr-dt-border, #7d859a);margin:6px 0">';
	}

	const entries = history.filter(Boolean).sort((a, b) => (b.seq || 0) - (a.seq || 0));
	html += '<div style="margin-bottom:4px">' + esc(message('History ({count})', { count: number(entries.length) })) + '</div>';
	for (let i = 0; i < entries.length; i++) {
		const h = entries[i];
		const color = h.ok ? 'var(--svr-dt-success, #79db8f)' : 'var(--svr-dt-error, #ff9595)';
		html += `<div data-key="rpc:${h.seq}" data-rpc-history style="padding:2px 0"><span style="color:${color}">${esc(message(h.ok ? 'OK' : 'ERR'))}</span> ${isolated(h.path)} <span style="color:var(--svr-dt-muted, #b3b8cc)">${esc(duration(h.duration))}</span></div>`;
	}
	if (entries.length === 0) html += '<div style="color:var(--svr-dt-muted, #b3b8cc)">' + esc(message('Call a realtime function to see its result and duration here.')) + '</div>';

	if (html !== _lastRenderedHtml) {
		_lastRenderedHtml = html;
		patchContent(el, html);
	}
}

/**
 * Format `lastEventTime` using localized relative seconds, minutes, or hours.
 * @param {number | null | undefined} t
 * @returns {string}
 */
function _ageString(t) {
	if (t == null) return message('No event yet');
 const ms = Math.max(0, now() - t);
 if (ms < 60_000) return relativeFormat.format(-Math.floor(ms / 1000), 'second');
 if (ms < 3_600_000) return relativeFormat.format(-Math.floor(ms / 60_000), 'minute');
 return relativeFormat.format(-Math.floor(ms / 3_600_000), 'hour');
}

const payloadSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/**
 * Render a JSON preview capped at 200 graphemes in pretty mode or 500 in raw
 * mode. Without grapheme segmentation, cap by code point to preserve surrogate
 * pairs while keeping large payloads out of the panel.
 * @param {any} value
 * @param {boolean} raw
 * @returns {string}
 */
function _renderPayload(value, raw) {
	if (value === undefined) return '';
	let str;
	try { str = JSON.stringify(value) ?? String(value); } catch { str = String(value); }
	const cap = raw ? 500 : 200;
	if (str.length > cap) {
		let end = 0, count = 0;
		if (payloadSegmenter) {
			for (const item of payloadSegmenter.segment(str)) {
				if (count++ === cap) break;
				end += item.segment.length;
			}
		} else {
			for (const point of str) {
				if (count++ === cap) break;
				end += point.length;
			}
		}
		if (end < str.length) str = str.slice(0, end) + message('... [+{count} code units]', { count: number(str.length - end) });
	}
	return str;
}
/** @param {HTMLElement} el @param {any} dt */
function renderStreams(el, dt) {
	streamsPaused = dt.paused === true;
	const streams = dt.streams ? Array.from(dt.streams.values()) : [];

	const pauseLabel = message('Pause');
	const pauseColor = streamsPaused ? 'var(--svr-dt-warning, #ffe18a)' : 'var(--svr-dt-muted, #b3b8cc)';
	const modeLabel = message('Raw');

	let html = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:10px">` +
		`<span style="color:var(--svr-dt-muted, #b3b8cc)">${esc(message('Active ({count})', { count: number(streams.length) }))}</span>` +
		`<span style="flex:1"></span>` +
		`<button data-action="toggle-raw" aria-pressed="${streamsRawMode}" style="background:none;border:1px solid var(--svr-dt-border, #7d859a);color:var(--svr-dt-muted, #b3b8cc);cursor:pointer;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:3px">${esc(modeLabel)}</button>` +
		`<button data-action="toggle-pause" aria-pressed="${streamsPaused}" style="background:none;border:1px solid var(--svr-dt-border, #7d859a);color:${pauseColor};cursor:pointer;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:3px">${esc(pauseLabel)}</button>` +
		`<button data-action="clear-events" style="background:none;border:1px solid var(--svr-dt-border, #7d859a);color:var(--svr-dt-muted, #b3b8cc);cursor:pointer;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:3px">${esc(message('Clear events'))}</button>` +
		(dt.undoClearCount ? `<button data-action="undo-clear">${esc(message('Undo clear ({count})', { count: number(dt.undoClearCount) }))}</button>` : '') +
		`</div>`;

	for (const s of streams) {
		const merge = isolated(s.merge || '?');
		const topic = isolated(s.topic || '?');
		const subs = esc(number(s.subCount));
		const lastEvt = s.lastEvent
			? `${esc(message('Last event:'))} ${isolated(s.lastEvent)} ${esc(_ageString(s.lastEventTime))}`
			: esc(message('No event yet'));
		const errPart = s.error
			? `<div style="padding-block:1px;padding-inline:12px 0;color:var(--svr-dt-error, #ff9595)">${esc(message('err:'))} ${isolated(s.error.code)} - ${isolated(s.error.message)}</div>`
			: '';
		const expanded = expandedStreams.has(s.path);
		const recentCount = (s.recentEvents && s.recentEvents.length) || 0;
		const eventsId = 'svr-dt-events-' + encodeURIComponent(s.path);
		const chevron = expanded ? '[-]' : '[+]';
		const chevronColor = 'var(--svr-dt-muted, #b3b8cc)';

		html += `<div data-key="stream:${esc(s.path)}" style="padding:4px 0;border-bottom:1px solid var(--svr-dt-border, #7d859a)">` +
			`<button type="button" data-action="toggle-stream" data-stream-path="${esc(s.path)}" aria-expanded="${expanded}" aria-controls="${esc(eventsId)}" style="background:none;border:none;color:inherit;font:inherit;text-align:start;cursor:pointer;display:flex;align-items:center;gap:4px">` +
			`<span style="color:${chevronColor};width:10px;display:inline-block">${chevron}</span>` +
			`<span>${isolated(s.path)}</span>` +
			(recentCount > 0 ? `<span style="color:var(--svr-dt-muted, #b3b8cc);font-size:10px;margin-inline-start:6px">(${esc(number(recentCount))})</span>` : '') +
			`</button>` +
			`<div style="padding-block:1px;padding-inline:16px 0;color:var(--svr-dt-muted, #b3b8cc)">${esc(message('topic:'))}${topic} ${esc(message('merge:'))}${merge} ${esc(message('subs:'))}${subs}</div>` +
			`<div style="padding-block:1px;padding-inline:16px 0;color:var(--svr-dt-muted, #b3b8cc)">${lastEvt}</div>` +
			errPart;

		html += `<div id="${esc(eventsId)}"${expanded ? '' : ' hidden'}>`;
		if (expanded) {
			if (recentCount === 0) {
				html += `<div style="padding-block:4px;padding-inline:24px 0;color:var(--svr-dt-muted, #b3b8cc);font-style:italic">${esc(message(streamsPaused ? 'Resume capture, then trigger a stream update.' : 'Trigger a stream update to capture an event.'))}</div>`;
			} else {
				const recent = /** @type {Array<{event: string, data: any, ts: number}>} */ (s.recentEvents);
				html += `<div style="padding-block:2px 4px;padding-inline:24px 0">`;
				for (let i = recent.length - 1; i >= 0; i--) {
					const ev = recent[i];
					const time = timeFormat.format(ev.ts);
					const payload = _renderPayload(ev.data, streamsRawMode);
					if (streamsRawMode) {
						html += `<div style="padding:1px 0;color:var(--svr-dt-muted, #b3b8cc);word-break:break-all"><span style="color:var(--svr-dt-muted, #b3b8cc)">${esc(time)}</span> <span style="color:var(--svr-dt-accent, #ff819a)">${isolated(ev.event)}</span> <bdi dir="ltr">${esc(payload)}</bdi></div>`;
					} else {
						html += `<div style="display:flex;gap:6px;padding:1px 0;align-items:baseline"><span style="color:var(--svr-dt-muted, #b3b8cc);tabular-nums;flex-shrink:0">${esc(time)}</span><span style="color:var(--svr-dt-accent, #ff819a);flex-shrink:0">${isolated(ev.event)}</span><span style="color:var(--svr-dt-muted, #b3b8cc);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><bdi dir="ltr">${esc(payload)}</bdi></span></div>`;
					}
				}
				html += `</div>`;
			}
		}

		html += `</div></div>`;
	}
	if (streams.length === 0) html += '<div style="color:var(--svr-dt-muted, #b3b8cc)">' + esc(message('Subscribe to a live stream to inspect its events here.')) + '</div>';

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
	let html = `<div style="color:var(--svr-dt-muted, #b3b8cc);margin-bottom:6px;font-size:10px">${esc(message('Smoothed channels ({count})', { count: number(accessors.length) }))}</div>`;
	let shown = 0;
	for (const statsFn of accessors) {
		let s;
		try { s = statsFn(); } catch { s = null; }
		if (s === undefined) {
			html += `<div style="padding:4px 0;color:var(--svr-dt-warning, #ffe18a)">${esc(message('telemetry unavailable (needs svelte-adapter-uws >= 0.6.0-next.35)'))}</div>`;
			shown++;
			continue;
		}
		if (!s) continue;
		shown++;
		const topic = dt.unsafeCapturePayloads ? isolated(s.topic || message('(connecting)')) : esc(message('[topic omitted]'));
		const self = dt.unsafeCapturePayloads ? isolated(s.self || '-') : esc(message('[identity omitted]'));
		const status = s.overflowed
			? `<span style="color:var(--svr-dt-warning, #ffe18a)">${esc(message('Prediction paused - waiting for resync (Command window full)'))}</span>`
			: `<span style="color:var(--svr-dt-success, #79db8f)">${esc(message('predicting'))}</span>`;
		const unacked = Number(s.unacked) || 0;
		const cap = Number(s.windowCap) || 0;
		const unackedColor = cap > 0 && unacked / cap > 0.5 ? 'var(--svr-dt-warning, #ffe18a)' : 'var(--svr-dt-muted, #b3b8cc)';
		const divergence = Number(s.lastDivergence) || 0;
		const divColor = divergence > 0 ? 'var(--svr-dt-warning, #ffe18a)' : 'var(--svr-dt-muted, #b3b8cc)';
		const clockColor = s.clockSynced ? 'var(--svr-dt-success, #79db8f)' : 'var(--svr-dt-error, #ff9595)';
		html += `<div style="padding:4px 0;border-bottom:1px solid var(--svr-dt-border, #7d859a)">` +
			`<div style="display:flex;align-items:center;gap:6px"><span>${topic}</span> ${status}</div>` +
			`<div style="padding-block:1px;padding-inline:12px 0;color:var(--svr-dt-muted, #b3b8cc)">${esc(message('self:'))}${self} ${esc(message('remote:'))}${esc(number(Number(s.remoteCount) || 0))} ${esc(message('clock:'))}<span style="color:${clockColor}">${esc(message(s.clockSynced ? 'synced' : 'unsynced'))}</span></div>` +
			`<div style="padding-block:1px;padding-inline:12px 0;color:var(--svr-dt-muted, #b3b8cc)">${esc(message('unacked:'))}<span style="color:${unackedColor}">${esc(number(unacked))}</span>/${esc(number(cap))} ` +
				`${esc(message('divergence:'))}<span style="color:${divColor}">${esc(number(divergence, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}</span>` +
				(s.correcting ? ` <span style="color:var(--svr-dt-warning, #ffe18a)">${esc(message('easing'))}</span>` : '') +
				`</div>` +
			`<div style="padding-block:1px;padding-inline:12px 0;color:var(--svr-dt-muted, #b3b8cc)">${esc(message('interp delay:'))}${esc(duration(Number(s.interpDelayMs) || 0, 0))}</div>` +
			`</div>`;
	}
	if (shown === 0) html += '<div style="color:var(--svr-dt-muted, #b3b8cc)">' + esc(message('Create a live.smooth view to inspect prediction and interpolation.')) + '</div>';

	if (html !== _lastRenderedHtml) {
		_lastRenderedHtml = html;
		patchContent(el, html);
	}
}

/** @param {string} state */
function connectionLabel(state) {
 return ({ idle: 'Not connected', connecting: 'Connecting', open: 'Connected', disconnected: 'Disconnected', suspended: 'Connected in background', failed: 'Connection stopped' })[state] || state;
}
/** @param {any} connection */
function connectionAction(connection) {
 if (connection.state === 'open' || connection.state === 'suspended') return 'Connection is ready.';
 if (connection.state === 'idle') return 'Use a realtime client to connect.';
 if (connection.state === 'failed') return connection.failure?.class === 'AUTH' || connection.failure?.class === 'TERMINAL' ? 'Check your session, then reload to reconnect.' : 'Reload to start a new connection.';
 if (connection.failure?.class === 'THROTTLE') return 'Server is busy. Automatic retry is pending.';
 if (connection.failure?.class === 'DRAIN') return 'Server is restarting. Automatic reconnect is pending.';
 return 'Waiting for automatic reconnect. Check the network if this continues.';
}

/** @param {HTMLElement} el @param {any} dt */
function renderConnection(el, dt) {
	const pending = dt.pending ? dt.pending.size : 0;
	const connection = dt.connection || { state: 'idle', since: null, failure: null };
	const cause = connection.failure;
	const html = `
		<div data-key="connection-state"><strong>${esc(message(connectionLabel(connection.state)))}</strong> ${esc(_ageString(connection.since))}</div>
		${cause ? `<div>${esc(message('Cause:'))} ${isolated(cause.class)} ${isolated(cause.kind)} ${isolated(cause.code ?? cause.status ?? '')}</div>` : ''}
		<div>${esc(message(connectionAction(connection)))}</div>
		<div style="padding:2px 0">${esc(message('Pending RPCs: {count}', { count: number(pending) }))}</div>
		<div style="padding:2px 0">${esc(message('History entries: {count}', { count: number((dt.history || []).filter(Boolean).length) }))}</div>
		<div style="padding:2px 0">${esc(message('Active streams: {count}', { count: number(dt.streams ? dt.streams.size : 0) }))}</div>
		<div style="padding:4px 0;color:var(--svr-dt-muted, #b3b8cc);font-size:11px">${esc(message('Press Ctrl+Shift+L to toggle'))}</div>
	`;

	if (html !== _lastRenderedHtml) {
		_lastRenderedHtml = html;
		patchContent(el, html);
	}
}

// Auto-init when loaded
if (import.meta.env?.DEV === true && !import.meta.env?.PROD && typeof window !== 'undefined') {
	configureDevtools({ locale: navigator.language });
	init();
}
