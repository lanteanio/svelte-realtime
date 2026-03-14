// @ts-check
// DevTools overlay for svelte-realtime (dev-mode only)
// Injected by the Vite plugin via transformIndexHtml

/** @type {HTMLElement | null} */
let panel = null;
let visible = false;
let activeTab = 'rpcs';

/** @type {ReturnType<typeof setInterval> | null} */
let refreshInterval = null;

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
		html += '<div style="color:#ffc107;margin-bottom:6px">Pending (' + pending.length + ')</div>';
		for (const p of pending) {
			const elapsed = Date.now() - p.startTime;
			html += `<div style="padding:2px 0;color:#aaa">${esc(p.path)} <span style="color:#666">${elapsed}ms</span></div>`;
		}
		html += '<hr style="border-color:#333;margin:6px 0">';
	}

	html += '<div style="margin-bottom:4px">History (' + history.length + ')</div>';
	for (let i = history.length - 1; i >= Math.max(0, history.length - 20); i--) {
		const h = history[i];
		const color = h.ok ? '#4caf50' : '#f44336';
		html += `<div style="padding:2px 0"><span style="color:${color}">${h.ok ? 'OK' : 'ERR'}</span> ${esc(h.path)} <span style="color:#666">${h.duration}ms</span></div>`;
	}
	if (history.length === 0) html += '<div style="color:#666">No RPC calls yet</div>';

	if (html !== _lastRenderedHtml) {
		_lastRenderedHtml = html;
		el.innerHTML = html;
	}
}

/** @param {HTMLElement} el @param {any} dt */
function renderStreams(el, dt) {
	const streams = dt.streams ? Array.from(dt.streams.values()) : [];
	let html = '<div style="margin-bottom:4px">Active (' + streams.length + ')</div>';
	for (const s of streams) {
		html += `<div style="padding:2px 0">${esc(s.path)} <span style="color:#666">topic:${esc(s.topic || '?')} subs:${s.subCount}</span></div>`;
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
		<div style="padding:2px 0">Pending RPCs: ${pending}</div>
		<div style="padding:2px 0">History entries: ${(dt.history || []).length}</div>
		<div style="padding:2px 0">Active streams: ${dt.streams ? dt.streams.size : 0}</div>
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
