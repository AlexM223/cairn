// CPFP fee-math + builder coverage (cairn-u9ob.3). The pure fee formula is
// tested directly; buildCpfpDraft is exercised end-to-end with the chain and
// wallet scan mocked at the network edge (same shape as transactions.test.ts).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Transaction, NETWORK } from '@scure/btc-signer';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';

const { getTxMock, getTxHexMock, listUnspentMock, scanWalletMock, findNextUnusedIndexMock } =
	vi.hoisted(() => ({
		getTxMock: vi.fn(),
		getTxHexMock: vi.fn(),
		listUnspentMock: vi.fn(),
		scanWalletMock: vi.fn(),
		findNextUnusedIndexMock: vi.fn()
	}));

vi.mock('./chain', () => ({
	getChain: () => ({
		getTx: getTxMock,
		getTxHex: getTxHexMock,
		electrum: {
			listUnspent: listUnspentMock,
			// getWalletUtxos now batches listunspent through batchRequest (task 4);
			// dispatch each sub-request to the same per-scripthash listUnspent mock.
			batchRequest: (items: { method: string; params: unknown[] }[]) =>
				Promise.all(items.map((it) => listUnspentMock(it.params[0])))
		}
	})
}));

vi.mock('./bitcoin/walletScan', async (orig) => {
	const actual = await orig<typeof import('./bitcoin/walletScan')>();
	return { ...actual, scanWallet: scanWalletMock, findNextUnusedIndex: findNextUnusedIndexMock };
});

import {
	buildCpfpDraft,
	cpfpChildFee,
	CpfpError,
	detectUnconfirmedInflows
} from './transactions';
import { estimateTxVsize, type SpendableUtxo } from './bitcoin/psbt';

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const RECEIVE_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // m/0/0
const CHANGE_0 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'; // m/1/0

/** A funding tx paying RECEIVE_0, with its REAL txid (the stuck parent). */
function fundingTx(value: number): { hex: string; txid: string } {
	const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
	tx.addInput({ txid: '00'.repeat(32), index: 0 });
	tx.addOutputAddress(RECEIVE_0, BigInt(value), NETWORK);
	return { hex: tx.hex, txid: tx.id };
}

/**
 * A coinbase-SHAPED funding tx: single input with the consensus synthetic
 * prevout (32 zero bytes, index 0xffffffff) that annotateCoinbase (coinbaseScan.ts)
 * detects from raw bytes alone, independent of confirmation height. Used only to
 * drive the cairn-oae1.5 defensive CPFP guard — a real coinbase output is never
 * actually unconfirmed, but the guard must still catch it structurally.
 */
function coinbaseFundingTx(value: number): { hex: string; txid: string } {
	const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
	tx.addInput({ txid: '00'.repeat(32), index: 0xffffffff });
	tx.addOutputAddress(RECEIVE_0, BigInt(value), NETWORK);
	return { hex: tx.hex, txid: tx.id };
}

function wipe(): void {
	db.exec(
		'DELETE FROM transactions; DELETE FROM sessions; DELETE FROM wallets; DELETE FROM users; DELETE FROM settings;'
	);
}

async function seedWallet(): Promise<{ userId: number; walletId: number }> {
	setSetting('registration_mode', 'open');
	const user = await registerUser({ email: 'a@example.com', password: 'correct horse battery', displayName: 'u' });
	const res = db
		.prepare(
			"INSERT INTO wallets (user_id, name, type, xpub, script_type, master_fingerprint, derivation_path) VALUES (?, 'W', 'xpub', ?, 'p2wpkh', '73c5da0a', ?)"
		)
		.run(user.id, ZPUB, "m/84'/0'/0'");
	return { userId: user.id, walletId: Number(res.lastInsertRowid) };
}

/** Point the mocked scan/chain at a single unconfirmed output on `parent`. */
function stubUnconfirmedOutputOn(parent: { hex: string; txid: string }, value: number): void {
	scanWalletMock.mockResolvedValue({
		addresses: [{ address: RECEIVE_0, index: 0, change: false, used: true, balance: value }]
	});
	listUnspentMock.mockResolvedValue([{ tx_hash: parent.txid, tx_pos: 0, value, height: 0 }]);
	findNextUnusedIndexMock.mockResolvedValue(0);
	getTxHexMock.mockResolvedValue(parent.hex);
}

beforeEach(() => {
	wipe();
	getTxMock.mockReset();
	getTxHexMock.mockReset();
	listUnspentMock.mockReset();
	scanWalletMock.mockReset();
	findNextUnusedIndexMock.mockReset();
});

