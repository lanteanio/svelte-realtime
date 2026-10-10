import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { _cronDateParts } from '../src/server/cron.js';

it('keeps explicit timezone switches and calendar rollover independent', () => {
	const at = Date.UTC(2026, 0, 1, 1, 2, 3);
	expect(_cronDateParts(at, 'UTC')).toEqual({ second: 3, minute: 2, hour: 1, day: 1, month: 1, weekday: 4 });
	expect(_cronDateParts(at, 'America/New_York')).toEqual({ second: 3, minute: 2, hour: 20, day: 31, month: 12, weekday: 3 });
	expect(_cronDateParts(at, 'Europe/Berlin')).toEqual({ second: 3, minute: 2, hour: 2, day: 1, month: 1, weekday: 4 });
	expect(_cronDateParts(at, 'UTC').hour).toBe(1);
	expect(() => _cronDateParts(at, 'Not/A_Zone')).toThrow(RangeError);
	expect(_cronDateParts(at, 'UTC').hour).toBe(1);
});

it('preserves daylight-saving gaps and repeated wall hours in one zone', () => {
	expect(_cronDateParts(Date.UTC(2026, 2, 8, 6, 59, 59), 'America/New_York')).toMatchObject({ hour: 1, minute: 59, second: 59 });
	expect(_cronDateParts(Date.UTC(2026, 2, 8, 7), 'America/New_York')).toMatchObject({ hour: 3, minute: 0, second: 0 });
	expect(_cronDateParts(Date.UTC(2026, 10, 1, 5, 30), 'America/New_York')).toMatchObject({ hour: 1, minute: 30 });
	expect(_cronDateParts(Date.UTC(2026, 10, 1, 6, 30), 'America/New_York')).toMatchObject({ hour: 1, minute: 30 });
});

it('observes changes to the implicit local timezone in the same process', () => {
	const module = new URL('../src/server/cron.js', import.meta.url).href;
	const script = `import { _cronDateParts } from ${JSON.stringify(module)};
		const at = Date.UTC(2026,0,1,1,2,3), hours=[];
		for (const zone of ['UTC','America/New_York','Europe/Berlin','UTC']) {
			process.env.TZ=zone; hours.push(_cronDateParts(at).hour);
		}
		console.log(JSON.stringify(hours));`;
	const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
	expect(JSON.parse(result)).toEqual([1, 20, 2, 1]);
}, 20000);
