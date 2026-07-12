// cairn-ui52 — single-sig wallet service + draft/coin-control coverage.
// createWallet/listWallets/getWalletDetail/nextReceiveAddress live in
// wallets.ts; buildDraft (the fund-moving orchestration: live UTXO gathering,
// unconfirmed-trust classification, change derivation, constructPsbt call, and
// draft persistence) lives in transactions.ts. Both are exercised here through
// their real code paths with ONLY the network seams mocked: ./bitcoin/walletScan
// (Electrum gap scans) and ./chain (getChain facade). PSBT construction runs
// for real against the BIP84 documentation vectors (same fixture family as
// bitcoin/psbt.test.ts) — this file asserts wallets/transactions orchestration,
// not psbt.ts internals (those are pinned in bitcoin/psbt.test.ts).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Transaction, NETWORK } from '@scure/btc-signer';

const mocks = vi.hoisted(() => ({
	scanWallet: vi.fn(),
	findNextUnusedIndex: vi.fn(),
	invalidateWalletCache: vi.fn(),
	listUnspent: vi.fn(),
	getTx: vi.fn(),
	getTxHex: vi.fn(),
	getTip: vi.fn(),
	getCpfpInfo: vi.fn()
}));

// The real scans hit Electrum; the real chain facade opens sockets.
vi.mock('./bitcoin/walletScan', () => ({
	scanWallet: mocks.scanWallet,
	findNextUnusedIndex: mocks.findNextUnusedIndex,
	invalidateWalletCache: mocks.invalidateWalletCache,
	primeWalletScanCache: vi.fn()
}));
vi.mock('./chain', () => ({
	getChain: () => ({
		electrum: {
			listUnspent: mocks.listUnspent,
			// getWalletUtxos now batches listunspent through batchRequest (task 4);
			// dispatch each sub-request to the same per-scripthash listUnspent mock.
			batchRequest: (items: { method: string; params: unknown[] }[]) =>
				Promise.all(items.map((it) => mocks.listUnspent(it.params[0])))
		},
		getTx: mocks.getTx,
		getTxHex: mocks.getTxHex,
		getTip: mocks.getTip,
		getCpfpInfo: mocks.getCpfpInfo
	})
}));

import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import {
	createWallet,
	listWallets,
	getWallet,
	getWalletDetail,
	nextReceiveAddress
} from './wallets';
import { buildDraft, listTransactions, deleteTransaction } from './transactions';
import { addressToScripthash } from './bitcoin/xpub';
import type { WalletScanResult } from './bitcoin/walletScan';

// BIP84 documentation vectors ("abandon … about") — public test keys, never a
// real wallet. Same constants bitcoin/psbt.test.ts uses.
const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const RECEIVE_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // m/0/0
const RECEIVE_1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'; // m/0/1
const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

// A second, unrelated valid key (the xpub fixture backups.test.ts uses).
const XPUB_LEGACY =
	'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';

/** Synthetic funding tx with a REAL txid so constructPsbt's nonWitnessUtxo
 *  verification (raw bytes must hash to the input's txid) passes. */
function fundingTx(outputs: { address: string; value: number }[]): { hex: string; txid: string } {
	const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
	tx.addInput({ txid: '00'.repeat(32), index: 0 });
	for (const o of outputs) tx.addOutputAddress(o.address, BigInt(o.value), NETWORK);
	return { hex: tx.hex, txid: tx.id };
}

const FUND_A = fundingTx([{ address: RECEIVE_0, value: 60_000 }]); // 60k on m/0/0
const FUND_B = fundingTx([{ address: RECEIVE_1, value: 40_000 }]); // 40k on m/0/1
const RAW_TXS: Record<string, string> = { [FUND_A.txid]: FUND_A.hex, [FUND_B.txid]: FUND_B.hex };

/** Two used receive addresses, 100k sats confirmed across them. */
const SCAN: WalletScanResult = {
	addresses: [
		{ address: RECEIVE_0, derivationPath: 'm/0/0', index: 0, change: false, used: true, balance: 60_000, txCount: 1 },
		{ address: RECEIVE_1, derivationPath: 'm/0/1', index: 1, change: false, used: true, balance: 40_000, txCount: 1 }
	],
	txs: [],
	confirmed: 100_000,
	unconfirmed: 0
};

