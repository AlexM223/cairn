import { describe, it, expect } from 'vitest';
import { binomial, classifyQuorum, type QuorumTier } from './quorumRisk';

describe('binomial', () => {
	it('computes known small values', () => {
		expect(binomial(3, 2)).toBe(3);
		expect(binomial(5, 3)).toBe(10);
		expect(binomial(10, 2)).toBe(45);
		expect(binomial(15, 2)).toBe(105);
		expect(binomial(15, 8)).toBe(6435);
	});

	it('C(n, n) is always 1', () => {
		for (let n = 1; n <= 15; n++) expect(binomial(n, n)).toBe(1);
	});

	it('C(n, 1) is always n', () => {
		for (let n = 1; n <= 15; n++) expect(binomial(n, 1)).toBe(n);
	});
});

describe('classifyQuorum tiers', () => {
	const cases: [number, number, QuorumTier][] = [
		[1, 1, 'red'],
		[1, 2, 'red'],
		[1, 15, 'red'],
		[2, 2, 'yellow'],
		[3, 3, 'yellow'],
		[15, 15, 'yellow'],
		[2, 4, 'salmon'],
		[2, 5, 'salmon'],
		[2, 10, 'salmon'],
		[3, 7, 'salmon'],
		[3, 6, 'salmon'],
		[2, 3, 'green'],
		[3, 4, 'lightgreen'],
		[3, 5, 'lightgreen'],
		[4, 5, 'lightgreen'],
		[5, 9, 'lightgreen'],
		[8, 15, 'lightgreen']
	];

	for (const [m, n, tier] of cases) {
		it(`classifies ${m}-of-${n} as ${tier}`, () => {
			expect(classifyQuorum(m, n).tier).toBe(tier);
		});
	}
});

describe('classifyQuorum totality', () => {
	it('returns one of the five known tiers for every valid m-of-n up to 15', () => {
		const known = new Set<QuorumTier>(['red', 'salmon', 'yellow', 'lightgreen', 'green']);
		for (let n = 1; n <= 15; n++) {
			for (let m = 1; m <= n; m++) {
				const risk = classifyQuorum(m, n);
				expect(known.has(risk.tier)).toBe(true);
			}
		}
	});
});

describe('classifyQuorum copy', () => {
	it('2-of-10 mentions the combination count (45)', () => {
		expect(classifyQuorum(2, 10).body).toContain('45');
	});

	it('2-of-2 suggests 2-of-3 as a spare', () => {
		expect(classifyQuorum(2, 2).body).toContain('2-of-3');
	});

	it('15-of-15 suggests 14-of-15 as a spare', () => {
		expect(classifyQuorum(15, 15).body).toContain('14-of-15');
	});

	it('2-of-4 suggests 3-of-4 as a stronger threshold', () => {
		expect(classifyQuorum(2, 4).body).toContain('3-of-4');
	});

	it('1-of-1 has no combos line', () => {
		expect(classifyQuorum(1, 1).combos).toBeNull();
	});
});
