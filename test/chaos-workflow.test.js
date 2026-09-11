import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(path.join(root, '.github/workflows/chaos-recovery.yml'), 'utf-8');

describe('recovery chaos workflow', () => {
	it('runs the destructive recovery spec from the realtime event revision', () => {
		expect(workflow).toContain('ref: ${{ github.sha }}');
		expect(workflow).toContain('recovery.spec.js --reporter=line,junit');
		expect(workflow).toContain('Verify Docker daemon');
		expect(workflow).not.toContain('REALTIME_REF');
	});

	it('is bounded, read-only, and preserves machine-readable evidence', () => {
		expect(workflow).toMatch(/permissions:\s+contents: read/);
		expect(workflow).toContain('timeout-minutes: 20');
		expect(workflow).toContain('PLAYWRIGHT_JUNIT_OUTPUT_NAME: test/chaos/test-results/recovery-junit.xml');
		expect(workflow).toContain('if: always()');
		expect(workflow).toContain('if-no-files-found: error');
		expect(workflow).toContain('test/chaos/test-results/**');
	});
});
