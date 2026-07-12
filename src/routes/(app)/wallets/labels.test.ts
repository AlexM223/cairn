import { describe, it, expect } from 'vitest';
import { featureEnabled } from './labels';

describe('featureEnabled', () => {
	it('is enabled when the flag is undefined (not yet loaded / not set)', () => {
		expect(featureEnabled(undefined)).toBe(true);
	});

	it('is enabled when the flag is explicitly true', () => {
		expect(featureEnabled(true)).toBe(true);
	});

	it('is disabled only on an explicit false', () => {
		expect(featureEnabled(false)).toBe(false);
	});
});
