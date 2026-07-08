// Dedicated coverage for classifyUnconfirmedTrust (transactions.ts ~L129),
// which had zero test coverage (cairn-faot). It gates the "own-change vs
// received" trust label the send flow relies on to decide whether an
// unconfirmed coin is safe to spend automatically — this is what stands
// between a stranger's still-unconfirmed, still-replaceable transaction and
// Cairn treating its output as ordinary spendable balance.
//
// Kept in its own file (not transactions.test.ts) because the function is a
// pure, side-effect-free classifier — it needs no DB seeding or chain mocks,
// just direct unit tests over its two inputs (utxos, ownTxids).
import { describe, it, expect } from 'vitest';
import { classifyUnconfirmedTrust } from './transactions';
import type { SpendableUtxo } from './bitcoin/psbt';

const OUR_TXID = 'aa'.repeat(32);
const THEIR_TXID = 'bb'.repeat(32);

/** A minimal SpendableUtxo with sane defaults, overridable per test. */
function utxo(overrides: Partial<SpendableUtxo> = {}): SpendableUtxo {
	return {
		txid: OUR_TXID,
		vout: 0,
		value: 50_000,
		height: 0,
		address: 'bc1qexampleaddress000000000000000000000000',
		chain: 0,
		index: 0,
		...overrides
	};
}

describe('classifyUnconfirmedTrust', () => {
	it('tags an unconfirmed coin from our own broadcast tx as own-change', () => {
		const [out] = classifyUnconfirmedTrust(
			[utxo({ txid: OUR_TXID, height: 0 })],
			new Set([OUR_TXID])
		);
		expect(out.unconfirmedTrust).toBe('own-change');
	});

	it('tags an unconfirmed coin from a third party as received', () => {
		const [out] = classifyUnconfirmedTrust(
			[utxo({ txid: THEIR_TXID, height: 0 })],
			new Set([OUR_TXID]) // our own set does NOT contain their txid
		);
		expect(out.unconfirmedTrust).toBe('received');
	});

	it('defaults to received (conservative) when ownTxids is empty', () => {
		const [out] = classifyUnconfirmedTrust([utxo({ txid: OUR_TXID, height: 0 })], new Set());
		expect(out.unconfirmedTrust).toBe('received');
	});

	it('leaves a confirmed coin completely untouched, even if it is ours', () => {
		const original = utxo({ txid: OUR_TXID, height: 800_000 });
		const [out] = classifyUnconfirmedTrust([original], new Set([OUR_TXID]));
		expect(out.unconfirmedTrust).toBeUndefined();
		// "passed through untouched" per the doc comment: same reference, not a copy.
		expect(out).toBe(original);
	});

	it('height boundary: height=1 (just confirmed) is passed through untouched', () => {
		const original = utxo({ txid: OUR_TXID, height: 1 });
		const [out] = classifyUnconfirmedTrust([original], new Set([OUR_TXID]));
		expect(out.unconfirmedTrust).toBeUndefined();
		expect(out).toBe(original);
	});

	it('height boundary: height=0 is classified as unconfirmed', () => {
		const [out] = classifyUnconfirmedTrust([utxo({ txid: OUR_TXID, height: 0 })], new Set([OUR_TXID]));
		expect(out.unconfirmedTrust).toBe('own-change');
	});

	it('negative height (unconfirmed tx with an unconfirmed parent, per Electrum protocol) is classified like height 0', () => {
		// Electrum's blockchain.scripthash.listunspent reports height <= 0 for any
		// unconfirmed output; a negative height specifically signals the tx itself
		// has an unconfirmed ancestor (a chain of unconfirmed parents). The trust
		// classifier must not treat that differently from a plain height-0 coin.
		const own = classifyUnconfirmedTrust(
			[utxo({ txid: OUR_TXID, height: -1 })],
			new Set([OUR_TXID])
		);
		expect(own[0].unconfirmedTrust).toBe('own-change');

		const theirs = classifyUnconfirmedTrust(
			[utxo({ txid: THEIR_TXID, height: -1 })],
			new Set([OUR_TXID])
		);
		expect(theirs[0].unconfirmedTrust).toBe('received');
	});

	it('matches txids case-insensitively (Electrum hex casing should not affect trust)', () => {
		const [out] = classifyUnconfirmedTrust(
			[utxo({ txid: OUR_TXID.toUpperCase(), height: 0 })],
			new Set([OUR_TXID]) // ownBroadcastTxids always stores lowercase
		);
		expect(out.unconfirmedTrust).toBe('own-change');
	});

	it('does not mutate the input utxo objects for unconfirmed coins', () => {
		const original = utxo({ txid: OUR_TXID, height: 0 });
		const [out] = classifyUnconfirmedTrust([original], new Set([OUR_TXID]));
		expect(out).not.toBe(original); // a new object is returned...
		expect(original.unconfirmedTrust).toBeUndefined(); // ...the caller's copy is untouched
	});

	it('classifies a mixed batch independently, preserving order and per-coin values', () => {
		const confirmedOurs = utxo({ txid: OUR_TXID, vout: 0, height: 800_000, value: 1 });
		const unconfirmedOurs = utxo({ txid: OUR_TXID, vout: 1, height: 0, value: 2 });
		const unconfirmedTheirs = utxo({ txid: THEIR_TXID, vout: 0, height: 0, value: 3 });
		const unconfirmedChainedTheirs = utxo({ txid: THEIR_TXID, vout: 1, height: -1, value: 4 });

		const out = classifyUnconfirmedTrust(
			[confirmedOurs, unconfirmedOurs, unconfirmedTheirs, unconfirmedChainedTheirs],
			new Set([OUR_TXID])
		);

		expect(out.map((u) => u.unconfirmedTrust)).toEqual([
			undefined,
			'own-change',
			'received',
			'received'
		]);
		// Order and identity of unrelated fields must be preserved.
		expect(out.map((u) => u.value)).toEqual([1, 2, 3, 4]);
	});

	it('is driven purely by tx ownership, not by any RBF signal — trust is not "RBF-signaled or not"', () => {
		// classifyUnconfirmedTrust's only inputs are (utxos, ownTxids); it has no
		// notion of whether the funding tx signals BIP-125 replaceability. That
		// live-replaceability check is a *separate* concern handled elsewhere
		// (detectUnconfirmedInflows, for the "speed up" RBF-vs-CPFP decision).
		// A third party's unconfirmed coin is always 'received' here regardless
		// of RBF signaling, and our own unconfirmed change is always
		// 'own-change' regardless of RBF signaling.
		const theirs = classifyUnconfirmedTrust(
			[utxo({ txid: THEIR_TXID, height: 0 })],
			new Set([OUR_TXID])
		);
		expect(theirs[0].unconfirmedTrust).toBe('received');

		const ours = classifyUnconfirmedTrust(
			[utxo({ txid: OUR_TXID, height: 0 })],
			new Set([OUR_TXID])
		);
		expect(ours[0].unconfirmedTrust).toBe('own-change');
	});

	it('returns an empty array for an empty utxo set', () => {
		expect(classifyUnconfirmedTrust([], new Set([OUR_TXID]))).toEqual([]);
	});
});
