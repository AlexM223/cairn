// Concurrent multi-user stress — SINGLE-SIG send/create race surfaces
// (test/qa-wave-2026-07-12, workstream-b; relates to cairn-a857).
//
// See concurrencyMultisigRace.test.ts for the full "what concurrent means with a
// synchronous DB" design note. Summary for this file:
//   • buildDraft — ASYNC, withLock('wallet:id'); concurrent builds must reserve
//     disjoint coins (no double-spend of one UTXO across two drafts).
//   • broadcastTransaction — ASYNC, atomic broadcast-claim UPDATE; exactly one of
//     N concurrent broadcasts reaches the network.
//   • createWallet / setWalletDevice / getWallet — FULLY SYNCHRONOUS, hence
//     atomic in-process. The mixed-actor test below (A builds a send while B sets
//     the device while C reads the wallet) asserts the sync writes land cleanly
//     at buildDraft's await boundaries — final state is internally consistent,
//     never half-applied. Double wallet-create of one xpub relies on the
//     UNIQUE(user_id, xpub) constraint, not a lock.
//
// Harness mirrors sendBoundaryDraft.test.ts (same walletScan/chain mocks).

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
		getMinFeeRate: async () => 1,
		getCpfpInfo: mocks.getCpfpInfo
	})
}));

import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { createWallet, getWallet, setWalletDevice } from './wallets';
import { buildDraft, broadcastTransaction, listTransactions } from './transactions';
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

/** Two confirmed coins on m/0/0 and m/0/1, each spendable, so concurrent builds
 *  have two disjoint coins to fight over. */
function wireTwoCoinWallet(): { addr0: string; addr1: string } {
	const parsed = parseXpub(ZPUB);
	const a0 = deriveAddress(parsed, 0, 0);
	const a1 = deriveAddress(parsed, 0, 1);
	const fund0 = fundingTx(a0.address, 200_000);
	const fund1 = fundingTx(a1.address, 150_000);
	const scan: WalletScanResult = {
		addresses: [
			{ address: a0.address, derivationPath: 'm/0/0', index: 0, change: false, used: true, balance: 200_000, txCount: 1 },
			{ address: a1.address, derivationPath: 'm/0/1', index: 1, change: false, used: true, balance: 150_000, txCount: 1 }
		],
		txs: [],
		confirmed: 350_000,
		unconfirmed: 0,
		scanTruncated: false
	};
	mocks.scanWallet.mockResolvedValue(scan);
	mocks.findNextUnusedIndex.mockResolvedValue(2);
	mocks.listUnspent.mockImplementation(async (sh: string) => {
		if (sh === addressToScripthash(a0.address)) return [{ tx_hash: fund0.txid, tx_pos: 0, value: 200_000, height: 800_000 }];
		if (sh === addressToScripthash(a1.address)) return [{ tx_hash: fund1.txid, tx_pos: 0, value: 150_000, height: 800_000 }];
		return [];
	});
	mocks.getTxHex.mockImplementation(async (txid: string) => {
		if (txid === fund0.txid) return fund0.hex;
		if (txid === fund1.txid) return fund1.hex;
		throw new Error(`no such tx ${txid}`);
	});
	return { addr0: a0.address, addr1: a1.address };
}

async function seedWallet(email: string): Promise<{ userId: number; walletId: number }> {
	const user = await registerUser({ email, password: 'correct horse battery', displayName: 'u' });
	const w = createWallet(user.id, { name: 'W', xpub: ZPUB });
	return { userId: user.id, walletId: w.id };
}

/** A fully-signed single-sig PSBT over one coin on m/0/0, signed with the ZPRV
 *  (a wallet holds only the public xpub, so signing needs the private key) —
 *  mirrors transactions.test.ts's signedPsbt(). Persisted onto a transactions
 *  row so broadcastTransaction can finalize + broadcast it. Returns the row id
 *  and the resulting real txid an honest server echoes back. */
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
	raw.set([0x04, 0x88, 0xad, 0xe4], 0); // SLIP-132 zprv → xprv
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

