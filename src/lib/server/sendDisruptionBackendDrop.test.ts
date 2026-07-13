// cairn-a857 — mid-operation disruption: chain backend (Electrum/Core RPC)
// dies at each stage of the single-sig send pipeline.
//
// Harness mirrors concurrencySingleSigRace.test.ts (same walletScan/chain
// mock shape) — this file is the FAILURE-INJECTION counterpart: instead of
// racing two honest calls, each describe block kills one Electrum call site
// and asserts the pipeline degrades safely:
//   1. UTXO fetch fails (buildDraft's very first network call) -> no draft
//      row is ever written, and the per-wallet lock (keyedLock.ts) is not
//      wedged for the next caller.
//   2. A draft that's already built (pre-broadcast) is confirmed to be the
//      INTENDED persistent/resumable state, not an orphan.
//   3. Broadcast itself fails (or "hangs" — a crashed process leaves a stale
//      claim) -> the row stays retryable (broadcast_started_at cleared, no
//      txid, status never 'completed'), the reserved coin is NOT released
//      for another draft to double-spend, and a later, honest broadcast
//      (backend recovered) completes cleanly.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Transaction, NETWORK } from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { base64, base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';

const mocks = vi.hoisted(() => ({
	scanWallet: vi.fn(),
	findNextUnusedIndex: vi.fn(),
	listUnspent: vi.fn(),
	getTx: vi.fn(),
	getTxHex: vi.fn(),
	getTip: vi.fn(),
	getCpfpInfo: vi.fn(),
	broadcast: vi.fn()
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
		getCpfpInfo: mocks.getCpfpInfo
	})
}));

import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { createWallet } from './wallets';
import {
	buildDraft,
	broadcastTransaction,
	listTransactions,
	getTransaction,
	deleteTransaction,
	reservedWalletCoins,
	BroadcastError
} from './transactions';
import { constructPsbt, type SpendableUtxo } from './bitcoin/psbt';
import { parseXpub, deriveAddress, addressToScripthash } from './bitcoin/xpub';
import type { WalletScanResult } from './bitcoin/walletScan';

function wipe(): void {
	db.exec(
		`DELETE FROM transactions; DELETE FROM tx_labels; DELETE FROM wallets;
		 DELETE FROM events; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;`
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	vi.clearAllMocks();
	mocks.getTip.mockResolvedValue({ height: 900_000 });
	mocks.getTx.mockResolvedValue({ vin: [{}], confirmed: false, rbf: true });
	mocks.getCpfpInfo.mockResolvedValue(null);
});

const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const ZPRV =
	'zprvAWgYBBk7JR8Gjrh4UJQ2uJdG1r3WNRRfURiABBE3RvMXYSrRJL62XuezvGdPvG6GFBZduosCc1YP5wixPox7zhZLfiUm8aunE96BBa4Kei5';
const RECEIVE_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // m/0/0
const CHANGE_0 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'; // m/1/0
const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

function fundingTx(address: string, value: number): { hex: string; txid: string } {
	const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
	tx.addInput({ txid: '00'.repeat(32), index: 0 });
	tx.addOutputAddress(address, BigInt(value), NETWORK);
	return { hex: tx.hex, txid: tx.id };
}

/** One confirmed, spendable coin on m/0/0 — an ordinary healthy wallet. */
function wireOneCoinWallet(): { addr0: string; fund: { hex: string; txid: string } } {
	const parsed = parseXpub(ZPUB);
	const a0 = deriveAddress(parsed, 0, 0);
	const fund0 = fundingTx(a0.address, 200_000);
	const scan: WalletScanResult = {
		addresses: [
			{
				address: a0.address,
				derivationPath: 'm/0/0',
				index: 0,
				change: false,
				used: true,
				balance: 200_000,
				txCount: 1
			}
		],
		txs: [],
		confirmed: 200_000,
		unconfirmed: 0
	};
	mocks.scanWallet.mockResolvedValue(scan);
	mocks.findNextUnusedIndex.mockResolvedValue(1);
	mocks.listUnspent.mockImplementation(async (sh: string) => {
		if (sh === addressToScripthash(a0.address)) {
			return [{ tx_hash: fund0.txid, tx_pos: 0, value: 200_000, height: 800_000 }];
		}
		return [];
	});
	mocks.getTxHex.mockImplementation(async (txid: string) => {
		if (txid === fund0.txid) return fund0.hex;
		throw new Error(`no such tx ${txid}`);
	});
	return { addr0: a0.address, fund: fund0 };
}

