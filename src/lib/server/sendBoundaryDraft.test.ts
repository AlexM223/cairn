// cairn-9v9g — send-flow boundary matrix, integration layer: the SAME
// zero-balance / min-relay-fee / off-by-one-sat / sweep boundaries as
// bitcoin/sendBoundaryMatrix.test.ts, but exercised through the real
// buildDraft (transactions.ts) and buildMultisigDraft (multisigTransactions.ts)
// orchestration — live UTXO gathering, change derivation, and draft
// persistence — with only the network edges (Electrum/chain) faked. This
// confirms the pure construction-layer boundaries in sendBoundaryMatrix.test.ts
// are actually wired end to end, and that a REJECTED build persists nothing.
//
// Mocking follows the existing conventions exactly: walletsDraft.test.ts's
// './bitcoin/walletScan' + './chain' mock for the single-sig side, and
// multisigTransactions.test.ts's './chain' + './multisigScan' mock for the
// multisig side (both mock the same './chain' module — the two sides never
// run in the same test, so one shared mock covers both).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Transaction, NETWORK } from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';

const mocks = vi.hoisted(() => ({
	scanWallet: vi.fn(),
	findNextUnusedIndex: vi.fn(),
	listUnspent: vi.fn(),
	getTx: vi.fn(),
	getTxHex: vi.fn(),
	getTip: vi.fn(),
	getMinFeeRate: vi.fn(),
	getCpfpInfo: vi.fn(),
	broadcast: vi.fn(),
	msUtxos: vi.fn(),
	msChangeIndex: vi.fn()
}));

vi.mock('./bitcoin/walletScan', () => ({
	scanWallet: mocks.scanWallet,
	findNextUnusedIndex: mocks.findNextUnusedIndex,
	invalidateWalletCache: vi.fn(),
	primeWalletScanCache: vi.fn()
}));
vi.mock('./chain', () => ({
	getChain: () => ({
		electrum: {
			listUnspent: mocks.listUnspent,
			batchRequest: (items: { method: string; params: unknown[] }[]) =>
				Promise.all(items.map((it) => mocks.listUnspent(it.params[0]))),
			broadcast: mocks.broadcast
		},
		getTx: mocks.getTx,
		getTxHex: mocks.getTxHex,
		getTip: mocks.getTip,
		getMinFeeRate: mocks.getMinFeeRate,
		getCpfpInfo: mocks.getCpfpInfo
	})
}));
vi.mock('./multisigScan', () => ({
	getMultisigUtxos: mocks.msUtxos,
	nextMultisigChangeIndex: mocks.msChangeIndex
}));

import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { createWallet } from './wallets';
import { buildDraft, listTransactions } from './transactions';
import { buildMultisigDraft, listMultisigTransactions } from './multisigTransactions';
import { getMultisig, toMultisigConfig } from './wallets/multisig';
import { deriveMultisigAddress } from './bitcoin/multisig';
import { addressToScripthash } from './bitcoin/xpub';
import { PsbtError } from './bitcoin/psbt';
import type { WalletScanResult } from './bitcoin/walletScan';
import type { SpendableUtxo } from './bitcoin/psbt';

// ── plain-language guard, same standard as sendBoundaryMatrix.test.ts ───────
const ERROR_CODES = [
	'invalid_recipient',
	'invalid_amount',
	'insufficient_funds',
	'no_utxos',
	'immature_coinbase',
	'construction_failed'
];
function expectPlainLanguage(message: string): void {
	expect(message.length).toBeGreaterThan(0);
	expect(message).not.toMatch(/^[A-Z][a-zA-Z]*(Error)?:/);
	expect(message).not.toContain('[object Object]');
	expect(message).not.toContain('undefined');
	expect(message).not.toContain('NaN');
	for (const code of ERROR_CODES) expect(message).not.toContain(code);
	expect(message).toMatch(/[.!?]$/);
}
async function expectPlainRejection(p: Promise<unknown>, code: string): Promise<PsbtError> {
	let caught: unknown;
	try {
		await p;
	} catch (e) {
		caught = e;
	}
	expect(caught).toBeInstanceOf(PsbtError);
	const err = caught as PsbtError;
	expect(err.code).toBe(code);
	expectPlainLanguage(err.message);
	return err;
}