const UNSPENT_BY_SCRIPTHASH: Record<string, { tx_hash: string; tx_pos: number; value: number; height: number }[]> = {
	[addressToScripthash(RECEIVE_0)]: [
		{ tx_hash: FUND_A.txid, tx_pos: 0, value: 60_000, height: 800_000 }
	],
	[addressToScripthash(RECEIVE_1)]: [
		{ tx_hash: FUND_B.txid, tx_pos: 0, value: 40_000, height: 800_001 }
	]
};

function wipe(): void {
	db.exec(
		'DELETE FROM transactions; DELETE FROM tx_labels; DELETE FROM wallets; DELETE FROM events; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

let userId: number;

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	vi.clearAllMocks();
	userId = (
		await registerUser({
			email: 'user@example.com',
			password: 'correct horse battery',
			displayName: 'user'
		})
	).id;

	mocks.scanWallet.mockResolvedValue(SCAN);
	mocks.findNextUnusedIndex.mockResolvedValue(0);
	mocks.listUnspent.mockImplementation(async (sh: string) => UNSPENT_BY_SCRIPTHASH[sh] ?? []);
	// annotateCoinbase asks the chain for each funding tx's vin — not coinbase.
	mocks.getTx.mockResolvedValue({ vin: [{}], confirmed: false, rbf: true });
	mocks.getTxHex.mockImplementation(async (txid: string) => {
		const hex = RAW_TXS[txid];
		if (!hex) throw new Error(`no such tx ${txid}`);
		return hex;
	});
	mocks.getTip.mockResolvedValue({ height: 900_000 });
	mocks.getCpfpInfo.mockResolvedValue(null);
});

describe('createWallet + listWallets round-trip', () => {
	it('creates from a zpub, detects the script type, and lists with live balances', async () => {
		const created = createWallet(userId, { name: 'Spending', xpub: ZPUB });
		expect(created).toMatchObject({ name: 'Spending', type: 'xpub', scriptType: 'p2wpkh', xpub: ZPUB });

		const { wallets, errors } = await listWallets(userId);
		expect(errors).toEqual({});
		expect(wallets).toHaveLength(1);
		expect(wallets[0]).toMatchObject({ id: created.id, balance: 100_000, unconfirmed: 0 });
	});

	it('rejects a duplicate import of the same key with a friendly message', () => {
		createWallet(userId, { name: 'Spending', xpub: ZPUB });
		expect(() => createWallet(userId, { name: 'Again', xpub: ZPUB })).toThrow(
			'You already imported this key.'
		);
	});

	it('rejects garbage instead of an xpub with an actionable message', () => {
		// 'garbage' is decodable base58 with a bad checksum → the checksum hint.
		expect(() => createWallet(userId, { name: 'Bad', xpub: 'garbage' })).toThrow(/bad checksum/i);
		// Not base58 at all → the "paste the full key" hint.
		expect(() => createWallet(userId, { name: 'Bad', xpub: 'not-a-key!!' })).toThrow(
			/extended public key/i
		);
		expect(() => createWallet(userId, { name: 'Bad', xpub: '' })).toThrow(/xpub, ypub or zpub/);
	});

	it('auto-names an unnamed wallet by count', () => {
		const w = createWallet(userId, { xpub: ZPUB });
		expect(w.name).toBe('Wallet 1');
	});

	it('a failed scan zeroes that wallet and lands in errors — it never throws', async () => {
		const ok = createWallet(userId, { name: 'OK', xpub: ZPUB });
		const broken = createWallet(userId, { name: 'Broken', xpub: XPUB_LEGACY });
		mocks.scanWallet.mockImplementation(async (xpub: string) => {
			if (xpub === ZPUB) return SCAN;
			throw new Error('electrum down');
		});

		const { wallets, errors } = await listWallets(userId);
		expect(errors).toEqual({ [broken.id]: 'electrum down' });
		expect(wallets.find((w) => w.id === ok.id)!.balance).toBe(100_000);
		expect(wallets.find((w) => w.id === broken.id)!.balance).toBe(0);
	});
});

