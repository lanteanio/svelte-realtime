// @ts-check
// DevTools overlay for svelte-realtime (dev-mode only)
// Injected by the Vite plugin via transformIndexHtml

/** @type {HTMLElement | null} */
let panel = null;
let visible = false;
let activeTab = 'rpcs';

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
	if (panel) panel.style.display = visible ? 'block' : 'none';
	if (visible && !refreshInterval) {
		const content = panel?.querySelector('div:last-child');
		if (content) render(/** @type {HTMLElement} */ (content));
		refreshInterval = setInterval(() => {
			const content = panel?.querySelector('div:last-child');
			if (content) render(/** @type {HTMLElement} */ (content));
		}, 1000);
	} else if (!visible && refreshInterval) {
		clearInterval(refreshInterval);
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
	});

	panel = document.createElement('div');
	panel.id = 'svelte-realtime-devtools';
	panel.style.cssText = `
		display: none; position: fixed; bottom: 10px; right: 10px; width: 420px; max-height: 400px;
		background: #1a1a2e; color: #e0e0e0; border: 1px solid #333; border-radius: 8px;
		font-family: monospace; font-size: 12px; z-index: 99999; overflow: hidden;
		box-shadow: 0 4px 20px rgba(0,0,0,0.5);
	`;

	const header = document.createElement('div');
	header.style.cssText = `
		padding: 6px 10px; background: #16213e; display: flex; justify-content: space-between;
		align-items: center; cursor: move; user-select: none; border-bottom: 1px solid #333;
	`;
	header.innerHTML = '<span style="font-weight:bold;color:#e94560">svelte-realtime</span>';

	const closeBtn = document.createElement('button');
	closeBtn.textContent = 'x';
	closeBtn.style.cssText = 'background:none;border:none;color:#888;cursor:pointer;font-size:14px;padding:0 4px;';
	closeBtn.onclick = toggle;
	header.appendChild(closeBtn);

	// Drag support
	let dragging = false, dx = 0, dy = 0;
	header.onmousedown = (e) => {
		dragging = true;
		dx = e.clientX - panel.offsetLeft;
		dy = e.clientY - panel.offsetTop;
	};
	document.addEventListener('mousemove', (e) => {
		if (!dragging) return;
		panel.style.left = (e.clientX - dx) + 'px';
		panel.style.top = (e.clientY - dy) + 'px';
		panel.style.right = 'auto';
		panel.style.bottom = 'auto';
	});
	document.addEventListener('mouseup', () => { dragging = false; });

	const tabs = document.createElement('div');
	tabs.style.cssText = 'display:flex;border-bottom:1px solid #333;';

	const content = document.createElement('div');
	content.style.cssText = 'padding:8px;overflow-y:auto;max-height:320px;';

	const tabNames = ['rpcs', 'streams', 'connection'];
	for (const name of tabNames) {
		const btn = document.createElement('button');
		btn.textContent = name;
		btn.style.cssText = `
			flex:1;padding:5px;background:none;border:none;color:#888;cursor:pointer;
			font-family:monospace;font-size:11px;border-bottom:2px solid transparent;
		`;
		btn.onclick = () => {
			activeTab = name;
			_lastRenderedHtml = '';
			for (const b of tabs.children) {
				/** @type {HTMLElement} */ (b).style.borderBottomColor = 'transparent';
				/** @type {HTMLElement} */ (b).style.color = '#888';
			}
			btn.style.borderBottomColor = '#e94560';
			btn.style.color = '#e0e0e0';
			render(content);
		};
		if (name === activeTab) {
			btn.style.borderBottomColor = '#e94560';
			btn.style.color = '#e0e0e0';
		}
		tabs.appendChild(btn);
	}

	panel.appendChild(header);
	panel.appendChild(tabs);
	panel.appendChild(content);
	document.body.appendChild(panel);

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

	// Refresh managed by toggle() -- no idle timer when hidden
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
		el.textContent = 'No devtools data available';
		return;
	}

	if (activeTab === 'rpcs') {
		renderRpcs(el, devtools);
	} else if (activeTab === 'streams') {
		renderStreams(el, devtools);
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

/** @param {HTMLElement} el @param {any} dt */
function renderRpcs(el, dt) {
	const pending = dt.pending ? Array.from(dt.pending.values()) : [];
	const history = dt.history || [];

	let html = '';
	if (pending.length > 0) {
		html += '<div style="color:#ffc107;margin-bottom:6px">Pending (' + esc(String(pending.length)) + ')</div>';
		for (const p of pending) {
			const elapsed = Date.now() - p.startTime;
			html += `<div style="padding:2px 0;color:#aaa">${esc(p.path)} <span style="color:#666">${esc(String(elapsed))}ms</span></div>`;
		}
		html += '<hr style="border-color:#333;margin:6px 0">';
	}

	const entries = history.filter(Boolean).sort((a, b) => (b.seq || 0) - (a.seq || 0));
	html += '<div style="margin-bottom:4px">History (' + esc(String(entries.length)) + ')</div>';
	for (let i = 0; i < Math.min(entries.length, 20); i++) {
		const h = entries[i];
		const color = h.ok ? '#4caf50' : '#f44336';
		html += `<div style="padding:2px 0"><span style="color:${color}">${h.ok ? 'OK' : 'ERR'}</span> ${esc(h.path)} <span style="color:#666">${esc(String(h.duration))}ms</span></div>`;
	}
	if (entries.length === 0) html += '<div style="color:#666">No RPC calls yet</div>';

	if (html !== _lastRenderedHtml) {
		_lastRenderedHtml = html;
		el.innerHTML = html;
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
	const ms = Date.now() - t;
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
	const pauseColor = streamsPaused ? '#ffc107' : '#888';
	const modeLabel = streamsRawMode ? 'Raw' : 'Pretty';

	let html = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:10px">` +
		`<span style="color:#888">Active (${esc(String(streams.length))})</span>` +
		`<span style="flex:1"></span>` +
		`<button data-action="toggle-raw" style="background:none;border:1px solid #333;color:#aaa;cursor:pointer;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:3px">${esc(modeLabel)}</button>` +
		`<button data-action="toggle-pause" style="background:none;border:1px solid #333;color:${pauseColor};cursor:pointer;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:3px">${esc(pauseLabel)}</button>` +
		`<button data-action="clear-events" style="background:none;border:1px solid #333;color:#aaa;cursor:pointer;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:3px">Clear events</button>` +
		`</div>`;

	for (const s of streams) {
		const merge = s.merge ? esc(s.merge) : '?';
		const topic = esc(s.topic || '?');
		const subs = esc(String(s.subCount));
		const lastEvt = s.lastEvent
			? `last:${esc(s.lastEvent)} ${esc(_ageString(s.lastEventTime))}`
			: 'no events yet';
		const errPart = s.error
			? `<div style="padding:1px 0 1px 12px;color:#f44336">err: ${esc(s.error.code)} -- ${esc(s.error.message)}</div>`
			: '';
		const expanded = expandedStreams.has(s.path);
		const recentCount = (s.recentEvents && s.recentEvents.length) || 0;
		const chevron = expanded ? '[-]' : '[+]';
		const chevronColor = recentCount > 0 ? '#aaa' : '#555';

		html += `<div style="padding:4px 0;border-bottom:1px solid #2a2a3e">` +
			`<div data-action="toggle-stream" data-stream-path="${esc(s.path)}" style="cursor:pointer;display:flex;align-items:center;gap:4px">` +
			`<span style="color:${chevronColor};width:10px;display:inline-block">${chevron}</span>` +
			`<span>${esc(s.path)}</span>` +
			(recentCount > 0 ? `<span style="color:#666;font-size:10px;margin-left:6px">(${recentCount})</span>` : '') +
			`</div>` +
			`<div style="padding:1px 0 1px 16px;color:#888">topic:${topic} merge:${merge} subs:${subs}</div>` +
			`<div style="padding:1px 0 1px 16px;color:#666">${lastEvt}</div>` +
			errPart;

		if (expanded) {
			if (recentCount === 0) {
				html += `<div style="padding:4px 0 4px 24px;color:#555;font-style:italic">No events captured yet${streamsPaused ? ' (paused)' : ''}</div>`;
			} else {
				const recent = /** @type {Array<{event: string, data: any, ts: number}>} */ (s.recentEvents);
				html += `<div style="padding:2px 0 4px 24px">`;
				for (let i = recent.length - 1; i >= 0; i--) {
					const ev = recent[i];
					const time = new Date(ev.ts).toLocaleTimeString('en', {
						hour12: false,
						hour: '2-digit',
						minute: '2-digit',
						second: '2-digit'
					});
					const payload = _renderPayload(ev.data, streamsRawMode);
					if (streamsRawMode) {
						html += `<div style="padding:1px 0;color:#aaa;word-break:break-all"><span style="color:#666">${esc(time)}</span> <span style="color:#e94560">${esc(ev.event)}</span> ${esc(payload)}</div>`;
					} else {
						html += `<div style="display:flex;gap:6px;padding:1px 0;align-items:baseline"><span style="color:#666;tabular-nums;flex-shrink:0">${esc(time)}</span><span style="color:#e94560;flex-shrink:0">${esc(ev.event)}</span><span style="color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(payload)}</span></div>`;
					}
				}
				html += `</div>`;
			}
		}

		html += `</div>`;
	}
	if (streams.length === 0) html += '<div style="color:#666">No active streams</div>';

	if (html !== _lastRenderedHtml) {
		_lastRenderedHtml = html;
		el.innerHTML = html;
	}
}

/** @param {HTMLElement} el @param {any} dt */
function renderConnection(el, dt) {
	const pending = dt.pending ? dt.pending.size : 0;
	const html = `
		<div style="padding:2px 0">Pending RPCs: ${esc(String(pending))}</div>
		<div style="padding:2px 0">History entries: ${esc(String((dt.history || []).filter(Boolean).length))}</div>
		<div style="padding:2px 0">Active streams: ${esc(String(dt.streams ? dt.streams.size : 0))}</div>
		<div style="padding:4px 0;color:#666;font-size:11px">Press Ctrl+Shift+L to toggle</div>
	`;

	if (html !== _lastRenderedHtml) {
		_lastRenderedHtml = html;
		el.innerHTML = html;
	}
}

// Auto-init when loaded
if (typeof window !== 'undefined') {
	init();
}