function wipe(): void {
	db.exec(
		`DELETE FROM transactions; DELETE FROM tx_labels; DELETE FROM wallets;
		 DELETE FROM multisig_transactions; DELETE FROM multisig_keys; DELETE FROM multisigs;
		 DELETE FROM events; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;`
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	vi.clearAllMocks();
	mocks.getTip.mockResolvedValue({ height: 900_000 });
	// Default node relay floor = 1 sat/vB (the historical/incapable-node fallback);
	// individual sub-1 tests override this to a lower value (cairn-eacw.2).
	mocks.getMinFeeRate.mockResolvedValue(1);
	mocks.getTx.mockResolvedValue({ vin: [{}], confirmed: false, rbf: true });
	mocks.getCpfpInfo.mockResolvedValue(null);
	mocks.msChangeIndex.mockResolvedValue(0);
});

/** A synthetic funding tx with a REAL txid, for constructPsbt's nonWitnessUtxo
 *  hash verification. */
function fundingTx(address: string, value: number): { hex: string; txid: string } {
	const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
	tx.addInput({ txid: '00'.repeat(32), index: 0 });
	tx.addOutputAddress(address, BigInt(value), NETWORK);
	return { hex: tx.hex, txid: tx.id };
}

// ── single-sig fixtures ──────────────────────────────────────────────────────
const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const RECEIVE_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // m/0/0
const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

/** Wires a wallet with exactly ONE confirmed p2wpkh coin of `value` sats on
 *  m/0/0 — enough control to hit exact-sat boundaries deterministically. */
function wireSingleCoinWallet(value: number): { txid: string } {
	const fund = fundingTx(RECEIVE_0, value);
	const scan: WalletScanResult = {
		addresses: [
			{ address: RECEIVE_0, derivationPath: 'm/0/0', index: 0, change: false, used: true, balance: value, txCount: 1 }
		],
		txs: [],
		confirmed: value,
		unconfirmed: 0,
		scanTruncated: false
	};
	mocks.scanWallet.mockResolvedValue(scan);
	mocks.findNextUnusedIndex.mockResolvedValue(0);
	mocks.listUnspent.mockImplementation(async (sh: string) =>
		sh === addressToScripthash(RECEIVE_0) ? [{ tx_hash: fund.txid, tx_pos: 0, value, height: 800_000 }] : []
	);
	mocks.getTxHex.mockImplementation(async (txid: string) => {
		if (txid === fund.txid) return fund.hex;
		throw new Error(`no such tx ${txid}`);
	});
	return { txid: fund.txid };
}

async function seedWallet(email: string): Promise<{ userId: number; walletId: number }> {
	const user = await registerUser({ email, password: 'correct horse battery', displayName: 'u' });
	const w = createWallet(user.id, { name: 'W', xpub: ZPUB });
	return { userId: user.id, walletId: w.id };
}

// ── multisig fixtures ────────────────────────────────────────────────────────
const BIP48_PATH = "m/48'/0'/0'/2'";
function makeSigner(seedByte: number) {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive(BIP48_PATH);
	return { fingerprint: (master.fingerprint >>> 0).toString(16).padStart(8, '0'), xpub: account.publicExtendedKey };
}
const SIGNERS = [1, 2, 3].map(makeSigner);

async function seedMultisig(email: string): Promise<{ userId: number; multisigId: number }> {
	const user = await registerUser({ email, password: 'correct horse battery', displayName: 'u' });
	const res = db
		.prepare("INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, 'V', 2, 'p2wsh')")
		.run(user.id);
	const multisigId = Number(res.lastInsertRowid);
	const insert = db.prepare(
		`INSERT INTO multisig_keys (multisig_id, position, name, category, device_type, xpub, fingerprint, path)
		 VALUES (?, ?, ?, 'hardware', 'file', ?, ?, ?)`
	);
	SIGNERS.forEach((s, i) => insert.run(multisigId, i, `Key ${i + 1}`, s.xpub, s.fingerprint, BIP48_PATH));
	return { userId: user.id, multisigId };
}

/** Wires a multisig with exactly ONE confirmed coin of `value` sats on 0/0. */
function wireSingleCoinMultisig(userId: number, multisigId: number, value: number): void {
	const multisig = getMultisig(userId, multisigId)!;
	const address = deriveMultisigAddress(toMultisigConfig(multisig), 0, 0).address;
	const fund = fundingTx(address, value);
	mocks.msUtxos.mockResolvedValue([
		{ txid: fund.txid, vout: 0, value, height: 800_000, address, chain: 0, index: 0 } as SpendableUtxo
	]);
	mocks.getTxHex.mockImplementation(async (txid: string) => {
		if (txid === fund.txid) return fund.hex;
		throw new Error(`no such tx ${txid}`);
	});
}

