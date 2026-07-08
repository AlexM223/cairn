// Pins the BIP-125 RBF-signaling boundary in feeBump.ts (bead cairn-o6pn).
//
// Per BIP-125 / Bitcoin Core policy/rbf.cpp SignalsOptInRBF (which uses
// MAX_BIP125_RBF_SEQUENCE = 0xfffffffd), a transaction signals opt-in RBF
// iff at least one input has nSequence <= 0xfffffffd — i.e. any value
// 0x00000000..0xfffffffd signals RBF, and 0xfffffffe and 0xffffffff do NOT.
// 0xfffffffe is the nLocktime-enabled-but-not-RBF value, not an RBF signal.
//
// feeBump.ts exports RBF_SIGNAL_MAX_SEQUENCE = 0xfffffffe as the exclusive
// upper bound (the first non-signaling value) and gates the
// original-signals-RBF check (line ~210) on
//   (sequence ?? 0xffffffff) >= RBF_SIGNAL_MAX_SEQUENCE  -->  throw 'not_rbf'
// which correctly rejects sequence === 0xfffffffe (and 0xffffffff) as NOT
// signaling RBF, and accepts everything <= 0xfffffffd. This is correct and
// matches the rest of the codebase (bitcoin/psbt.ts RBF_SEQUENCE =
// 0xfffffffd; chain/index.ts rbf = sequence < 0xfffffffe; types.ts "any
// input sequence < 0xfffffffe").
//
// Group A below calls the real executeRbfBump() directly (the function that
// contains the ~line 210 check) and pins every side of that boundary. Group B
// exercises the full construction path (transactions.ts -> feeBump.ts ->
// bitcoin/psbt.ts) to confirm a successfully bumped replacement itself still
// signals RBF on every input, so it remains bumpable again. Group C repeats
// the pinned boundary case through the public bumpTransaction() API to make
// sure the wiring between transactions.ts and feeBump.ts doesn't mask/shift
// the boundary.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Transaction, NETWORK } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { constructPsbt } from './bitcoin/psbt';
import { executeRbfBump, RBF_SIGNAL_MAX_SEQUENCE, BumpError, type BumpableTxRow } from './feeBump';
import { bumpTransaction } from './transactions';

// ---- shared chain mock (both executeRbfBump and bumpTransaction call
// getChain().getTx/getTxHex) -------------------------------------------------
const { getTxMock, getTxHexMock } = vi.hoisted(() => ({
	getTxMock: vi.fn(),
	getTxHexMock: vi.fn()
}));
vi.mock('./chain', () => ({
	getChain: () => ({ getTx: getTxMock, getTxHex: getTxHexMock })
}));

function wipe(): void {
	db.exec(
		'DELETE FROM transactions; DELETE FROM sessions; DELETE FROM wallets; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	getTxMock.mockReset();
	getTxHexMock.mockReset();
	getTxMock.mockResolvedValue({ confirmed: false });
	setSetting('registration_mode', 'open');
});

const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

/** A minimal, unsigned, single-input PSBT carrying the given input sequence.
 *  Only the sequence value matters to the rule-1 check under test; the input
 *  is deliberately "unknown" (no witnessUtxo/derivation) since that check
 *  runs before anything reads prevout data. */
function makeStoredPsbt(sequence: number | undefined): string {
	const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
	tx.addInput({
		txid: '11'.repeat(32),
		index: 0,
		...(sequence !== undefined ? { sequence } : {})
	});
	tx.addOutputAddress(RECIPIENT, 30_000n, NETWORK);
	return base64.encode(tx.toPSBT());
}

