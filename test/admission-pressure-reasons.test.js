import { describe, expect, it, beforeEach } from 'vitest';
import { live, PRESSURE_REASONS } from '../src/server.js';
import { _resetAdmission, _shouldShed } from '../src/server/admission.js';

const EXPECTED_ADAPTER_REASONS = [
	'NONE', 'SUBSCRIBERS', 'PUBLISH_RATE', 'PSI', 'CPU_QUOTA', 'CAPACITY', 'MEMORY'
];

describe('admission pressure-reason contract', () => {
	beforeEach(() => { _resetAdmission(); });

	it('matches the adapter oracle and sheds every configured reason', () => {
		expect(PRESSURE_REASONS).toEqual(EXPECTED_ADAPTER_REASONS);
		expect(Object.isFrozen(PRESSURE_REASONS)).toBe(true);

		live.admission({ classes: { all: PRESSURE_REASONS } });
		for (const reason of PRESSURE_REASONS) {
			expect(_shouldShed({ pressure: { reason } }, 'all'), reason).toBe(true);
		}
	});

	it.each(['PSI', 'CPU_QUOTA', 'CAPACITY'])('accepts and enforces urgent reason %s', (reason) => {
		live.admission({ classes: { urgent: [reason] } });
		expect(_shouldShed({ pressure: { reason } }, 'urgent')).toBe(true);
	});
});