async function seedWallet(email: string): Promise<{ userId: number; walletId: number }> {
	const user = await registerUser({ email, password: 'correct horse battery', displayName: 'u' });
	const w = createWallet(user.id, { name: 'W', xpub: ZPUB });
	return { userId: user.id, walletId: w.id };
}

/** A fully-signed single-sig PSBT over one coin on m/0/0, mirroring
 *  concurrencySingleSigRace.test.ts's seedSignedDraft. */
async function seedSignedDraft(walletId: number): Promise<{ txId: number; txid: string }> {
	const utxos: SpendableUtxo[] = [
		{ txid: '11'.repeat(32), vout: 0, value: 60_000, height: 800_000, address: RECEIVE_0, chain: 0, index: 0 }
	];
	const draft = await constructPsbt({
		xpub: ZPUB,
		utxos,
		recipients: [{ address: RECIPIENT, amount: 30_000 }],
		feeRate: 5,
		changeAddress: CHANGE_0,
		changeIndex: 0,
		origin: { fingerprint: '73c5da0a', path: "m/84'/0'/0'" }
	});
	const b58 = base58check(sha256);
	const raw = b58.decode(ZPRV);
	raw.set([0x04, 0x88, 0xad, 0xe4], 0); // SLIP-132 zprv -> xprv
	const account = HDKey.fromExtendedKey(b58.encode(raw)).derive("m/84'/0'/0'");
	const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
	for (let i = 0; i < tx.inputsLength; i++) {
		const path = tx.getInput(i).bip32Derivation![0][1].path;
		tx.signIdx(account.deriveChild(path[3]).deriveChild(path[4]).privateKey!, i);
	}
	tx.finalize();
	const txid = tx.id;
	const res = db
		.prepare(
			`INSERT INTO transactions (wallet_id, status, psbt, recipient, amount, fee, fee_rate)
			 VALUES (?, 'awaiting_signature', ?, ?, 30000, 200, 5)`
		)
		.run(walletId, base64.encode(tx.toPSBT()), RECIPIENT);
	return { txId: Number(res.lastInsertRowid), txid };
}

// ═══════════════════════════════════════════ 1. backend drop DURING UTXO fetch

