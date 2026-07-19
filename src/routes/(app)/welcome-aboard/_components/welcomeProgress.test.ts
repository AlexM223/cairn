import { describe, it, expect } from 'vitest';
import {
	parseSavedWelcomeProgress,
	WELCOME_PROGRESS_MAX_AGE_MS,
	WELCOME_STEPS
} from './welcomeProgress';

const NOW = 1_800_000_000_000;

function snap(step: string, savedAt: number = NOW - 1000): string {
	return JSON.stringify({ step, savedAt });
}

describe('parseSavedWelcomeProgress', () => {
	it('round-trips every real step', () => {
		for (const step of WELCOME_STEPS) {
			expect(parseSavedWelcomeProgress(snap(step), NOW)).toEqual({
				step,
				savedAt: NOW - 1000
			});
		}
	});

	it('rejects null, junk JSON, and non-object payloads', () => {
		expect(parseSavedWelcomeProgress(null, NOW)).toBeNull();
		expect(parseSavedWelcomeProgress('not json{', NOW)).toBeNull();
		expect(parseSavedWelcomeProgress('"aboard"', NOW)).toBeNull();
		expect(parseSavedWelcomeProgress('42', NOW)).toBeNull();
	});

	it('rejects unknown steps — including the terminal "done", which is never saved', () => {
		expect(parseSavedWelcomeProgress(snap('done'), NOW)).toBeNull();
		expect(parseSavedWelcomeProgress(snap('keys'), NOW)).toBeNull();
		expect(parseSavedWelcomeProgress(snap(''), NOW)).toBeNull();
	});

	it('rejects stale and future-dated snapshots', () => {
		expect(
			parseSavedWelcomeProgress(snap('view', NOW - WELCOME_PROGRESS_MAX_AGE_MS - 1), NOW)
		).toBeNull();
		expect(parseSavedWelcomeProgress(snap('view', NOW + 5000), NOW)).toBeNull();
		// Just inside the window still resumes.
		expect(
			parseSavedWelcomeProgress(snap('view', NOW - WELCOME_PROGRESS_MAX_AGE_MS + 1000), NOW)
		).not.toBeNull();
	});

	it('rejects missing or malformed savedAt', () => {
		expect(parseSavedWelcomeProgress(JSON.stringify({ step: 'view' }), NOW)).toBeNull();
		expect(
			parseSavedWelcomeProgress(JSON.stringify({ step: 'view', savedAt: 'yesterday' }), NOW)
		).toBeNull();
		expect(
			parseSavedWelcomeProgress(JSON.stringify({ step: 'view', savedAt: Infinity }), NOW)
		).toBeNull();
	});
});
