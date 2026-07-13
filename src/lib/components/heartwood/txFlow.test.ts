import { describe, it, expect } from 'vitest';
import { computeTxFlow, computeFeePosition, MAX_FLOW_BANDS } from './txFlow';
import type { TxDetail, TxVin, TxVout } from '$lib/types';

function vin(over: Partial<TxVin> = {}): TxVin {
	return {
		txid: 'a'.repeat(64),
		vout: 0,
		address: 'bc1qinput',
		value: 100_000,
		prevScriptPubKey: null,
		coinbase: false,
		scriptSig: null,
		witness: null,
		...over
	};
}

function vout(over: Partial<TxVout> = {}): TxVout {
	return {
		address: 'bc1qoutput',
		value: 90_000,
		scriptType: 'witness_v0_keyhash',
		scriptPubKey: '00',
		spent: null,
		...over
	};
}

function tx(over: Partial<TxDetail> = {}): TxDetail {
	return {
		txid: 'f'.repeat(64),
		confirmed: true,
		blockHeight: 800_000,
		blockHash: 'b'.repeat(64),
		blockTime: 1_700_000_000,
		confirmations: 3,
		size: 200,
		vsize: 140,
		weight: 560,
		fee: 10_000,
		feeRate: 71.4,
		locktime: 0,
		version: 2,
		segwit: true,
		rbf: false,
		vin: [vin()],
		vout: [vout()],
		...over
	};
}

describe('computeTxFlow — normal transaction', () => {
	it('splits value into inputs + outputs + fee summing to the side total', () => {
		const flow = computeTxFlow(
			tx({ vin: [vin({ value: 100_000 })], vout: [vout({ value: 90_000 })], fee: 10_000 })
		)!;
		expect(flow).not.toBeNull();
		expect(flow.coinbase).toBe(false);
		expect(flow.inputTotal).toBe(100_000);
		expect(flow.outputTotal).toBe(90_000);
		expect(flow.feeValue).toBe(10_000);
		expect(flow.sideTotal).toBe(100_000);

		// Left column sums to 1; right column (outputs + fee) also sums to 1.
		const inSum = flow.inputs.reduce((s, b) => s + b.pct, 0);
		const outSum = flow.outputs.reduce((s, b) => s + b.pct, 0) + flow.feePct;
		expect(inSum).toBeCloseTo(1, 6);
		expect(outSum).toBeCloseTo(1, 6);
		expect(flow.fee?.pct).toBeCloseTo(0.1, 6);
	});

	it('derives the fee from inputs − outputs (geometry stays exact even if reported fee drifts)', () => {
		const flow = computeTxFlow(
			tx({ vin: [vin({ value: 100_000 })], vout: [vout({ value: 90_000 })], fee: 9_999 })
		)!;
		// Derived (10_000), not the slightly-off reported 9_999.
		expect(flow.feeValue).toBe(10_000);
	});

	it('marks an output paying an input address as change', () => {
		const flow = computeTxFlow(
			tx({
				vin: [vin({ address: 'bc1qalice', value: 100_000 })],
				vout: [
					vout({ address: 'bc1qbob', value: 60_000 }),
					vout({ address: 'bc1qalice', value: 30_000 })
				],
				fee: 10_000
			})
		)!;
		const change = flow.outputs.find((b) => b.address === 'bc1qalice');
		const payment = flow.outputs.find((b) => b.address === 'bc1qbob');
		expect(change?.isChange).toBe(true);
		expect(payment?.isChange).toBe(false);
	});

	it('flags viewer-owned addresses as yours on both sides', () => {
		const flow = computeTxFlow(
			tx({
				vin: [vin({ address: 'bc1qmine', value: 100_000 })],
				vout: [vout({ address: 'bc1qtheirs', value: 90_000 })],
				fee: 10_000
			}),
			{ yours: new Set(['bc1qmine']) }
		)!;
		expect(flow.inputs[0].isYours).toBe(true);
		expect(flow.outputs[0].isYours).toBe(false);
	});

	it('no fee band when there is no fee', () => {
		const flow = computeTxFlow(
			tx({ vin: [vin({ value: 90_000 })], vout: [vout({ value: 90_000 })], fee: 0 })
		)!;
		expect(flow.fee).toBeNull();
		expect(flow.feePct).toBe(0);
	});
});