// ═══════════════════════════════════════════════════════════ 1. ZERO BALANCE

describe('buildDraft / buildMultisigDraft: zero balance', () => {
	it('single-sig: an empty (never-used) wallet rejects with no_utxos and persists nothing', async () => {
		const { userId, walletId } = await seedWallet('zero@example.com');
		mocks.scanWallet.mockResolvedValue({ addresses: [], txs: [], confirmed: 0, unconfirmed: 0 });
		mocks.findNextUnusedIndex.mockResolvedValue(0);

		await expectPlainRejection(
			buildDraft(userId, walletId, { recipients: [{ address: RECIPIENT, amount: 1_000 }], feeRate: 5 }),
			'no_utxos'
		);
		expect(listTransactions(userId, walletId)).toEqual([]);
	});

	it('multisig: an empty multisig rejects with no_utxos and persists nothing', async () => {
		const { userId, multisigId } = await seedMultisig('zero@example.com');
		mocks.msUtxos.mockResolvedValue([]);

		await expectPlainRejection(
			buildMultisigDraft(userId, multisigId, { recipients: [{ address: RECIPIENT, amount: 1_000 }], feeRate: 5 }),
			'no_utxos'
		);
		expect(listMultisigTransactions(userId, multisigId)).toEqual([]);
	});
});

// ═══════════════════════════════════════════════════ 2. MIN-RELAY-FEE BOUNDARY

describe('buildDraft / buildMultisigDraft: fee-rate floor', () => {
	it('single-sig: feeRate 0 rejects with the greater-than-zero message and persists nothing', async () => {
		const { userId, walletId } = await seedWallet('rate@example.com');
		wireSingleCoinWallet(60_000);

		const err = await expectPlainRejection(
			buildDraft(userId, walletId, { recipients: [{ address: RECIPIENT, amount: 10_000 }], feeRate: 0 }),
			'invalid_amount'
		);
		expect(err.message).toBe('Enter a fee rate greater than zero.');
		expect(listTransactions(userId, walletId)).toEqual([]);
	});

	it('single-sig: feeRate exactly 1 (the floor) succeeds and persists a draft', async () => {
		const { userId, walletId } = await seedWallet('rate-ok@example.com');
		wireSingleCoinWallet(60_000);

		const { draft } = await buildDraft(userId, walletId, {
			recipients: [{ address: RECIPIENT, amount: 10_000 }],
			feeRate: 1
		});
		expect(draft.status).toBe('draft');
		expect(listTransactions(userId, walletId)).toHaveLength(1);
	});

	it('single-sig: 0.5 is rejected when the node floor is 1 with floor-aware copy (cairn-eacw.2)', async () => {
		mocks.getMinFeeRate.mockResolvedValue(1);
		const { userId, walletId } = await seedWallet('rate-incapable@example.com');
		wireSingleCoinWallet(60_000);

		const err = await expectPlainRejection(
			buildDraft(userId, walletId, { recipients: [{ address: RECIPIENT, amount: 10_000 }], feeRate: 0.5 }),
			'invalid_amount'
		);
		expect(err.message).toContain('below what your node will relay');
		expect(err.message).toContain('1 sat/vB');
		expect(listTransactions(userId, walletId)).toEqual([]);
	});

	it('single-sig: 0.5 builds and persists when the node floor is 0.1 (cairn-eacw.2)', async () => {
		mocks.getMinFeeRate.mockResolvedValue(0.1);
		const { userId, walletId } = await seedWallet('rate-capable@example.com');
		wireSingleCoinWallet(60_000);

		const { draft } = await buildDraft(userId, walletId, {
			recipients: [{ address: RECIPIENT, amount: 10_000 }],
			feeRate: 0.5
		});
		expect(draft.status).toBe('draft');
		expect(listTransactions(userId, walletId)).toHaveLength(1);
		// The float fee_rate survives the DB round-trip (fee_rate is a float column):
		// buildDraft returns the row RELOADED from the DB (getTransaction), so its
		// feeRate is the persisted value, and it reads back sub-1.
		expect(draft.feeRate).toBeLessThan(1);
		expect(draft.feeRate).toBeGreaterThan(0);
	});

	it('multisig: feeRate 0 rejects with the greater-than-zero message and persists nothing', async () => {
		const { userId, multisigId } = await seedMultisig('rate@example.com');
		wireSingleCoinMultisig(userId, multisigId, 200_000);

		const err = await expectPlainRejection(
			buildMultisigDraft(userId, multisigId, { recipients: [{ address: RECIPIENT, amount: 10_000 }], feeRate: 0 }),
			'invalid_amount'
		);
		expect(err.message).toBe('Enter a fee rate greater than zero.');
		expect(listMultisigTransactions(userId, multisigId)).toEqual([]);
	});

	it('multisig: 0.5 builds when the node floor is 0.1, rejects when floor is 1 (cairn-eacw.2 parity)', async () => {
		const { userId, multisigId } = await seedMultisig('rate-ms@example.com');
		wireSingleCoinMultisig(userId, multisigId, 200_000);

		mocks.getMinFeeRate.mockResolvedValue(1);
		const err = await expectPlainRejection(
			buildMultisigDraft(userId, multisigId, { recipients: [{ address: RECIPIENT, amount: 10_000 }], feeRate: 0.5 }),
			'invalid_amount'
		);
		expect(err.message).toContain('below what your node will relay');
		expect(listMultisigTransactions(userId, multisigId)).toEqual([]);

		mocks.getMinFeeRate.mockResolvedValue(0.1);
		const { draft } = await buildMultisigDraft(userId, multisigId, {
			recipients: [{ address: RECIPIENT, amount: 10_000 }],
			feeRate: 0.5
		});
		expect(draft.status).toBe('draft');
		expect(listMultisigTransactions(userId, multisigId)).toHaveLength(1);
		// draft is the DB-reloaded row (getMultisigTransaction), so its float
		// fee_rate is the persisted, round-tripped value and reads back sub-1.
		expect(draft.feeRate).toBeLessThan(1);
		expect(draft.feeRate).toBeGreaterThan(0);
	});
});