describe('getWalletDetail', () => {
	it('returns wallet + scan, and null for an unknown or foreign wallet', async () => {
		const w = createWallet(userId, { name: 'Spending', xpub: ZPUB });
		const detail = await getWalletDetail(userId, w.id);
		expect(detail!.wallet.id).toBe(w.id);
		expect(detail!.scan.confirmed).toBe(100_000);

		expect(await getWalletDetail(userId, 999_999)).toBeNull();
		const other = await registerUser({
			email: 'other@example.com',
			password: 'correct horse battery',
			displayName: 'other'
		});
		expect(await getWalletDetail(other.id, w.id)).toBeNull();
	});

	it('a scan failure surfaces as an error with cause "unreachable"', async () => {
		const w = createWallet(userId, { name: 'Spending', xpub: ZPUB });
		mocks.scanWallet.mockRejectedValue(new Error('electrum down'));
		await expect(getWalletDetail(userId, w.id)).rejects.toMatchObject({
			message: 'electrum down',
			cause: 'unreachable'
		});
	});
});

describe('nextReceiveAddress cursor', () => {
	it('hands out the next unused address and advances the persisted cursor', async () => {
		const w = createWallet(userId, { name: 'Spending', xpub: ZPUB });

		const first = await nextReceiveAddress(userId, w.id);
		expect(first).toMatchObject({ index: 0, address: RECEIVE_0, path: expect.stringContaining('/0/0') });
		expect(getWallet(userId, w.id)!.receive_cursor).toBe(1);

		// "Give me a fresh one" — strictly after the address on display.
		const second = await nextReceiveAddress(userId, w.id, 0);
		expect(second).toMatchObject({ index: 1, address: RECEIVE_1 });
		expect(getWallet(userId, w.id)!.receive_cursor).toBe(2);
	});

	it('never escapes the gap-limit window (index caps at nextUnused + 19)', async () => {
		const w = createWallet(userId, { name: 'Spending', xpub: ZPUB });
		const res = await nextReceiveAddress(userId, w.id, 100); // way past the window
		expect(res!.index).toBe(19); // nextUnused(0) + GAP_LIMIT(20) - 1
		expect(getWallet(userId, w.id)!.receive_cursor).toBe(20); // clamped too
	});

	it('returns null for a wallet the caller does not own', async () => {
		const w = createWallet(userId, { name: 'Spending', xpub: ZPUB });
		const other = await registerUser({
			email: 'other@example.com',
			password: 'correct horse battery',
			displayName: 'other'
		});
		expect(await nextReceiveAddress(other.id, w.id)).toBeNull();
	});
});