describe('backend drop during UTXO fetch (buildDraft, before any DB write)', () => {
	it('scanWallet itself failing (Electrum socket dead) leaves zero draft rows', async () => {
		const { userId, walletId } = await seedWallet('drop-scan@example.com');
		mocks.scanWallet.mockRejectedValue(new Error('ECONNRESET: Electrum connection lost'));

		await expect(
			buildDraft(userId, walletId, { recipients: [{ address: RECIPIENT, amount: 10_000 }], feeRate: 5 })
		).rejects.toThrow(/ECONNRESET|connection/i);

		expect(listTransactions(userId, walletId)).toEqual([]);
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number };
		expect(n).toBe(0);
	});

	it('the batched listunspent call failing mid-scan leaves zero draft rows too', async () => {
		const { userId, walletId } = await seedWallet('drop-listunspent@example.com');
		wireOneCoinWallet();
		mocks.listUnspent.mockRejectedValue(new Error('timeout awaiting response'));

		await expect(
			buildDraft(userId, walletId, { recipients: [{ address: RECIPIENT, amount: 10_000 }], feeRate: 5 })
		).rejects.toThrow(/timeout/i);

		expect(listTransactions(userId, walletId)).toEqual([]);
	});

	it('a failed buildDraft does not wedge the per-wallet lock (keyedLock) — the next honest call still succeeds', async () => {
		const { userId, walletId } = await seedWallet('drop-then-recover@example.com');
		wireOneCoinWallet();

		mocks.scanWallet.mockRejectedValueOnce(new Error('Electrum down'));
		await expect(
			buildDraft(userId, walletId, { recipients: [{ address: RECIPIENT, amount: 10_000 }], feeRate: 5 })
		).rejects.toThrow(/Electrum down/);

		// Backend "comes back": wireOneCoinWallet's mockResolvedValue is still
		// armed for the SECOND call (mockRejectedValueOnce only consumed one).
		const result = await buildDraft(userId, walletId, {
			recipients: [{ address: RECIPIENT, amount: 10_000 }],
			feeRate: 5
		});
		expect(result.draft.status).toBe('draft');
		expect(listTransactions(userId, walletId)).toHaveLength(1);
	});
});

// ═══════════════════════════════════════════ 2. the built draft itself is the

describe('a draft that survives to disk after the network calls succeed is intentionally persistent (not an orphan)', () => {
	it('GREEN: a built draft is durable, resumable, and cleanly deletable — this IS the intended "backend died before broadcast" recovery path', async () => {
		const { userId, walletId } = await seedWallet('draft-is-resumable@example.com');
		wireOneCoinWallet();

		const { draft } = await buildDraft(userId, walletId, {
			recipients: [{ address: RECIPIENT, amount: 10_000 }],
			feeRate: 5
		});
		expect(draft.status).toBe('draft');

		// "Backend drops" here just means: the user closes the tab / the process
		// restarts before broadcasting. The row is still there, readable, and
		// safely abandonable — nothing about it is stuck or half-written.
		expect(getTransaction(userId, walletId, draft.id)).not.toBeNull();
		expect(deleteTransaction(userId, walletId, draft.id)).toBe(true);
		expect(getTransaction(userId, walletId, draft.id)).toBeNull();
	});
});

// ═══════════════════════════════════════════ 3. backend drop DURING broadcast