// ═══════ 3. AMOUNT + FEE EXCEEDS BALANCE BY EXACTLY 1 SAT (auto-selection)

describe('buildDraft / buildMultisigDraft: balance short by exactly 1 sat', () => {
	it('single-sig: one sat short of amount+fee rejects; the exact amount succeeds changeless', async () => {
		const { userId, walletId } = await seedWallet('boundary@example.com');
		// Single p2wpkh input, single p2wpkh recipient output, changeless:
		// vsize = 11 (overhead) + 68 (1 input) + 31 (1 output) = 110.
		const feeRate = 1;
		const vsize = 11 + 68 + 31;
		const fee = Math.ceil(vsize * feeRate);
		const amount = 30_000;

		wireSingleCoinWallet(amount + fee - 1);
		await expectPlainRejection(
			buildDraft(userId, walletId, { recipients: [{ address: RECIPIENT, amount }], feeRate }),
			'insufficient_funds'
		);
		expect(listTransactions(userId, walletId)).toEqual([]);

		wireSingleCoinWallet(amount + fee);
		const { draft, details } = await buildDraft(userId, walletId, {
			recipients: [{ address: RECIPIENT, amount }],
			feeRate
		});
		expect(draft.amount).toBe(amount);
		expect(details.change).toBeNull();
		expect(listTransactions(userId, walletId)).toHaveLength(1);
	});

	it('multisig: one sat short of amount+fee rejects; the exact amount succeeds changeless', async () => {
		const { userId, multisigId } = await seedMultisig('boundary@example.com');
		const amount = 30_000;
		const feeRate = 1;

		// Multisig per-input vsize depends on the M-of-N witness formula — probe
		// the real changeless-spend floor with a comfortably large coin first,
		// then binary-search the minimal sufficient totalIn against the real
		// builder rather than hand-deriving the CHECKMULTISIG size formula.
		wireSingleCoinMultisig(userId, multisigId, 10_000_000);
		const probe = await buildMultisigDraft(userId, multisigId, {
			recipients: [{ address: RECIPIENT, amount }],
			feeRate
		});
		let lo = amount;
		let hi = probe.details.amount + probe.details.fee + (probe.details.change?.value ?? 0);
		while (lo + 1 < hi) {
			const mid = Math.floor((lo + hi) / 2);
			wireSingleCoinMultisig(userId, multisigId, mid);
			try {
				await buildMultisigDraft(userId, multisigId, {
					recipients: [{ address: RECIPIENT, amount }],
					feeRate
				});
				hi = mid;
			} catch {
				lo = mid;
			}
		}
		// Clear the drafts the probing above persisted so the boundary assertions
		// below start from a clean slate.
		db.exec('DELETE FROM multisig_transactions');

		wireSingleCoinMultisig(userId, multisigId, hi - 1);
		await expectPlainRejection(
			buildMultisigDraft(userId, multisigId, { recipients: [{ address: RECIPIENT, amount }], feeRate }),
			'insufficient_funds'
		);
		expect(listMultisigTransactions(userId, multisigId)).toEqual([]);

		wireSingleCoinMultisig(userId, multisigId, hi);
		const { draft, details } = await buildMultisigDraft(userId, multisigId, {
			recipients: [{ address: RECIPIENT, amount }],
			feeRate
		});
		expect(draft.amount).toBe(amount);
		expect(details.change).toBeNull();
	});
});