describe('buildDraft coin control + persistence', () => {
	function draftInput(over: Partial<Parameters<typeof buildDraft>[2]> = {}) {
		return { recipients: [{ address: RECIPIENT, amount: 10_000 as const }], feeRate: 5, ...over };
	}

	it('explicit UTXO selection is respected — only the selected coin is spent', async () => {
		const w = createWallet(userId, { name: 'Spending', xpub: ZPUB });

		const { draft, details } = await buildDraft(userId, w.id, {
			...draftInput(),
			onlyUtxos: [{ txid: FUND_B.txid, vout: 0 }]
		});

		expect(details.inputs).toHaveLength(1);
		expect(details.inputs[0]).toMatchObject({ txid: FUND_B.txid, vout: 0, value: 40_000 });
		// Persisted round-trip: the draft row exists with the constructed values.
		expect(draft).toMatchObject({
			walletId: w.id,
			status: 'draft',
			recipient: RECIPIENT,
			amount: 10_000,
			psbt: details.psbtBase64,
			txid: null
		});
		expect(listTransactions(userId, w.id)).toHaveLength(1);
	});

	it('selecting coins that cannot cover amount + fee fails clearly and persists NOTHING', async () => {
		const w = createWallet(userId, { name: 'Spending', xpub: ZPUB });

		await expect(
			buildDraft(userId, w.id, {
				recipients: [{ address: RECIPIENT, amount: 50_000 }],
				feeRate: 5,
				onlyUtxos: [{ txid: FUND_B.txid, vout: 0 }] // 40k can't pay 50k + fee
			})
		).rejects.toMatchObject({ code: 'insufficient_funds' });

		expect(listTransactions(userId, w.id)).toEqual([]); // no half-saved draft
	});

	it('auto-selection covers amount + fee and conserves value', async () => {
		const w = createWallet(userId, { name: 'Spending', xpub: ZPUB });

		const { draft, details } = await buildDraft(userId, w.id, {
			recipients: [{ address: RECIPIENT, amount: 70_000 }],
			feeRate: 5
		});

		expect(details.inputs).toHaveLength(2); // 70k needs both coins
		const totalIn = details.inputs.reduce((s, u) => s + u.value, 0);
		expect(totalIn).toBe(details.amount + details.fee + (details.change?.value ?? 0));
		expect(draft.fee).toBe(details.fee);
		expect(draft.feeRate).toBe(5);
	});

	it('change goes to the wallet’s own change chain and its index is persisted', async () => {
		const w = createWallet(userId, { name: 'Spending', xpub: ZPUB });

		const { draft, details } = await buildDraft(userId, w.id, {
			recipients: [{ address: RECIPIENT, amount: 30_000 }],
			feeRate: 5
		});

		// findNextUnusedIndex(xpub, 1) is mocked to 0 → change index 0 (m/1/0).
		expect(details.change).not.toBeNull();
		expect(details.change!.index).toBe(0);
		expect(draft.changeIndex).toBe(0);
		// The change-chain lookup really was made against chain 1.
		expect(mocks.findNextUnusedIndex).toHaveBeenCalledWith(ZPUB, 1);
	});

	it('send-max sweeps everything with no change output (changeIndex null)', async () => {
		const w = createWallet(userId, { name: 'Spending', xpub: ZPUB });

		const { draft, details } = await buildDraft(userId, w.id, {
			recipients: [{ address: RECIPIENT, amount: 'max' }],
			feeRate: 5
		});

		expect(details.change).toBeNull();
		expect(draft.changeIndex).toBeNull();
		expect(draft.amount).toBe(100_000 - draft.fee);
	});

	it('refuses to build for an unknown or foreign wallet', async () => {
		const w = createWallet(userId, { name: 'Spending', xpub: ZPUB });
		const other = await registerUser({
			email: 'other@example.com',
			password: 'correct horse battery',
			displayName: 'other'
		});
		await expect(buildDraft(userId, 999_999, draftInput())).rejects.toThrow('Wallet not found.');
		await expect(buildDraft(other.id, w.id, draftInput())).rejects.toThrow('Wallet not found.');
		expect(listTransactions(userId, w.id)).toEqual([]);
	});
});