describe('backend drop during broadcast (electrum.broadcast throws)', () => {
	it('a rejected broadcast surfaces a clear BroadcastError, never a silent success or a hang', async () => {
		const { userId, walletId } = await seedWallet('drop-broadcast@example.com');
		const { txId } = await seedSignedDraft(walletId);
		mocks.broadcast.mockRejectedValue(new Error('ECONNRESET: Electrum connection lost'));

		await expect(broadcastTransaction(userId, walletId, txId)).rejects.toBeInstanceOf(BroadcastError);

		const tx = getTransaction(userId, walletId, txId)!;
		expect(tx.status).not.toBe('completed');
		expect(tx.txid).toBeNull();
	});

	it('a failed broadcast releases its claim — the row stays retryable, not stuck "in flight" forever', async () => {
		const { userId, walletId } = await seedWallet('drop-broadcast-claim@example.com');
		const { txId } = await seedSignedDraft(walletId);
		mocks.broadcast.mockRejectedValue(new Error('backend unreachable'));

		await expect(broadcastTransaction(userId, walletId, txId)).rejects.toBeInstanceOf(BroadcastError);

		const row = db
			.prepare('SELECT broadcast_started_at, txid, status FROM transactions WHERE id = ?')
			.get(txId) as { broadcast_started_at: string | null; txid: string | null; status: string };
		expect(row.broadcast_started_at).toBeNull();
		expect(row.txid).toBeNull();
		expect(row.status).not.toBe('completed');
	});

	it('once the backend recovers, retrying the SAME transaction id broadcasts cleanly to completion', async () => {
		const { userId, walletId } = await seedWallet('drop-then-recover-broadcast@example.com');
		const { txId, txid: want } = await seedSignedDraft(walletId);
		mocks.broadcast.mockRejectedValueOnce(new Error('backend unreachable'));

		await expect(broadcastTransaction(userId, walletId, txId)).rejects.toBeInstanceOf(BroadcastError);

		mocks.broadcast.mockImplementation((rawHex: string) =>
			Promise.resolve(Transaction.fromRaw(hexToBytes(rawHex), { disableScriptCheck: true }).id)
		);
		const result = await broadcastTransaction(userId, walletId, txId);
		expect(result.txid).toBe(want);
		expect(getTransaction(userId, walletId, txId)!.status).toBe('completed');
	});

	it('the reserved coin is NOT released back to automatic selection while the failed draft still sits in awaiting_signature — no double-spend window', async () => {
		const { userId, walletId } = await seedWallet('drop-broadcast-reserve@example.com');
		const { txId } = await seedSignedDraft(walletId);
		mocks.broadcast.mockRejectedValue(new Error('backend unreachable'));

		await expect(broadcastTransaction(userId, walletId, txId)).rejects.toBeInstanceOf(BroadcastError);

		// The coin this draft spends ('11'.repeat(32):0, per seedSignedDraft) is
		// still reserved — a fresh automatic buildDraft for the SAME wallet must
		// exclude it, exactly as it would for any other in-flight draft (cairn
		// QA R7 B4). This proves a broadcast failure never silently frees the
		// coin for a second, conflicting spend to grab.
		const reserved = reservedWalletCoins(walletId);
		expect(reserved.has(`${'11'.repeat(32)}:0`)).toBe(true);
		expect(reserved.get(`${'11'.repeat(32)}:0`)).toContain(txId);
	});

	it('a crashed-mid-broadcast claim (broadcast_started_at set, never cleared) blocks a second attempt within the 60s window, then becomes reclaimable after it', async () => {
		const { userId, walletId } = await seedWallet('drop-broadcast-stale-claim@example.com');
		const { txId, txid: want } = await seedSignedDraft(walletId);

		// Simulate the exact state a process crash mid-broadcast would leave:
		// the atomic claim UPDATE ran, but the process died before the network
		// call's catch block could release it (transactions.ts's own comment
		// calls this out as the reason the claim has a TTL at all). The claim
		// column is compared against SQLite's OWN strftime('now') inside the
		// guarded UPDATE — that's the real C-library wall clock, unaffected by
		// vi.useFakeTimers — so this test backdates broadcast_started_at using
		// real Date.now() offsets instead of faking JS time.
		db.prepare('UPDATE transactions SET broadcast_started_at = ? WHERE id = ?').run(
			new Date(Date.now() - 30_000).toISOString(), // 30s old — within the 60s window
			txId
		);

		// Within the 60s window: a fresh caller sees "already in flight" —
		// exactly the same message a genuine double-broadcast would get, which
		// is the honest thing to say (we can't tell "still running" from
		// "crashed" from inside a single request).
		await expect(broadcastTransaction(userId, walletId, txId)).rejects.toMatchObject({
			code: 'already_sent'
		});
		// The failed attempt above must not have touched the network at all —
		// the guarded UPDATE refused it before broadcast() was ever called.
		expect(mocks.broadcast).not.toHaveBeenCalled();

		// Past 60s: the claim is stale and reclaimable. The backend is healthy
		// again in this run, so the retry actually completes.
		db.prepare('UPDATE transactions SET broadcast_started_at = ? WHERE id = ?').run(
			new Date(Date.now() - 61_000).toISOString(),
			txId
		);
		mocks.broadcast.mockImplementation((rawHex: string) =>
			Promise.resolve(Transaction.fromRaw(hexToBytes(rawHex), { disableScriptCheck: true }).id)
		);
		const result = await broadcastTransaction(userId, walletId, txId);
		expect(result.txid).toBe(want);
	});
});