// ── 1. Concurrent builds reserve disjoint coins (withLock('wallet:id')) ─────
describe('concurrent buildDraft coin reservation', () => {
	it('two sends fired together never select the same UTXO', async () => {
		const { userId, walletId } = await seedWallet('ss-build-race@example.com');
		wireTwoCoinWallet();

		const [r1, r2] = await Promise.all([
			buildDraft(userId, walletId, { recipients: [{ address: RECIPIENT, amount: 10_000 }], feeRate: 5 }),
			buildDraft(userId, walletId, { recipients: [{ address: RECIPIENT, amount: 10_000 }], feeRate: 5 })
		]);

		const keys1 = new Set(r1.details.inputs.map((i) => `${i.txid}:${i.vout}`));
		const keys2 = new Set(r2.details.inputs.map((i) => `${i.txid}:${i.vout}`));
		expect(keys1.size).toBeGreaterThan(0);
		expect(keys2.size).toBeGreaterThan(0);
		for (const k of keys2) expect(keys1.has(k)).toBe(false);
		expect(listTransactions(userId, walletId)!).toHaveLength(2);
	});
});

// ── 2. N-way concurrent broadcast → exactly one reaches the network ─────────
describe('concurrent broadcastTransaction (atomic claim)', () => {
	it('four simultaneous broadcasts: one completes, three refused, network hit once', async () => {
		const { userId, walletId } = await seedWallet('ss-bcast-storm@example.com');
		const { txId, txid: want } = await seedSignedDraft(walletId);

		// Honest server: echoes the real txid of whatever bytes it is handed. Only
		// the single claim-winner should ever reach it.
		mocks.broadcast.mockImplementation((rawHex: string) =>
			Promise.resolve(Transaction.fromRaw(hexToBytes(rawHex), { disableScriptCheck: true }).id)
		);

		const settled = await Promise.allSettled(
			Array.from({ length: 4 }, () => broadcastTransaction(userId, walletId, txId))
		);
		const fulfilled = settled.filter((s) => s.status === 'fulfilled');
		const rejected = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
		expect(fulfilled).toHaveLength(1);
		expect((fulfilled[0] as PromiseFulfilledResult<{ txid: string }>).value.txid).toBe(want);
		expect(rejected).toHaveLength(3);
		for (const r of rejected) expect(r.reason).toMatchObject({ code: 'already_sent' });
		expect(mocks.broadcast).toHaveBeenCalledTimes(1);
		expect(listTransactions(userId, walletId)!.find((t) => t.id === txId)!.status).toBe('completed');
	});
});

// ── 3. Mixed-actor interleave: build ‖ device-set ‖ read → consistent state ─
describe('mixed concurrent actors on one wallet', () => {
	it('A drafts a send while B sets the device and C reads — final state is consistent', async () => {
		const { userId, walletId } = await seedWallet('mixed-actor@example.com');
		wireTwoCoinWallet();

		const reads: (ReturnType<typeof getWallet>)[] = [];
		const [buildRes] = await Promise.all([
			// A: async, yields at every Electrum await.
			buildDraft(userId, walletId, { recipients: [{ address: RECIPIENT, amount: 10_000 }], feeRate: 5 }),
			// B: synchronous single-statement write, lands atomically between A's awaits.
			Promise.resolve().then(() => setWalletDevice(userId, walletId, 'trezor')),
			// C: synchronous reads interleaved with A/B — must never observe a torn row.
			...Array.from({ length: 5 }, () =>
				Promise.resolve().then(() => reads.push(getWallet(userId, walletId)))
			)
		]);

		// A's draft persisted exactly once.
		expect(listTransactions(userId, walletId)!).toHaveLength(1);
		expect(buildRes.draft.id).toBeTruthy();
		// B's write is durable and final.
		expect(getWallet(userId, walletId)!.device_type).toBe('trezor');
		// C never saw a partially-written wallet row: every read is a valid, whole
		// row for this wallet (device_type is either null-or-'trezor', never junk).
		for (const r of reads) {
			expect(r).not.toBeNull();
			expect(r!.id).toBe(walletId);
			expect([null, 'trezor']).toContain(r!.device_type);
		}
	});
});

// ── 4. Double wallet-create of one xpub → UNIQUE(user_id, xpub) wins ────────
describe('double-submit wallet creation', () => {
	it('the same xpub submitted twice creates exactly one wallet', async () => {
		const user = await registerUser({ email: 'dbl-create@example.com', password: 'correct horse battery', displayName: 'u' });
		const settled = await Promise.allSettled([
			Promise.resolve().then(() => createWallet(user.id, { name: 'One', xpub: ZPUB })),
			Promise.resolve().then(() => createWallet(user.id, { name: 'Two', xpub: ZPUB }))
		]);
		const fulfilled = settled.filter((s) => s.status === 'fulfilled');
		const rejected = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(String((rejected[0].reason as Error).message)).toMatch(/already imported/i);

		const count = (db.prepare('SELECT COUNT(*) AS n FROM wallets WHERE user_id = ?').get(user.id) as { n: number }).n;
		expect(count).toBe(1);
	});
});
