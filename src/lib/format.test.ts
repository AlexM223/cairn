import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	formatBtc,
	formatSats,
	timeAgo,
	formatBytes,
	formatHashrate,
	formatFeeRate,
	truncateMiddle,
	formatDuration
} from './format';

describe('formatBtc', () => {
	it.each([
		[0, '0.00'],
		[100_000_000, '1.00'],
		[150_000_000, '1.50'],
		[123_456_789, '1.23456789'],
		[1, '0.00000001'], // one sat of dust keeps all 8 decimals
		[10, '0.0000001'],
		[2_100_000_000_000_000, '21000000.00'] // total supply
	])('%i sats -> %s', (sats, expected) => {
		expect(formatBtc(sats)).toBe(expected);
	});

	it('prefixes negatives with a minus sign', () => {
		expect(formatBtc(-150_000_000)).toBe('-1.50');
		expect(formatBtc(-1)).toBe('-0.00000001');
	});

	it('keeps all 8 decimals when trim is off', () => {
		expect(formatBtc(100_000_000, { trim: false })).toBe('1.00000000');
		expect(formatBtc(0, { trim: false })).toBe('0.00000000');
	});
});

describe('formatSats', () => {
	it('adds US thousands separators', () => {
		expect(formatSats(123456789)).toBe('123,456,789');
		expect(formatSats(0)).toBe('0');
	});
});

describe('timeAgo', () => {
	const NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20Z

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW_MS);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const now = NOW_MS / 1000;

	it.each([
		[null, '—'],
		[undefined, '—'],
		[now - 2, 'just now'],
		[now - 30, '30s ago'],
		[now - 59, '59s ago'],
		[now - 120, '2m ago'],
		[now - 3599, '59m ago'],
		[now - 7200, '2h ago'],
		[now - 86400 * 2, '2d ago'],
		[now - 86400 * 29, '29d ago']
	])('%s -> %s', (unix, expected) => {
		expect(timeAgo(unix)).toBe(expected);
	});

	it('falls back to a formatted date for 30+ days', () => {
		expect(timeAgo(now - 86400 * 40)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
	});
});

describe('formatBytes', () => {
	it.each([
		[0, '0 B'],
		[999, '999 B'],
		[1000, '1.0 kB'],
		[123_456, '123.5 kB'],
		[999_999, '1000.0 kB'],
		[1_000_000, '1.00 MB'],
		[1_500_000, '1.50 MB']
	])('%i -> %s', (bytes, expected) => {
		expect(formatBytes(bytes)).toBe(expected);
	});
});

describe('formatHashrate', () => {
	it.each([
		[0, '0.0 H/s'],
		[500, '500 H/s'],
		[1500, '1.5 kH/s'],
		[2_000_000, '2.0 MH/s'],
		[3_500_000_000, '3.5 GH/s'],
		[1e12, '1.0 TH/s'],
		[1e15, '1.0 PH/s'],
		[6.5e20, '650 EH/s'],
		[1e21, '1.0 ZH/s'],
		[1e27, '1000000 ZH/s'] // clamps at the largest unit
	])('%d H/s -> %s', (hs, expected) => {
		expect(formatHashrate(hs)).toBe(expected);
	});
});

describe('formatFeeRate', () => {
	it.each([
		[null, '—'],
		[undefined, '—'],
		[1, '1 sat/vB'], // trailing .0 trimmed
		[2.5, '2.5 sat/vB'],
		[9.94, '9.9 sat/vB'],
		[9.96, '10 sat/vB'], // rounds up out of the decimal regime
		[10.4, '10 sat/vB'],
		[25.6, '26 sat/vB'],
		[0, '0 sat/vB']
	])('%s -> %s', (rate, expected) => {
		expect(formatFeeRate(rate)).toBe(expected);
	});
});

describe('truncateMiddle', () => {
	it('truncates long strings with an ellipsis', () => {
		expect(truncateMiddle('abcdefghijklmnopqrstuvwxyz')).toBe('abcdefgh…stuvwxyz');
	});

	it('honors custom head/tail lengths', () => {
		expect(truncateMiddle('abcdefghijklmnopqrstuvwxyz', 3, 3)).toBe('abc…xyz');
	});

	it('returns short strings untouched', () => {
		expect(truncateMiddle('short')).toBe('short');
		expect(truncateMiddle('exactly17chars!!!')).toBe('exactly17chars!!!');
		expect(truncateMiddle('')).toBe('');
	});
});

describe('formatDuration', () => {
	it.each([
		[0, '0s'],
		[45, '45s'],
		[89, '89s'],
		[90, '2 min'], // 90s rounds to 2 min
		[600, '10 min'],
		[5399, '90 min'],
		[5400, '1.5 h'],
		[7200, '2.0 h'],
		[36_000, '10.0 h']
	])('%d s -> %s', (seconds, expected) => {
		expect(formatDuration(seconds)).toBe(expected);
	});
});
