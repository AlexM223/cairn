import { describe, it, expect } from 'vitest';
import {
	isWithinQuietHours,
	quietWindowEnd,
	parseHhmm,
	isValidTimeZone,
	type QuietHours
} from './quietHours';

// Fixed instants in UTC so tests are deterministic regardless of the runner's
// zone. We pass tz: 'UTC' so wall-clock == UTC clock.
function utc(hh: number, mm = 0): number {
	return Date.UTC(2026, 0, 15, hh, mm, 0);
}

const base: QuietHours = { enabled: true, start: '22:00', end: '07:00', tz: 'UTC', urgentOverride: true };

describe('parseHhmm', () => {
	it('parses valid HH:MM to minutes-of-day', () => {
		expect(parseHhmm('00:00')).toBe(0);
		expect(parseHhmm('07:30')).toBe(450);
		expect(parseHhmm('23:59')).toBe(1439);
	});
	it('rejects invalid input', () => {
		expect(parseHhmm('24:00')).toBeNull();
		expect(parseHhmm('7:5')).toBeNull();
		expect(parseHhmm('nope')).toBeNull();
		expect(parseHhmm(null)).toBeNull();
	});
});

describe('isWithinQuietHours (wrap-around window 22:00–07:00)', () => {
	it('is inside late at night', () => {
		expect(isWithinQuietHours(base, utc(23))).toBe(true);
		expect(isWithinQuietHours(base, utc(3))).toBe(true);
		expect(isWithinQuietHours(base, utc(6, 59))).toBe(true);
	});
	it('is outside during the day', () => {
		expect(isWithinQuietHours(base, utc(7))).toBe(false);
		expect(isWithinQuietHours(base, utc(12))).toBe(false);
		expect(isWithinQuietHours(base, utc(21, 59))).toBe(false);
	});
});

describe('isWithinQuietHours (same-day window 09:00–17:00)', () => {
	const day: QuietHours = { ...base, start: '09:00', end: '17:00' };
	it('is inside during the day, outside otherwise', () => {
		expect(isWithinQuietHours(day, utc(10))).toBe(true);
		expect(isWithinQuietHours(day, utc(8, 59))).toBe(false);
		expect(isWithinQuietHours(day, utc(17))).toBe(false);
	});
});

describe('isWithinQuietHours guards', () => {
	it('returns false when disabled or unconfigured', () => {
		expect(isWithinQuietHours({ ...base, enabled: false }, utc(23))).toBe(false);
		expect(isWithinQuietHours({ ...base, start: null }, utc(23))).toBe(false);
		expect(isWithinQuietHours({ ...base, start: '07:00', end: '07:00' }, utc(23))).toBe(false);
	});
});

describe('quietWindowEnd', () => {
	it('resolves the next end boundary (same night)', () => {
		// At 23:00, the window ends at 07:00 the next day → 8h later.
		expect(quietWindowEnd(base, utc(23))).toBe(utc(23) + 8 * 3_600_000);
	});
	it('resolves the end when already past midnight', () => {
		// At 03:00, the window ends at 07:00 same day → 4h later.
		expect(quietWindowEnd(base, utc(3))).toBe(utc(3) + 4 * 3_600_000);
	});
});

describe('isValidTimeZone', () => {
	it('accepts real zones and rejects junk', () => {
		expect(isValidTimeZone('UTC')).toBe(true);
		expect(isValidTimeZone('America/New_York')).toBe(true);
		expect(isValidTimeZone('Not/AZone')).toBe(false);
	});
});
