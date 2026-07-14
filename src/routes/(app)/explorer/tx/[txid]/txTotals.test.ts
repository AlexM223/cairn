import { describe, it, expect } from 'vitest';
import { txTotalIn } from './txTotals';

// cairn-zmym — "Total in" must degrade to "—" (known:false) when any input value
// is unknown, instead of summing unknowns to a misleading 0.00 BTC.
describe('txTotalIn', () => {
	it('sums when every input value is known', () => {
		expect(txTotalIn([{ value: 100 }, { value: 250 }])).toEqual({ known: true, sats: 350 });
	});

	it('is unknown when ALL input values are unknown (mempool tx)', () => {
		// The exact cairn-zmym case: prevouts unresolved → each "—", total must be "—".
		expect(txTotalIn([{ value: null }, { value: null }])).toMatchObject({ known: false });
	});

	it('is unknown when even one input value is unknown (partial)', () => {
		// A partial sum would undercount — honest answer is still "—".
		expect(txTotalIn([{ value: 100 }, { value: null }]).known).toBe(false);
	});

	it('is unknown for an empty input list', () => {
		expect(txTotalIn([])).toEqual({ known: false, sats: 0 });
	});
});