describe('cpfpChildFee (fee math §3)', () => {
	it('makes the package average the target rate', () => {
		// parent: 200 vB @ 200 sat (1 sat/vB); child: 110 vB; target 10 sat/vB.
		const fee = cpfpChildFee(10, 200, 200, 110);
		expect(fee).toBe(2900); // ceil(10*310) - 200
		// The package now averages exactly the target.
		expect((200 + fee) / (200 + 110)).toBeCloseTo(10, 5);
	});

	it('floors the child to its own 1 sat/vB relay minimum', () => {
		// Parent already almost meets the target — the raw formula returns a tiny
		// number, so the child is floored to cover its own size at 1 sat/vB.
		// raw = ceil(2*(200+110)) - parentFee = 620 - parentFee.
		expect(cpfpChildFee(2, 200, 380, 110)).toBe(240); // 620-380, above the 110 floor
		expect(cpfpChildFee(2, 200, 500, 110)).toBe(120); // 620-500, still above floor
		expect(cpfpChildFee(2, 200, 700, 110)).toBe(110); // 620-700=-80 → floored to 110
	});
});

describe('estimateTxVsize', () => {
	it('matches the coin selector tables (overhead + inputs + outputs)', () => {
		// p2wpkh: 11 overhead + 68/input + 31 per p2wpkh output.
		expect(estimateTxVsize('p2wpkh', 1, [CHANGE_0])).toBe(110);
		expect(estimateTxVsize('p2wpkh', 2, [CHANGE_0])).toBe(178);
	});
});

describe('detectUnconfirmedInflows (stuck-tx detection §4, cairn-u9ob.2)', () => {
	const coin = (txid: string, vout: number, height: number): SpendableUtxo => ({
		txid,
		vout,
		value: 50_000,
		height,
		address: RECEIVE_0,
		chain: 0,
		index: 0
	});

	it('routes our own RBF-signaling tx to RBF and a received tx to CPFP', async () => {
		const OURS = 'aa'.repeat(32);
		const THEIRS = 'bb'.repeat(32);
		getTxMock.mockImplementation(async (txid: string) => ({
			confirmed: false,
			rbf: true, // both signal RBF
			vsize: 200,
			fee: 200
		}));

		const inflows = await detectUnconfirmedInflows(
			[coin(OURS, 0, 0), coin(THEIRS, 1, 0)],
			new Set([OURS]) // we broadcast OURS, not THEIRS
		);

		const ours = inflows.find((i) => i.txid === OURS)!;
		const theirs = inflows.find((i) => i.txid === THEIRS)!;
		expect(ours.action).toBe('rbf'); // ours + signals RBF → replace it
		expect(ours.trust).toBe('own-change');
		expect(theirs.action).toBe('cpfp'); // not ours → can only child-pay
		expect(theirs.trust).toBe('received');
	});

	it('routes our own tx that no longer signals RBF to CPFP', async () => {
		const OURS = 'cc'.repeat(32);
		getTxMock.mockResolvedValue({ confirmed: false, rbf: false, vsize: 200, fee: 200 });
		const [inflow] = await detectUnconfirmedInflows([coin(OURS, 0, 0)], new Set([OURS]));
		expect(inflow.action).toBe('cpfp');
		expect(inflow.signalsRbf).toBe(false);
	});

	it('ignores confirmed coins and drops a tx that has since confirmed', async () => {
		const UNCONF = 'dd'.repeat(32);
		const CONF = 'ee'.repeat(32);
		const RACED = 'ff'.repeat(32);
		getTxMock.mockImplementation(async (txid: string) => ({
			confirmed: txid === RACED, // RACED confirmed out from under us
			rbf: true,
			vsize: 200,
			fee: 200
		}));
		const inflows = await detectUnconfirmedInflows(
			[coin(UNCONF, 0, 0), coin(CONF, 0, 800_000), coin(RACED, 0, 0)],
			new Set([UNCONF, RACED])
		);
		expect(inflows.map((i) => i.txid)).toEqual([UNCONF]); // CONF confirmed, RACED raced
	});

	it('aggregates several of our outputs on one tx and defaults RBF on lookup failure', async () => {
		const OURS = '11'.repeat(32);
		getTxMock.mockRejectedValue(new Error('backend down'));
		const [inflow] = await detectUnconfirmedInflows(
			[coin(OURS, 0, 0), coin(OURS, 2, 0)],
			new Set([OURS])
		);
		expect(inflow.ourValueSats).toBe(100_000); // 50k + 50k
		expect(inflow.vouts).toEqual([0, 2]);
		// Cairn always sets RBF_SEQUENCE on its own txs, so an unreachable backend
		// defaults our own tx to RBF-capable rather than the costlier CPFP.
		expect(inflow.action).toBe('rbf');
	});
});

