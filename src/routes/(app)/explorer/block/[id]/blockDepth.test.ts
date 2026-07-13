import { describe, it, expect } from 'vitest';
import {
	computeValueFlow,
	classifyPassage,
	largestPassages,
	passageValue,
	WHALE_SATS,
	CONSOLIDATION_MIN_VIN,
	BATCH_MIN_VOUT
} from './blockDepth';
import type { TxDetail, TxVin, TxVout } from '$lib/types';

function vin(over: Partial<TxVin> = {}): TxVin {
	return {
		txid: 'a'.repeat(64),
		vout: 0,
		address: 'bc1qsource',
		value: 1000,
		prevScriptPubKey: null,
		coinbase: false,
		scriptSig: null,
		witness: null,
		...over
	};
}

function vout(value: number, over: Partial<TxVout> = {}): TxVout {
	return { address: 'bc1qdest', value, scriptType: 'p2wpkh', scriptPubKey: '00', spent: null, ...over };
}

function tx(over: Partial<TxDetail> & { txid: string }): TxDetail {
	return {
		confirmed: true,
		blockHeight: 800_000,
		blockHash: 'h',
		blockTime: 1_700_000_000,
		confirmations: 1,
		size: 200,
		vsize: 140,
		weight: 560,
		fee: 200,
		feeRate: 1.4,
		locktime: 0,
		version: 2,
		segwit: true,
		rbf: false,
		vin: [vin()],
		vout: [vout(1000)],
		...over
	};
}

describe('computeValueFlow', () => {
	it('splits total_out / subsidy / fees into non-overlapping segments that sum to total', () => {
		const flow = computeValueFlow(5_00000000, 25000, 3_12500000);
		expect(flow).not.toBeNull();
		expect(flow!.transferred).toBe(5_00000000);
		expect(flow!.subsidy).toBe(3_12500000);
		expect(flow!.fees).toBe(25000);
		expect(flow!.total).toBe(5_00000000 + 3_12500000 + 25000);
		const sum = flow!.segments.reduce((s, seg) => s + seg.sats, 0);
		expect(sum).toBe(flow!.total);
		const fractionSum = flow!.segments.reduce((s, seg) => s + seg.fraction, 0);
		expect(fractionSum).toBeCloseTo(1, 10);
	});

	it('carries the three segments in a stable order (transferred, subsidy, fees)', () => {
		const flow = computeValueFlow(1000, 500, 250);
		expect(flow!.segments.map((s) => s.key)).toEqual(['transferred', 'subsidy', 'fees']);
	});

	it('degrades to null when total_out is unknown (Electrum-only baseline)', () => {
		expect(computeValueFlow(null, 25000, 3_12500000)).toBeNull();
	});

	it('degrades to null when fees are unknown', () => {
		expect(computeValueFlow(5_00000000, null, 3_12500000)).toBeNull();
	});

	it('still renders a bar for an empty block (only subsidy moving)', () => {
		const flow = computeValueFlow(0, 0, 3_12500000);
		expect(flow).not.toBeNull();
		expect(flow!.total).toBe(3_12500000);
		expect(flow!.segments.find((s) => s.key === 'subsidy')!.fraction).toBe(1);
		expect(flow!.segments.find((s) => s.key === 'transferred')!.fraction).toBe(0);
	});

	it('clamps negative inputs to zero rather than producing a negative segment', () => {
		const flow = computeValueFlow(-5, -5, 100);
		expect(flow!.transferred).toBe(0);
		expect(flow!.fees).toBe(0);
		expect(flow!.total).toBe(100);
	});

	it('returns null when every quantity is zero (no meaningful bar)', () => {
		expect(computeValueFlow(0, 0, 0)).toBeNull();
	});
});

describe('classifyPassage', () => {
	it('flags a coinbase transaction first, regardless of shape or value', () => {
		const cb = tx({
			txid: 'c'.repeat(64),
			vin: [vin({ coinbase: true, txid: null, vout: null, address: null, value: null })],
			vout: [vout(WHALE_SATS)]
		});
		expect(classifyPassage(cb)).toBe('coinbase');
	});

	it('flags a consolidation (many inputs → ≤2 outputs)', () => {
		const t = tx({
			txid: '1'.repeat(64),
			vin: Array.from({ length: CONSOLIDATION_MIN_VIN }, () => vin()),
			vout: [vout(50_000)]
		});
		expect(classifyPassage(t)).toBe('consolidation');
	});

	it('flags a batch payout (≤3 inputs → many outputs)', () => {
		const t = tx({
			txid: '2'.repeat(64),
			vin: [vin()],
			vout: Array.from({ length: BATCH_MIN_VOUT }, () => vout(1000))
		});
		expect(classifyPassage(t)).toBe('batch');
	});

	it('prefers the structural consolidation tag over whale even at whale value', () => {
		const t = tx({
			txid: '3'.repeat(64),
			vin: Array.from({ length: CONSOLIDATION_MIN_VIN }, () => vin()),
			vout: [vout(WHALE_SATS)]
		});
		expect(classifyPassage(t)).toBe('consolidation');
	});

	it('flags a whale by value when the shape is an ordinary payment', () => {
		const t = tx({ txid: '4'.repeat(64), vin: [vin()], vout: [vout(WHALE_SATS), vout(1000)] });
		expect(classifyPassage(t)).toBe('whale');
	});

	it('falls back to payment for an ordinary small transaction', () => {
		const t = tx({ txid: '5'.repeat(64), vin: [vin()], vout: [vout(1000), vout(500)] });
		expect(classifyPassage(t)).toBe('payment');
	});
});

describe('largestPassages', () => {
	it('sorts by total output value, descending, and honors the limit', () => {
		const txs = [
			tx({ txid: 'a'.repeat(64), vout: [vout(1000)] }),
			tx({ txid: 'b'.repeat(64), vout: [vout(9000)] }),
			tx({ txid: 'c'.repeat(64), vout: [vout(5000)] })
		];
		const top = largestPassages(txs, 2);
		expect(top.map((p) => p.txid)).toEqual(['b'.repeat(64), 'c'.repeat(64)]);
		expect(top[0].value).toBe(9000);
	});

	it('breaks value ties by the busier transaction, then txid', () => {
		const txs = [
			tx({ txid: 'b'.repeat(64), vin: [vin()], vout: [vout(1000)] }),
			tx({ txid: 'a'.repeat(64), vin: [vin(), vin()], vout: [vout(500), vout(500)] })
		];
		// Both total 1000; the 4-io tx (txid 'a…') is busier and ranks first.
		expect(largestPassages(txs).map((p) => p.txid)).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
	});

	it('tags each returned passage', () => {
		const txs = [tx({ txid: 'd'.repeat(64), vout: [vout(WHALE_SATS)] })];
		expect(largestPassages(txs)[0].tag).toBe('whale');
	});

	it('returns [] for an empty page without throwing', () => {
		expect(largestPassages([])).toEqual([]);
	});
});

describe('passageValue', () => {
	it('sums output values', () => {
		expect(passageValue(tx({ txid: 'e'.repeat(64), vout: [vout(100), vout(250), vout(50)] }))).toBe(400);
	});
});
