/**
 * wire.ts numeric edge cases (ported from the Tessera pool wire spec). The
 * byte-order / merkle primitives are exercised end-to-end by job.test.ts; here
 * we pin difficultyToTarget / weightForDifficulty at the sub-quantum boundary.
 */
import { describe, expect, it } from 'vitest';
import { DIFF1_TARGET, difficultyToTarget, weightForDifficulty } from './wire';

describe('difficultyToTarget', () => {
	it('maps difficulty 1 to the diff-1 target', () => {
		expect(difficultyToTarget(1)).toBe(DIFF1_TARGET);
	});

	it('a larger difficulty yields a smaller (harder) target', () => {
		expect(difficultyToTarget(2) < difficultyToTarget(1)).toBe(true);
	});

	it('rejects a non-positive difficulty', () => {
		expect(() => difficultyToTarget(0)).toThrow(/positive/);
		expect(() => difficultyToTarget(-1)).toThrow(/positive/);
	});

	it('rejects a difficulty that rounds to zero at the 1e-6 quantum with a clean error', () => {
		expect(() => difficultyToTarget(4e-7)).toThrow(/rounds to zero/);
		expect(() => difficultyToTarget(4e-7)).not.toThrow(/Division by zero/);
		expect(() => weightForDifficulty(4e-7)).toThrow(/rounds to zero/);
	});

	it('accepts the smallest difficulty that does NOT round to zero (5e-7 → 1 unit)', () => {
		expect(difficultyToTarget(5e-7)).toBe((DIFF1_TARGET * 1_000_000n) / 1n);
		expect(weightForDifficulty(5e-7)).toBe(1n);
	});
});