describe('buildCpfpDraft', () => {
	it('forces the stuck output as input and prices the package at the target rate', async () => {
		const { userId, walletId } = await seedWallet();
		const PARENT = fundingTx(100_000);
		stubUnconfirmedOutputOn(PARENT, 100_000);
		// buildCpfpDraft looks the parent up for its real vsize + fee.
		getTxMock.mockResolvedValue({ vin: [{}], confirmed: false, vsize: 200, fee: 200 });

		const { draft, details, cpfp } = await buildCpfpDraft(userId, walletId, PARENT.txid, 10);

		// The child spends exactly the qualifying unconfirmed output.
		expect(details.inputs).toHaveLength(1);
		expect(details.inputs[0].txid).toBe(PARENT.txid);
		// child_fee = ceil(10*(200+110)) - 200 = 2900; the swept tx pays it.
		expect(cpfp.childFee).toBe(2900);
		expect(details.fee).toBe(2900);
		// Package (parent + child) averages the 10 sat/vB target.
		expect((cpfp.parentFee + details.fee) / (cpfp.parentVsize + details.vsize)).toBeCloseTo(10, 1);
		// Persisted as a fresh draft (no replaces_txid — CPFP is not a replacement).
		const row = db.prepare('SELECT replaces_txid FROM transactions WHERE id = ?').get(draft.id) as {
			replaces_txid: string | null;
		};
		expect(row.replaces_txid ?? null).toBeNull();
	});

	it('refuses when the parent already meets the target (CPFP not needed)', async () => {
		const { userId, walletId } = await seedWallet();
		const PARENT = fundingTx(100_000);
		stubUnconfirmedOutputOn(PARENT, 100_000);
		// Parent pays 2000 over 200 vB = 10 sat/vB; target 5 needs nothing extra.
		getTxMock.mockResolvedValue({ vin: [{}], confirmed: false, vsize: 200, fee: 2000 });

		await expect(buildCpfpDraft(userId, walletId, PARENT.txid, 5)).rejects.toMatchObject({
			code: 'not_needed'
		});
	});

	it('refuses when the unconfirmed coin is too small to pay the CPFP fee', async () => {
		const { userId, walletId } = await seedWallet();
		const PARENT = fundingTx(1_000); // tiny output
		stubUnconfirmedOutputOn(PARENT, 1_000);
		getTxMock.mockResolvedValue({ vin: [{}], confirmed: false, vsize: 500, fee: 200 });

		await expect(buildCpfpDraft(userId, walletId, PARENT.txid, 50)).rejects.toMatchObject({
			code: 'coin_too_small'
		});
	});

	it('refuses when the wallet has no unconfirmed output on that transaction', async () => {
		const { userId, walletId } = await seedWallet();
		const PARENT = fundingTx(100_000);
		// The only coin is CONFIRMED (height > 0) — nothing to CPFP.
		scanWalletMock.mockResolvedValue({
			addresses: [{ address: RECEIVE_0, index: 0, change: false, used: true, balance: 100_000 }]
		});
		listUnspentMock.mockResolvedValue([
			{ tx_hash: PARENT.txid, tx_pos: 0, value: 100_000, height: 800_000 }
		]);
		findNextUnusedIndexMock.mockResolvedValue(0);
		getTxMock.mockResolvedValue({ vin: [{}], confirmed: false, vsize: 200, fee: 200 });

		await expect(buildCpfpDraft(userId, walletId, PARENT.txid, 10)).rejects.toBeInstanceOf(CpfpError);
		await expect(buildCpfpDraft(userId, walletId, PARENT.txid, 10)).rejects.toMatchObject({
			code: 'no_unconfirmed_output'
		});
	});

	it('refuses to CPFP an already-confirmed parent', async () => {
		const { userId, walletId } = await seedWallet();
		const PARENT = fundingTx(100_000);
		stubUnconfirmedOutputOn(PARENT, 100_000);
		getTxMock.mockResolvedValue({ vin: [{}], confirmed: true, vsize: 200, fee: 200 });

		await expect(buildCpfpDraft(userId, walletId, PARENT.txid, 10)).rejects.toMatchObject({
			code: 'already_confirmed'
		});
	});

	// cairn-oae1.5: defense-in-depth — CPFP is safe today only because a
	// coinbase output can never be unconfirmed (implicit invariant). Force that
	// invariant to break (a coinbase-shaped parent reported unconfirmed by the
	// scan) and confirm the explicit guard in executeCpfpDraft (feeBump.ts)
	// catches it rather than silently sweeping an unverified mining reward.
	it('never lets a coinbase-flagged coin qualify as a CPFP input, even if reported unconfirmed', async () => {
		const { userId, walletId } = await seedWallet();
		const PARENT = coinbaseFundingTx(100_000);
		stubUnconfirmedOutputOn(PARENT, 100_000); // height 0 — should be structurally impossible for a real coinbase
		getTxMock.mockResolvedValue({ vin: [{}], confirmed: false, vsize: 200, fee: 200 });

		await expect(buildCpfpDraft(userId, walletId, PARENT.txid, 10)).rejects.toThrow(
			/internal invariant violated/i
		);
	});
});
