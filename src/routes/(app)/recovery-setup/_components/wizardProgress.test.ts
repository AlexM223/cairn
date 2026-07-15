import { describe, it, expect } from 'vitest';
import { parseSavedProgress, hasMeaningfulProgress, type WizardProgress } from './wizardProgress';

const NOW = 1_000_000_000;

describe('parseSavedProgress', () => {
	it('returns null for no snapshot', () => {
		expect(parseSavedProgress(null, NOW)).toBeNull();
	});

	it('returns null for malformed JSON', () => {
		expect(parseSavedProgress('{not json', NOW)).toBeNull();
	});

	it('returns null for a non-object payload', () => {
		expect(parseSavedProgress('"just a string"', NOW)).toBeNull();
		expect(parseSavedProgress('42', NOW)).toBeNull();
	});

	it('parses a valid phrase-step snapshot', () => {
		const raw = JSON.stringify({ step: 'phrase', savedAt: NOW - 1000 });
		expect(parseSavedProgress(raw, NOW)).toEqual({ step: 'phrase', savedAt: NOW - 1000 });
	});

	it('parses a valid codes-step snapshot', () => {
		const raw = JSON.stringify({ step: 'codes', savedAt: NOW - 1000 });
		expect(parseSavedProgress(raw, NOW)).toEqual({ step: 'codes', savedAt: NOW - 1000 });
	});

	it('rejects an unknown step value', () => {
		const raw = JSON.stringify({ step: 'verify', savedAt: NOW - 1000 });
		expect(parseSavedProgress(raw, NOW)).toBeNull();
	});

	it('rejects a "done" step (never persisted, and not resumable)', () => {
		const raw = JSON.stringify({ step: 'done', savedAt: NOW - 1000 });
		expect(parseSavedProgress(raw, NOW)).toBeNull();
	});

	it('rejects a snapshot older than the max age', () => {
		const raw = JSON.stringify({ step: 'codes', savedAt: NOW - 61 * 60 * 1000 });
		expect(parseSavedProgress(raw, NOW)).toBeNull();
	});

	it('rejects a snapshot saved in the future', () => {
		const raw = JSON.stringify({ step: 'codes', savedAt: NOW + 1000 });
		expect(parseSavedProgress(raw, NOW)).toBeNull();
	});

	it('rejects a snapshot missing savedAt', () => {
		const raw = JSON.stringify({ step: 'codes' });
		expect(parseSavedProgress(raw, NOW)).toBeNull();
	});

	it('never carries the phrase or codes payload even if injected', () => {
		// Defense in depth: even if something upstream accidentally stuffed
		// secret fields into the blob, the parser only ever reads step/savedAt.
		const raw = JSON.stringify({
			step: 'codes',
			savedAt: NOW - 1000,
			phrase: 'abandon ability able about above absent absorb abstract absurd abuse access accident',
			codes: ['AAAA-1111']
		});
		const parsed = parseSavedProgress(raw, NOW);
		expect(parsed).toEqual({ step: 'codes', savedAt: NOW - 1000 });
		expect(Object.keys(parsed as WizardProgress)).toEqual(['step', 'savedAt']);
	});
});

describe('hasMeaningfulProgress', () => {
	it('is false for the default first screen', () => {
		expect(hasMeaningfulProgress({ step: 'phrase', savedAt: NOW })).toBe(false);
	});

	it('is true once the user has reached the codes step', () => {
		expect(hasMeaningfulProgress({ step: 'codes', savedAt: NOW })).toBe(true);
	});
});