// cairn QA R7 §4.7 B4 (P0): concurrent buildDraft calls against the same
// wallet used to see the identical live UTXO set every time, with no notion
// of "already claimed by another draft" — colliding on the same coin. Fixed
// by excluding coins referenced by this wallet's own in-flight ('draft' /
// 'awaiting_signature') drafts from automatic selection.
describe('buildDraft coin reservation (cairn QA R7 B4)', () => {
	function draftInput(over: Partial<Parameters<typeof buildDraft>[2]> = {}) {
		return { recipients: [{ address: RECIPIENT, amount: 10_000 as const }], feeRate: 5, ...over };
	}

	it('two concurrent (sequential) builds against the same wallet select disjoint coins', async () => {
		const w = createWallet(userId, { name: 'Spending', xpub: ZPUB });

		// Neither send alone needs both 60k/40k coins — without reservation,
		// automatic selection would pick the identical coin both times (the exact
		// R7 B4 repro: same candidate set, same deterministic algorithm).
		const { details: d1, reservationWarning: w1 } = await buildDraft(userId, w.id, draftInput());
		const { details: d2, reservationWarning: w2 } = await buildDraft(userId, w.id, draftInput());

		const keys1 = new Set(d1.inputs.map((i) => `${i.txid}:${i.vout}`));
		const keys2 = new Set(d2.inputs.map((i) => `${i.txid}:${i.vout}`));
		expect(keys1.size).toBeGreaterThan(0);
		for (const k of keys2) expect(keys1.has(k)).toBe(false);
		// Automatic selection never warns — it just avoids the coin outright.
		expect(w1).toBeNull();
		expect(w2).toBeNull();
		expect(listTransactions(userId, w.id)).toHaveLength(2);
	});

	// Live re-run against the real QA stack (cairn QA R7 B4 follow-up) exposed a
	// gap the sequential test above can't see: the reservation check only reads
	// what's ALREADY persisted, so two calls truly overlapping in time (fired
	// via Promise.all, not awaited one after another) could both read "nothing
	// reserved yet" before either had inserted — reproducing the original
	// collision for a rarer, timing-dependent window. Fixed by serializing
	// buildDraft per wallet with the existing keyedLock (withLock, the same
	// tool nextReceiveAddress already uses for an identical race, cairn-2qa4).
	it('true Promise.all concurrency (not just sequential calls) still selects disjoint coins', async () => {
		const w = createWallet(userId, { name: 'Spending', xpub: ZPUB });

		const [{ details: d1 }, { details: d2 }] = await Promise.all([
			buildDraft(userId, w.id, draftInput()),
			buildDraft(userId, w.id, draftInput())
		]);

		const keys1 = new Set(d1.inputs.map((i) => `${i.txid}:${i.vout}`));
		const keys2 = new Set(d2.inputs.map((i) => `${i.txid}:${i.vout}`));
		expect(keys1.size).toBeGreaterThan(0);
		for (const k of keys2) expect(keys1.has(k)).toBe(false);
		expect(listTransactions(userId, w.id)).toHaveLength(2);
	});

	it('an insufficient-funds shortfall caused entirely by reservation names the blocking draft(s)', async () => {
		const w = createWallet(userId, { name: 'Spending', xpub: ZPUB });

		// 70k needs BOTH coins (see the "auto-selection covers amount + fee" test
		// above) — this single draft reserves the wallet's entire spendable set.
		const { draft: draft1 } = await buildDraft(userId, w.id, {
			recipients: [{ address: RECIPIENT, amount: 70_000 }],
			feeRate: 5
		});

		let error: unknown;
		try {
			await buildDraft(userId, w.id, draftInput());
		} catch (e) {
			error = e;
		}
		expect(error).toMatchObject({ code: 'no_utxos' });
		const message = (error as Error).message;
		expect(message).toContain(`#${draft1.id}`);
		// The full 100k (60k + 40k) is reserved — not just the amount short.
		expect(message).toContain('0.001 BTC');
		expect(message).toContain('first');
		// The failed attempt persisted no half-built draft.
		expect(listTransactions(userId, w.id)).toHaveLength(1);
	});

	it('manual coin control may still select a reserved coin, flagged with a reservationWarning', async () => {
		const w = createWallet(userId, { name: 'Spending', xpub: ZPUB });

		const { draft: draft1 } = await buildDraft(userId, w.id, {
			...draftInput(),
			onlyUtxos: [{ txid: FUND_A.txid, vout: 0 }]
		});

		// Same coin, deliberately, via coin control again — not blocked, but flagged.
		const { details, reservationWarning } = await buildDraft(userId, w.id, {
			...draftInput(),
			onlyUtxos: [{ txid: FUND_A.txid, vout: 0 }]
		});
		expect(details.inputs).toEqual([expect.objectContaining({ txid: FUND_A.txid, vout: 0 })]);
		expect(reservationWarning).not.toBeNull();
		expect(reservationWarning!.draftIds).toEqual([draft1.id]);
		expect(reservationWarning!.coins).toEqual([{ txid: FUND_A.txid, vout: 0 }]);
		expect(reservationWarning!.message).toContain(`#${draft1.id}`);
		// Both drafts persisted — coin control was honored, not blocked.
		expect(listTransactions(userId, w.id)).toHaveLength(2);
	});

	it('a coin freed by deleting its reserving draft becomes selectable again', async () => {
		const w = createWallet(userId, { name: 'Spending', xpub: ZPUB });
		const { draft: draft1 } = await buildDraft(userId, w.id, {
			recipients: [{ address: RECIPIENT, amount: 70_000 }],
			feeRate: 5
		});
		await expect(buildDraft(userId, w.id, draftInput())).rejects.toMatchObject({
			code: 'no_utxos'
		});

		expect(deleteTransaction(userId, w.id, draft1.id)).toBe(true);

		// No longer reserved — the same small send now succeeds normally.
		const { details } = await buildDraft(userId, w.id, draftInput());
		expect(details.inputs.length).toBeGreaterThan(0);
	});
});
