// @ts-check

// Cron schedule parsing and matching. Pure helpers (no platform/state deps):
// `_parseCron` compiles an expression to per-field matchers, `_cronDateParts`
// reads the zoned wall-clock parts of an epoch-ms instant via Intl, and
// `_cronFieldMatch` tests a matcher against a value. The cron tick engine in
// server.js imports these back.

// English short weekday names mapped to the 0-6 (Sunday=0) convention the
// cron weekday field matches against, identical to the historical getDay()
// numbering. Pinning the formatter locale to 'en-US' keeps these names stable
// regardless of the host locale.
const _CRON_WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Extract the cron date parts (second, minute, hour, day, month 1-12,
 * weekday 0-6 Sunday=0) for an epoch-ms reference, formatted in the given
 * IANA time zone. Passing `undefined` for the zone uses the host system zone,
 * which preserves the historical local-time cron behavior. The numeric
 * epoch-ms is handed straight to Intl - no intermediate Date is constructed,
 * so a seeded clock plus a pinned zone makes the parts fully reproducible.
 *
 * @param {number} ms - epoch milliseconds
 * @param {string | undefined} tz - IANA zone, or undefined for the system zone
 * @returns {{ second: number, minute: number, hour: number, day: number, month: number, weekday: number }}
 */
export function _cronDateParts(ms, tz) {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		year: 'numeric', month: 'numeric', day: 'numeric',
		hour: 'numeric', minute: 'numeric', second: 'numeric',
		weekday: 'short',
		hour12: false
	});
	const parts = fmt.formatToParts(ms);
	const get = (k) => Number(parts.find(p => p.type === k)?.value);
	let hour = get('hour');
	if (hour === 24) hour = 0; // some Intl impls render midnight as 24
	const wd = parts.find(p => p.type === 'weekday')?.value;
	return {
		second: get('second'),
		minute: get('minute'),
		hour,
		day: get('day'),
		month: get('month'),
		weekday: _CRON_WEEKDAY_INDEX[wd] ?? 0
	};
}

/**
 * Parse a 5- or 6-field cron expression into an array of field matchers.
 * 5-field form is `minute hour day month weekday` (fires at second `:00`
 * of each matching minute). 6-field form prepends `seconds` (Quartz /
 * node-cron convention) and unlocks sub-minute schedules; once any
 * 6-field schedule is registered the cron tick adapts to 1 Hz so the
 * seconds field is honored.
 *
 * Supports: *, N, N-M, N,M, and *\/N in every field.
 * @param {string} expr
 * @returns {any[]}
 */
export function _parseCron(expr) {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5 && parts.length !== 6) {
		throw new Error(`[svelte-realtime] Invalid cron expression '${expr}' - expected 5 fields (minute hour day month weekday) or 6 fields (seconds minute hour day month weekday)\n  See: https://svti.me/cron`);
	}
	// Map each part to its semantic field index. 5-field input shifts
	// by one (no seconds) so fields land at indices 1..5; 6-field input
	// uses indices 0..5 directly.
	const offset = parts.length === 5 ? 1 : 0;
	return parts.map((field, idx) => _parseCronField(field, idx + offset));
}

/** Max values per cron field index: seconds, minute, hour, day, month, weekday */
const _CRON_RANGES = [[0, 59], [0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

/**
 * Parse a single cron field with validation.
 * Returns null for '*' (match all), or a Set of allowed values,
 * or { step: N } for step expressions.
 * @param {string} field
 * @param {number} idx - Semantic field index (0=seconds, 1=minute, 2=hour, 3=day, 4=month, 5=weekday)
 * @returns {any}
 */
function _parseCronField(field, idx) {
	const [min, max] = _CRON_RANGES[idx] || [0, 59];

	if (field === '*') return null;

	if (field.startsWith('*/')) {
		const step = parseInt(field.slice(2), 10);
		if (!Number.isFinite(step) || step < 1) {
			throw new Error(`[svelte-realtime] Invalid cron step '${field}' - step must be a positive integer\n  See: https://svti.me/cron`);
		}
		return { step };
	}

	if (field.includes('-') && !field.includes(',')) {
		const parts = field.split('-');
		const a = parseInt(parts[0], 10);
		const b = parseInt(parts[1], 10);
		if (!Number.isFinite(a) || !Number.isFinite(b) || a < min || b > max || a > b) {
			throw new Error(`[svelte-realtime] Invalid cron range '${field}' - values must be ${min}-${max}\n  See: https://svti.me/cron`);
		}
		const vals = new Set();
		for (let i = a; i <= b; i++) vals.add(i);
		return vals;
	}

	if (field.includes(',')) {
		const nums = field.split(',').map(s => {
			const n = parseInt(s, 10);
			if (!Number.isFinite(n) || n < min || n > max) {
				throw new Error(`[svelte-realtime] Invalid cron value '${s}' in '${field}' - must be ${min}-${max}\n  See: https://svti.me/cron`);
			}
			return n;
		});
		return new Set(nums);
	}

	const n = parseInt(field, 10);
	if (!Number.isFinite(n) || n < min || n > max) {
		throw new Error(`[svelte-realtime] Invalid cron value '${field}' - must be ${min}-${max}\n  See: https://svti.me/cron`);
	}
	return new Set([n]);
}

/**
 * Check if a value matches a cron field matcher.
 * @param {any} matcher
 * @param {number} value
 * @returns {boolean}
 */
export function _cronFieldMatch(matcher, value) {
	if (matcher === null) return true; // * matches all
	if (matcher.step) return value % matcher.step === 0;
	return matcher.has(value);
}