describe('feeBump RBF-signaling boundary (rule 1, ~feeBump.ts:210)', () => {
	// executeRbfBump order-of-checks: rule-1 RBF-signal loop runs BEFORE the
	// changeIndex/no-change check. Forcing changeIndex: null turns "the RBF
	// check did NOT throw" into an observable, distinct outcome (BumpError
	// 'no_change') without needing a real buildReplacement/DB insert — so each
	// case below isolates exactly the ~line 210 boundary comparison.
	function attemptBump(sequence: number | undefined) {
		const tx: BumpableTxRow = {
			status: 'completed',
			txid: '22'.repeat(32),
			fee: 500,
			feeRate: 5,
			changeIndex: null,
			psbt: makeStoredPsbt(sequence)
		};
		return executeRbfBump({
			spec: { table: 'transactions', ownerColumn: 'wallet_id' },
			ownerId: 999_999,
			tx,
			newFeeRate: 25,
			buildReplacement: vi.fn(async () => {
				throw new Error('buildReplacement must not run — changeIndex is null');
			}),
			reloadDraft: () => null,
			draftSaveError: () => new Error('unexpected insert')
		});
	}

	it.each([
		['0 (min)', 0],
		['0xfffffffd (RBF_SEQUENCE, MAX_BIP125_RBF_SEQUENCE)', 0xfffffffd]
	])('treats sequence %s as RBF-signaling, not final', async (_label, sequence) => {
		// Passing the rule-1 check surfaces as 'no_change' (the next guard),
		// NOT 'not_rbf'.
		await expect(attemptBump(sequence)).rejects.toMatchObject({ code: 'no_change' });
	});

	it('treats sequence 0xfffffffe (the boundary, RBF_SIGNAL_MAX_SEQUENCE) as NOT RBF-signaling', async () => {
		// 0xfffffffe is one above MAX_BIP125_RBF_SEQUENCE — it does not opt in
		// to RBF per BIP-125, so this must be rejected as 'not_rbf'.
		await expect(attemptBump(0xfffffffe)).rejects.toMatchObject({ code: 'not_rbf' });
	});

	it('treats sequence 0xffffffff as final — genuinely not RBF-signaling', async () => {
		await expect(attemptBump(0xffffffff)).rejects.toMatchObject({ code: 'not_rbf' });
		await expect(attemptBump(0xffffffff)).rejects.toThrow(/doesn't signal RBF/);
	});

	it('treats a missing sequence (defaults to final) as not RBF-signaling', async () => {
		await expect(attemptBump(undefined)).rejects.toMatchObject({ code: 'not_rbf' });
	});

	it('pins the exported boundary constant itself', () => {
		expect(RBF_SIGNAL_MAX_SEQUENCE).toBe(0xfffffffe);
	});
});

describe('feeBump RBF-signaling boundary via the public bumpTransaction API', () => {
	function seedWalletWithOriginal(sequence: number): { userId: number; walletId: number; txId: number } {
		const user = registerUser({
			email: `rbf-${sequence}@example.com`,
			password: 'correct horse battery',
			displayName: 'u'
		});
		const walletRes = db
			.prepare(
				"INSERT INTO wallets (user_id, name, type, xpub, script_type) VALUES (?, 'W', 'xpub', 'xpub-fake', 'p2wpkh')"
			)
			.run(user.id);
		const walletId = Number(walletRes.lastInsertRowid);
		// changeIndex omitted (NULL) — same "no_change after rule 1" isolation
		// trick as Group A, now driven through the real getTransaction() row
		// shape and the public bumpTransaction() entry point.
		const txRes = db
			.prepare(
				`INSERT INTO transactions (wallet_id, status, psbt, txid, recipient, amount, fee, fee_rate)
				 VALUES (?, 'completed', ?, ?, 'bc1qexample', 1000, 200, 5)`
			)
			.run(walletId, makeStoredPsbt(sequence), '33'.repeat(32));
		return { userId: user.id, walletId, txId: Number(txRes.lastInsertRowid) };
	}

	it('rejects the boundary value 0xfffffffe through bumpTransaction (not RBF-signaling)', async () => {
		const { userId, walletId, txId } = seedWalletWithOriginal(0xfffffffe);
		await expect(bumpTransaction(userId, walletId, txId, 25)).rejects.toMatchObject({
			code: 'not_rbf'
		});
	});

	it('rejects the final value 0xffffffff through bumpTransaction', async () => {
		const { userId, walletId, txId } = seedWalletWithOriginal(0xffffffff);
		await expect(bumpTransaction(userId, walletId, txId, 25)).rejects.toMatchObject({
			code: 'not_rbf'
		});
	});
});

describe('a constructed replacement itself signals RBF (bumped tx stays bumpable)', () => {
	const ZPUB =
		'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
	const RECEIVE_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // m/0/0
	const CHANGE_0 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'; // m/1/0
	const ORIGINAL_TXID = 'ab'.repeat(32);

	function fundingTx(outputs: { address: string; value: number }[]): { hex: string; txid: string } {
		const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
		tx.addInput({ txid: '00'.repeat(32), index: 0 });
		for (const o of outputs) tx.addOutputAddress(o.address, BigInt(o.value), NETWORK);
		return { hex: tx.hex, txid: tx.id };
	}
	const FUND = fundingTx([{ address: RECEIVE_0, value: 100_000 }]);

	function seedRealWallet(email: string): { userId: number; walletId: number } {
		const user = registerUser({ email, password: 'correct horse battery', displayName: 'u' });
		const res = db
			.prepare(
				`INSERT INTO wallets (user_id, name, type, xpub, script_type, master_fingerprint, derivation_path)
				 VALUES (?, 'W', 'xpub', ?, 'p2wpkh', ?, ?)`
			)
			.run(user.id, ZPUB, '73c5da0a', "m/84'/0'/0'");
		return { userId: user.id, walletId: Number(res.lastInsertRowid) };
	}

	async function seedBroadcastOriginal(walletId: number, feeRate = 5) {
		const details = await constructPsbt({
			xpub: ZPUB,
			utxos: [
				{ txid: FUND.txid, vout: 0, value: 100_000, height: 800_000, address: RECEIVE_0, chain: 0, index: 0 }
			],
			recipients: [{ address: RECIPIENT, amount: 30_000 }],
			feeRate,
			changeAddress: CHANGE_0,
			changeIndex: 0,
			origin: { fingerprint: '73c5da0a', path: "m/84'/0'/0'" },
			fetchRawTx: async () => FUND.hex
		});
		const res = db
			.prepare(
				`INSERT INTO transactions (wallet_id, status, psbt, txid, recipient, amount, fee, fee_rate, change_index)
				 VALUES (?, 'completed', ?, ?, ?, ?, ?, ?, 0)`
			)
			.run(walletId, details.psbtBase64, ORIGINAL_TXID, RECIPIENT, details.amount, details.fee, details.feeRate);
		return { txId: Number(res.lastInsertRowid) };
	}

	beforeEach(() => {
		getTxMock.mockResolvedValue({ confirmed: false });
		getTxHexMock.mockResolvedValue(FUND.hex);
	});

	it('gives every input of the bumped replacement a sequence that itself signals RBF', async () => {
		const { userId, walletId } = seedRealWallet('rbf-construct@example.com');
		const orig = await seedBroadcastOriginal(walletId);

		const { details } = await bumpTransaction(userId, walletId, orig.txId, 25);
		const tx = Transaction.fromPSBT(base64.decode(details.psbtBase64));

		expect(tx.inputsLength).toBeGreaterThan(0);
		for (let i = 0; i < tx.inputsLength; i++) {
			const seq = tx.getInput(i).sequence;
			// Must remain truly RBF-signaling per BIP-125 (Cairn builds with
			// RBF_SEQUENCE = 0xfffffffd) — strictly below RBF_SIGNAL_MAX_SEQUENCE
			// (the first non-signaling value), not merely at the boundary.
			expect(seq).toBeLessThan(RBF_SIGNAL_MAX_SEQUENCE);
			expect(seq).toBeLessThan(0xffffffff);
		}
	});
});

// Sanity: BumpError stays a real export used by the matchers above (guards
// against the class import silently resolving to `undefined` in this file).
describe('module wiring', () => {
	it('exposes BumpError', () => {
		expect(BumpError).toBeDefined();
	});
});