// ═══════════════════════════════════════════════════════════ 4. SWEEP / DUST

describe('buildDraft / buildMultisigDraft: sweep result at the dust boundary', () => {
	it('single-sig: sweep result of exactly 546 sats rejects; 547 succeeds, no change', async () => {
		// vsize = 11 + 68 (1 input) + 31 (1 sweep output) = 110; fee at 1 sat/vB = 110.
		const feeRate = 1;
		const fee = 110;

		const { userId, walletId } = await seedWallet('sweep@example.com');
		wireSingleCoinWallet(fee + 546);
		await expectPlainRejection(
			buildDraft(userId, walletId, { recipients: [{ address: RECIPIENT, amount: 'max' }], feeRate }),
			'insufficient_funds'
		);
		expect(listTransactions(userId, walletId)).toEqual([]);

		wireSingleCoinWallet(fee + 547);
		const { draft, details } = await buildDraft(userId, walletId, {
			recipients: [{ address: RECIPIENT, amount: 'max' }],
			feeRate
		});
		expect(draft.amount).toBe(547);
		expect(details.change).toBeNull();
	});

	it('multisig: sweep succeeds and persists with changeIndex null', async () => {
		const { userId, multisigId } = await seedMultisig('sweep@example.com');
		wireSingleCoinMultisig(userId, multisigId, 200_000);

		const { draft, details } = await buildMultisigDraft(userId, multisigId, {
			recipients: [{ address: RECIPIENT, amount: 'max' }],
			feeRate: 5
		});
		expect(details.change).toBeNull();
		expect(draft.changeIndex).toBeNull();
	});
});

// ═══════════════════════════════ FORMERLY A KNOWN GAP — fixed, cairn-ykk6
//
// Previously buildDraft/buildMultisigDraft would silently PERSIST a draft
// paying a sub-dust amount to a plain recipient (only rejected much later at
// broadcast). validateRecipientsAndFeeRate (psbt.ts) now rejects it
// pre-flight, and buildDraft/buildMultisigDraft propagate that rejection
// before ever writing a row — confirmed here at the integration layer (DB +
// draft persistence), matching the pure-construction coverage in
// bitcoin/sendBoundaryMatrix.test.ts.
describe('formerly KNOWN GAP, now fixed: plain recipient dust is rejected before persistence', () => {
	it('single-sig: buildDraft rejects a 100-sat plain recipient amount and persists nothing', async () => {
		const { userId, walletId } = await seedWallet('gap@example.com');
		wireSingleCoinWallet(60_000);

		const err = await expectPlainRejection(
			buildDraft(userId, walletId, {
				recipients: [{ address: RECIPIENT, amount: 100 }],
				feeRate: 5
			}),
			'invalid_amount'
		);
		expect(err.message.toLowerCase()).toContain('too small to send');
		expect(listTransactions(userId, walletId)).toEqual([]);
	});

	it('single-sig: buildDraft accepts the amount at the exact dust floor (294 sats, p2wpkh) and persists it', async () => {
		const { userId, walletId } = await seedWallet('gap-ok@example.com');
		wireSingleCoinWallet(60_000);

		const { draft } = await buildDraft(userId, walletId, {
			recipients: [{ address: RECIPIENT, amount: 294 }],
			feeRate: 5
		});
		expect(draft.amount).toBe(294);
		expect(listTransactions(userId, walletId)).toHaveLength(1);
	});

	it('multisig: buildMultisigDraft rejects a 100-sat plain recipient amount and persists nothing', async () => {
		const { userId, multisigId } = await seedMultisig('gap@example.com');
		wireSingleCoinMultisig(userId, multisigId, 200_000);

		const err = await expectPlainRejection(
			buildMultisigDraft(userId, multisigId, {
				recipients: [{ address: RECIPIENT, amount: 100 }],
				feeRate: 5
			}),
			'invalid_amount'
		);
		expect(err.message.toLowerCase()).toContain('too small to send');
		expect(listMultisigTransactions(userId, multisigId)).toEqual([]);
	});
});
