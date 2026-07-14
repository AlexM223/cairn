import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	formatBtc,
	formatSats,
	timeAgo,
	expiresIn,
	formatBytes,
	formatHashrate,
	formatFeeRate,
	formatMovedBtc,
	truncateMiddle,
	formatDuration,
	btcToFiat,
	formatFiat
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

describe('expiresIn', () => {
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
		[now + 2, 'now'],
		[now - 30, 'now'], // already past reads as "now", never "just now"
		[now + 30, 'in 30s'],
		[now + 59, 'in 59s'],
		[now + 120, 'in 2m'],
		[now + 3599, 'in 59m'],
		[now + 7200, 'in 2h'],
		[now + 86400 * 2, 'in 2d'],
		[now + 86400 * 29, 'in 29d']
	])('%s -> %s', (unix, expected) => {
		expect(expiresIn(unix)).toBe(expected);
	});

	it('falls back to a formatted date for 30+ days out', () => {
		expect(expiresIn(now + 86400 * 40)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
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
		[1_500_000, '1.50 MB'],
		[999_999_999, '1000.00 MB'],
		[1_000_000_000, '1.00 GB'],
		[1_500_000_000, '1.50 GB'],
		[999_999_999_999, '1000.00 GB'],
		[1_000_000_000_000, '1.00 TB'],
		[1_381_032_320_000, '1.38 TB'], // admin storage figure regression (cairn-k3ex)
		[1_999_751_870_000, '2.00 TB']
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
		[0, '0 sat/vB'],
		// Sub-1 sat/vB rates (cairn-eacw.6): a real nonzero rate must never render
		// as a dishonest "0" just because it's smaller than the old 1 sat/vB floor.
		[0.04, '0.04 sat/vB'],
		[0.01, '0.01 sat/vB'],
		[0.5, '0.5 sat/vB'],
		[0.1, '0.1 sat/vB'],
		[1.5, '1.5 sat/vB']
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

describe('btcToFiat', () => {
	it('multiplies BTC amount by spot price', () => {
		expect(btcToFiat(1, 65_000)).toBe(65_000);
		expect(btcToFiat(0.5, 65_000)).toBe(32_500);
		expect(btcToFiat(0, 65_000)).toBe(0);
	});
});

describe('formatFiat', () => {
	it('formats as USD currency with 2 decimals', () => {
		expect(formatFiat(1234.5)).toBe('$1,234.50');
		expect(formatFiat(0)).toBe('$0.00');
		expect(formatFiat(0.5)).toBe('$0.50');
	});

	it('compacts amounts >= $1M', () => {
		expect(formatFiat(1_200_000)).toBe('$1.2M');
	});
});

describe('formatMovedBtc', () => {
	it('renders nothing for null/undefined (unknown total_out)', () => {
		expect(formatMovedBtc(null)).toBeNull();
		expect(formatMovedBtc(undefined)).toBeNull();
	});

	it('renders nothing for non-finite values', () => {
		expect(formatMovedBtc(NaN)).toBeNull();
		expect(formatMovedBtc(Infinity)).toBeNull();
	});

	it('renders nothing for 0 or negative (a real block always moves >0 value; 0 is an imperfect/synthetic snapshot artifact, not a fact — cairn-6efi.11)', () => {
		expect(formatMovedBtc(0)).toBeNull();
		expect(formatMovedBtc(-100)).toBeNull();
	});

	it('shows 3 decimals under 1 BTC', () => {
		expect(formatMovedBtc(50_000_000)).toBe('~0.500 BTC');
	});

	it('shows 1 decimal from 1 up to 100 BTC', () => {
		expect(formatMovedBtc(250_000_000)).toBe('~2.5 BTC');
	});

	it('rounds to a whole, thousands-separated number at >=100 BTC', () => {
		expect(formatMovedBtc(150_00_000_000)).toBe('~150 BTC');
		expect(formatMovedBtc(1_234 * 100_000_000)).toBe('~1,234 BTC');
	});
});