describe('computeTxFlow — honesty / degradation', () => {
	it('returns null when any input value is unknown (never fakes proportions)', () => {
		const flow = computeTxFlow(
			tx({ vin: [vin({ value: null }), vin({ value: 50_000 })], vout: [vout({ value: 90_000 })] })
		);
		expect(flow).toBeNull();
	});

	it('returns null on a non-positive total', () => {
		const flow = computeTxFlow(
			tx({ vin: [vin({ value: 0 })], vout: [vout({ value: 0, scriptType: 'op_return' })] })
		);
		expect(flow).toBeNull();
	});

	it('handles a data (OP_RETURN-only, zero-value) output — everything is fee', () => {
		const flow = computeTxFlow(
			tx({
				vin: [vin({ value: 5_000 })],
				vout: [vout({ value: 0, address: null, scriptType: 'op_return' })],
				fee: 5_000
			})
		)!;
		expect(flow.outputTotal).toBe(0);
		expect(flow.feeValue).toBe(5_000);
		expect(flow.feePct).toBeCloseTo(1, 6);
	});
});

describe('computeTxFlow — coinbase', () => {
	it('renders a single New-coins source and no fee band', () => {
		const flow = computeTxFlow(
			tx({
				vin: [vin({ coinbase: true, txid: null, vout: null, address: null, value: null })],
				vout: [vout({ address: 'bc1qminer', value: 625_000_000 })],
				fee: null
			})
		)!;
		expect(flow.coinbase).toBe(true);
		expect(flow.inputs).toHaveLength(1);
		expect(flow.inputs[0].isCoinbaseSource).toBe(true);
		expect(flow.inputs[0].pct).toBe(1);
		expect(flow.fee).toBeNull();
		expect(flow.sideTotal).toBe(625_000_000);
	});
});

describe('computeTxFlow — many-in / many-out capping', () => {
	it('caps each side and folds the tail into an honest +N more band', () => {
		const manyIn = Array.from({ length: 20 }, (_, i) => vin({ address: `in${i}`, value: 1_000 }));
		const manyOut = Array.from({ length: 20 }, (_, i) =>
			vout({ address: `out${i}`, value: 900 })
		);
		const flow = computeTxFlow(tx({ vin: manyIn, vout: manyOut, fee: 2_000 }), { maxBands: 6 })!;

		expect(flow.inputs).toHaveLength(6); // 5 largest + 1 "more"
		expect(flow.outputs).toHaveLength(6);
		const moreIn = flow.inputs.find((b) => b.kind === 'more')!;
		expect(moreIn.count).toBe(20 - 5);
		expect(flow.inputsMore).toBe(15);

		// Proportions still sum to the whole (no value invented or dropped).
		const inSum = flow.inputs.reduce((s, b) => s + b.pct, 0);
		expect(inSum).toBeCloseTo(1, 6);
		const moreValue = flow.inputs.find((b) => b.kind === 'more')!.value;
		expect(moreValue).toBe(15 * 1_000);
	});

	it('does not cap when exactly at the limit', () => {
		const ins = Array.from({ length: MAX_FLOW_BANDS }, (_, i) => vin({ address: `in${i}`, value: 1_000 }));
		const flow = computeTxFlow(
			tx({ vin: ins, vout: [vout({ value: MAX_FLOW_BANDS * 1_000 - 500 })], fee: 500 })
		)!;
		expect(flow.inputs).toHaveLength(MAX_FLOW_BANDS);
		expect(flow.inputs.every((b) => b.kind === 'input')).toBe(true);
		expect(flow.inputsMore).toBe(0);
	});
});

describe('computeFeePosition', () => {
	const hist: [number, number][] = [
		[100, 500_000],
		[50, 1_000_000],
		[10, 2_000_000]
	];

	it('returns null when the histogram is absent or the fee rate is unknown', () => {
		expect(computeFeePosition(50, null)).toBeNull();
		expect(computeFeePosition(50, [])).toBeNull();
		expect(computeFeePosition(null, hist)).toBeNull();
	});

	it('computes the fraction of pending vsize ahead and a clamped marker position', () => {
		const p = computeFeePosition(50, hist)!;
		expect(p.min).toBe(10);
		expect(p.max).toBe(100);
		// Only the 100 sat/vB bucket (500k of 3.5M) pays strictly more.
		expect(p.ahead).toBeCloseTo(500_000 / 3_500_000, 6);
		expect(p.pos).toBeCloseTo((50 - 10) / (100 - 10), 6);
	});

	it('centers the marker when every bucket shares one rate', () => {
		const p = computeFeePosition(20, [[20, 1_000_000]])!;
		expect(p.pos).toBe(0.5);
		expect(p.ahead).toBe(0);
	});
});
