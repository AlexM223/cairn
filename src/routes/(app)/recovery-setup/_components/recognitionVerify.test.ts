import { describe, it, expect } from 'vitest';
import { buildVerifyQuestions } from './recognitionVerify';

/** Deterministic mulberry32 PRNG so tests never depend on Math.random. */
function seededRng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PHRASE = [
	'abandon', 'ability', 'able', 'about', 'above', 'absent',
	'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'
];

describe('buildVerifyQuestions', () => {
	it('returns the requested number of questions', () => {
		const qs = buildVerifyQuestions(PHRASE, 3, seededRng(1));
		expect(qs).toHaveLength(3);
	});

	it('clamps count to the phrase length instead of repeating positions', () => {
		const qs = buildVerifyQuestions(['one', 'two'], 5, seededRng(1));
		expect(qs).toHaveLength(2);
		const positions = qs.map((q) => q.position).sort();
		expect(positions).toEqual([1, 2]);
	});

	it('returns nothing for an empty phrase or a non-positive count', () => {
		expect(buildVerifyQuestions([], 3, seededRng(1))).toEqual([]);
		expect(buildVerifyQuestions(PHRASE, 0, seededRng(1))).toEqual([]);
		expect(buildVerifyQuestions(PHRASE, -1, seededRng(1))).toEqual([]);
	});

	it('never repeats a position across the returned questions', () => {
		const qs = buildVerifyQuestions(PHRASE, 4, seededRng(7));
		const positions = qs.map((q) => q.position);
		expect(new Set(positions).size).toBe(positions.length);
	});

	it('every position is within 1..words.length and correctWord matches the phrase', () => {
		const qs = buildVerifyQuestions(PHRASE, 4, seededRng(2));
		for (const q of qs) {
			expect(q.position).toBeGreaterThanOrEqual(1);
			expect(q.position).toBeLessThanOrEqual(PHRASE.length);
			expect(q.correctWord).toBe(PHRASE[q.position - 1]);
		}
	});

	it('each question has exactly one option matching the correct word (never duplicated)', () => {
		// Run across many seeds and phrase words (including ones that ARE in the
		// decoy pool, e.g. 'about') to hammer the one invariant that matters:
		// the correct word is never accidentally offered twice as an option.
		for (let seed = 0; seed < 50; seed++) {
			const qs = buildVerifyQuestions(PHRASE, PHRASE.length, seededRng(seed));
			for (const q of qs) {
				const matches = q.options.filter(
					(o) => o.toLowerCase() === q.correctWord.toLowerCase()
				);
				expect(matches).toHaveLength(1);
			}
		}
	});

	it('options contain no other duplicates and default to 4 choices', () => {
		const qs = buildVerifyQuestions(PHRASE, 3, seededRng(4));
		for (const q of qs) {
			expect(q.options).toHaveLength(4);
			expect(new Set(q.options.map((o) => o.toLowerCase())).size).toBe(4);
		}
	});

	it('respects a custom optionsPerQuestion', () => {
		const qs = buildVerifyQuestions(PHRASE, 2, seededRng(5), 3);
		for (const q of qs) {
			expect(q.options).toHaveLength(3);
		}
	});

	it('is deterministic for a given (words, count, rng-seed)', () => {
		const a = buildVerifyQuestions(PHRASE, 3, seededRng(42));
		const b = buildVerifyQuestions(PHRASE, 3, seededRng(42));
		expect(a).toEqual(b);
	});

	it('works with a phrase word that collides with the decoy pool (e.g. "about")', () => {
		const phraseWithDecoyWord = ['zebra', 'about', 'yankee', 'xray', 'whiskey', 'victor'];
		for (let seed = 0; seed < 20; seed++) {
			const qs = buildVerifyQuestions(phraseWithDecoyWord, phraseWithDecoyWord.length, seededRng(seed));
			for (const q of qs) {
				const matches = q.options.filter(
					(o) => o.toLowerCase() === q.correctWord.toLowerCase()
				);
				expect(matches).toHaveLength(1);
			}
		}
	});
});
