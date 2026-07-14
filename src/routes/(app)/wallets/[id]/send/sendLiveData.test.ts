// cairn-g1u2: _assembleSendLiveData is the SINGLE source of truth the send load
// uses whether it served a live scan or the clean-wallet snapshot fast path. These
// tests lock the money-grade invariant that the two paths are byte-for-byte
// identical for the same on-chain + DB state (the deep-equal parity test the bead
// requires), plus the coin-control mapping, own-change/received badging,
// confirmed-first sort, and immature-coinbase subtraction (cairn-oae1.3).

import { describe, it, expect } from 'vitest';
import { _assembleSendLiveData } from './+page.server';
import type { FeeEstimates } from '$lib/types';

const FEES: FeeEstimates = { fast: 20, medium: 10, slow: 3 } as unknown as FeeEstimates;

// A confirmed coin, an own-change unconfirmed coin, and an immature coinbase.
const OWN = 'cc'.repeat(32);
const STRANGER = 'dd'.repeat(32);
const CONFIRMED = 'aa'.repeat(32);
const COINBASE = 'bb'.repeat(32);
const TIP = 900_000;

/** The FULL live shape (SpendableUtxo: carries address/chain/index too). */
const liveUtxos = [
	{ txid: CONFIRMED, vout: 0, value: 400_000, height: 800_000, address: 'x', chain: 0 as const, index: 0, coinbase: false as const },
	{ txid: OWN, vout: 1, value: 150_000, height: 0, address: 'y', chain: 1 as const, index: 3, coinbase: false as const },
	{ txid: STRANGER, vout: 0, value: 90_000, height: 0, address: 'z', chain: 0 as const, index: 5, coinbase: false as const },
	{ txid: COINBASE, vout: 0, value: 500_000, height: 899_995, address: 'c', chain: 0 as const, index: 1, coinbase: true as const }
];

/** The LEAN snapshot shape (SnapshotUtxo): the exact same coins, minus the fields
 *  the send page never reads — this is what walletSync persists + serves. */
const snapshotUtxos = liveUtxos.map((u) => ({
	txid: u.txid,
	vout: u.vout,
	value: u.value,
	height: u.height,
	coinbase: u.coinbase
}));

// confirmed as Electrum reports it (full net-worth incl. the immature coinbase).
const CONFIRMED_BALANCE = 400_000 + 500_000;

describe('_assembleSendLiveData — snapshot vs live parity (cairn-g1u2)', () => {
	it('produces byte-identical SendLiveData from the lean snapshot and the full live coins', () => {
		const ownTxids = new Set([OWN.toLowerCase()]);
		const fromLive = _assembleSendLiveData({
			confirmed: CONFIRMED_BALANCE,
			rawUtxos: liveUtxos,
			tipHeight: TIP,
			fees: FEES,
			ownTxids,
			scanError: null
		});
		const fromSnapshot = _assembleSendLiveData({
			confirmed: CONFIRMED_BALANCE,
			rawUtxos: snapshotUtxos,
			tipHeight: TIP,
			fees: FEES,
			ownTxids,
			scanError: null
		});
		expect(fromSnapshot).toEqual(fromLive);
	});

	it('is deterministic (same inputs → deep-equal output)', () => {
		const args = {
			confirmed: CONFIRMED_BALANCE,
			rawUtxos: snapshotUtxos,
			tipHeight: TIP,
			fees: FEES,
			ownTxids: new Set([OWN.toLowerCase()]),
			scanError: null
		};
		expect(_assembleSendLiveData(args)).toEqual(_assembleSendLiveData(args));
	});

	it('subtracts the immature coinbase from confirmed (cairn-oae1.3) and reports it as maturingTotal', () => {
		const out = _assembleSendLiveData({
			confirmed: CONFIRMED_BALANCE,
			rawUtxos: snapshotUtxos,
			tipHeight: TIP, // coinbase at 899_995 is only 5 deep → immature
			fees: FEES,
			ownTxids: new Set([OWN.toLowerCase()]),
			scanError: null
		});
		expect(out.maturingTotal).toBe(500_000);
		expect(out.confirmed).toBe(CONFIRMED_BALANCE - 500_000);
	});

	it('badges unconfirmed coins own-change vs received from ownTxids', () => {
		const out = _assembleSendLiveData({
			confirmed: CONFIRMED_BALANCE,
			rawUtxos: snapshotUtxos,
			tipHeight: TIP,
			fees: FEES,
			ownTxids: new Set([OWN.toLowerCase()]),
			scanError: null
		});
		const own = out.utxos.find((u) => u.txid === OWN)!;
		const stranger = out.utxos.find((u) => u.txid === STRANGER)!;
		expect(own.unconfirmedTrust).toBe('own-change');
		expect(stranger.unconfirmedTrust).toBe('received');
		// Confirmed coins carry no trust tag.
		expect(out.utxos.find((u) => u.txid === CONFIRMED)!.unconfirmedTrust).toBeNull();
	});

	it('orders confirmed coins first (largest value), then unconfirmed (largest value)', () => {
		const out = _assembleSendLiveData({
			confirmed: CONFIRMED_BALANCE,
			rawUtxos: snapshotUtxos,
			tipHeight: TIP,
			fees: FEES,
			ownTxids: new Set([OWN.toLowerCase()]),
			scanError: null
		});
		// Confirmed: coinbase 500k, then confirmed 400k; unconfirmed: own 150k, stranger 90k.
		expect(out.utxos.map((u) => u.txid)).toEqual([COINBASE, CONFIRMED, OWN, STRANGER]);
	});

	it('leaves confirmed null and coins empty on a scan error (degraded state)', () => {
		const out = _assembleSendLiveData({
			confirmed: null,
			rawUtxos: [],
			tipHeight: 0,
			fees: null,
			ownTxids: new Set(),
			scanError: 'node unreachable'
		});
		expect(out.confirmed).toBeNull();
		expect(out.maturingTotal).toBe(0);
		expect(out.utxos).toEqual([]);
		expect(out.scanError).toBe('node unreachable');
	});
});
