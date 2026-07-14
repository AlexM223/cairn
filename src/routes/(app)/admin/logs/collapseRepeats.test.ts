// cairn-fgbx: dozens of identical consecutive INFO lines (classically
// "gate: (app) redirect") drowned out signal in the admin log viewer. These
// pin the collapsing behavior: an unbroken run of identical lines merges into
// one row with a repeat count; anything that breaks the run, or genuinely
// differs, stays separate.

import { describe, it, expect } from 'vitest';
import { sameLine, collapseRepeats, type CollapsibleLine } from './collapseRepeats';

function line(overrides: Partial<CollapsibleLine> = {}): CollapsibleLine {
	return {
		levelName: 'info',
		tag: 'gate',
		msg: 'gate: (app) redirect',
		fields: { method: 'GET', path: '/wallets', target: '/login' },
		time: 1000,
		...overrides
	};
}

describe('sameLine', () => {
	it('matches identical level/tag/msg/fields regardless of time', () => {
		expect(sameLine(line({ time: 1 }), line({ time: 2 }))).toBe(true);
	});

	it('differs on tag, msg, level, or fields', () => {
		expect(sameLine(line(), line({ tag: 'other' }))).toBe(false);
		expect(sameLine(line(), line({ msg: 'different message' }))).toBe(false);
		expect(sameLine(line(), line({ levelName: 'warn' }))).toBe(false);
		expect(sameLine(line(), line({ fields: { method: 'POST', path: '/wallets', target: '/login' } }))).toBe(
			false
		);
	});

	it('treats two lines with no fields as identical', () => {
		expect(sameLine(line({ fields: undefined }), line({ fields: undefined }))).toBe(true);
	});
});

describe('collapseRepeats', () => {
	it('merges an unbroken run of identical lines into one entry with a repeat count', () => {
		const items = [
			{ e: line({ time: 300 }), id: 0 },
			{ e: line({ time: 200 }), id: 1 },
			{ e: line({ time: 100 }), id: 2 }
		];
		const out = collapseRepeats(items);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ id: 0, count: 3, oldestTime: 100 });
		expect(out[0].e.time).toBe(300); // displays the newest occurrence
	});

	it('does not merge across a different line in between (a broken run)', () => {
		const items = [
			{ e: line({ time: 300 }), id: 0 },
			{ e: line({ msg: 'something else', time: 250 }), id: 1 },
			{ e: line({ time: 200 }), id: 2 }
		];
		const out = collapseRepeats(items);
		expect(out).toHaveLength(3);
		expect(out.map((r) => r.count)).toEqual([1, 1, 1]);
	});

	it('does NOT merge non-consecutive duplicates separated by something else (by design)', () => {
		const items = [
			{ e: line({ time: 300 }), id: 0 },
			{ e: line({ msg: 'unrelated', time: 250 }), id: 1 },
			{ e: line({ time: 200 }), id: 2 } // same content as id 0, but not adjacent
		];
		const out = collapseRepeats(items);
		expect(out).toHaveLength(3);
	});

	it('passes through a single non-repeated line unchanged (count 1)', () => {
		const out = collapseRepeats([{ e: line(), id: 0 }]);
		expect(out).toEqual([{ e: line(), id: 0, count: 1, oldestTime: 1000 }]);
	});

	it('handles an empty list', () => {
		expect(collapseRepeats([])).toEqual([]);
	});
});
