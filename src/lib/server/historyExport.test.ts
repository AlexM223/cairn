import { describe, it, expect } from 'vitest';
import { buildHistoryCsv, historyCsvFilename, type HistoryRow } from './historyExport';
import type { TxDetail } from '$lib/types';

// A TxDetail stub carrying only the fields the counterparty logic reads.
function tx(partial: Partial<TxDetail> & Pick<TxDetail, 'txid'>): TxDetail {
	return {
		confirmed: true,
		blockHeight: null,
		blockHash: null,
		blockTime: null,
		confirmations: 0,
		size: 0,
		vsize: 0,
		weight: 0,
		fee: null,
		feeRate: null,
		locktime: 0,
		version: 2,
		segwit: true,
		rbf: false,
		vin: [],
		vout: [],
		...partial
	} as TxDetail;
}

const OWN = 'bc1qown0000000000000000000000000000000owna';
const OWN_CHANGE = 'bc1qown1111111111111111111111111111111ownb';
const PAYEE = 'bc1qpayee2222222222222222222222222222payee';
const PAYER = 'bc1qpayer3333333333333333333333333333payer';

function rows(...r: HistoryRow[]): HistoryRow[] {
	return r;
}

describe('buildHistoryCsv', () => {
	it('emits the fixed header and one CRLF-terminated row per tx', async () => {
		const csv = await buildHistoryCsv({
			rows: rows({ txid: 'a'.repeat(64), height: 800000, time: 1_700_000_000, delta: 50000, fee: 200 }),
			ownedAddresses: [OWN],
			tipHeight: 800005,
			getTx: async () => tx({ txid: 'a'.repeat(64), vin: [{ ...vinFrom(PAYER) }], vout: [voutTo(OWN, 50000)] })
		});
		const lines = csv.trimEnd().split('\r\n');
		expect(lines[0]).toBe(
			'Date,Type,Amount (BTC),Amount (sats),Fee (sats),TxID,Confirmations,Counterparty Address'
		);
		expect(lines).toHaveLength(2);
		expect(csv.endsWith('\r\n')).toBe(true);
	});

	it('classifies a received tx and reports the payer, BTC/sats, and confirmations', async () => {
		const csv = await buildHistoryCsv({
			rows: rows({ txid: 'r'.repeat(64), height: 800000, time: 1_700_000_000, delta: 12345678, fee: 500 }),
			ownedAddresses: [OWN],
			tipHeight: 800010,
			getTx: async () => tx({ txid: 'r'.repeat(64), vin: [vinFrom(PAYER)], vout: [voutTo(OWN, 12345678)] })
		});
		const [, row] = csv.trimEnd().split('\r\n');
		const cols = row.split(',');
		expect(cols[1]).toBe('Received');
		expect(cols[2]).toBe('0.12345678'); // signed BTC, 8dp, no grouping
		expect(cols[3]).toBe('12345678');
		expect(cols[4]).toBe('500');
		expect(cols[6]).toBe('11'); // 800010 - 800000 + 1
		expect(cols[7]).toBe(PAYER);
	});

	it('classifies a sent tx and reports the external payee (skipping own change)', async () => {
		const csv = await buildHistoryCsv({
			rows: rows({ txid: 's'.repeat(64), height: 0, time: null, delta: -30200, fee: 200 }),
			ownedAddresses: [OWN, OWN_CHANGE],
			tipHeight: 800010,
			getTx: async () =>
				tx({ txid: 's'.repeat(64), vin: [vinFrom(OWN)], vout: [voutTo(PAYEE, 30000), voutTo(OWN_CHANGE, 9800)] })
		});
		const [, row] = csv.trimEnd().split('\r\n');
		const cols = row.split(',');
		expect(cols[0]).toBe('Pending'); // no time
		expect(cols[1]).toBe('Sent');
		expect(cols[2]).toBe('-0.00030200'); // negative delta preserved
		expect(cols[6]).toBe('0'); // unconfirmed → 0 confirmations
		expect(cols[7]).toBe(PAYEE);
	});

	it('leaves the counterparty blank when the detail fetch fails, without dropping the row', async () => {
		const csv = await buildHistoryCsv({
			rows: rows({ txid: 'f'.repeat(64), height: 799999, time: 1_700_000_000, delta: 1000, fee: null }),
			ownedAddresses: [OWN],
			tipHeight: 800000,
			getTx: async () => {
				throw new Error('backend down');
			}
		});
		const [, row] = csv.trimEnd().split('\r\n');
		const cols = row.split(',');
		expect(cols[4]).toBe(''); // fee null → empty
		expect(cols[6]).toBe('2'); // confirmations still derived from tip/height
		expect(cols[7]).toBe(''); // counterparty blank, row kept
	});

	it('quotes fields containing commas or quotes (RFC 4180)', async () => {
		// Addresses never contain commas, but a defensive check on the escaper.
		const csv = await buildHistoryCsv({
			rows: rows({ txid: 'q'.repeat(64), height: 800000, time: 1_700_000_000, delta: -1, fee: 1 }),
			ownedAddresses: [OWN],
			tipHeight: 800000,
			getTx: async () => tx({ txid: 'q'.repeat(64), vout: [voutTo('weird,addr"x', 1)] })
		});
		expect(csv).toContain('"weird,addr""x"');
	});
});

describe('historyCsvFilename', () => {
	it('slugifies the wallet name and stamps the date', () => {
		expect(historyCsvFilename('Cold Storage', '2026-07-05')).toBe(
			'cairn-cold-storage-history-2026-07-05.csv'
		);
	});

	it('falls back to "wallet" when the name has no usable characters', () => {
		expect(historyCsvFilename('  —  ', '2026-07-05')).toBe('cairn-wallet-history-2026-07-05.csv');
	});
});

// --- helpers for building vin/vout stubs ---
function voutTo(address: string | null, value: number): TxDetail['vout'][number] {
	return { address, value, scriptType: 'v0_p2wpkh', scriptPubKey: '', spent: null };
}
function vinFrom(address: string | null): TxDetail['vin'][number] {
	return {
		txid: '00'.repeat(32),
		vout: 0,
		address,
		value: 0,
		coinbase: false,
		scriptSig: null,
		witness: null
	};
}
