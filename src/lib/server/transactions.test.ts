import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HDKey } from '@scure/bip32';
import { base64, base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Transaction } from '@scure/btc-signer';
import { NETWORK } from '@scure/btc-signer';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { readDirtySince } from './walletSync';
import { constructPsbt, summarizePsbt, type SpendableUtxo } from './bitcoin/psbt';
import {
	listTransactions,
	getTransaction,
	updateTransaction,
	deleteTransaction,
	broadcastTransaction,
	bumpTransaction,
	normalizePsbt,
	InvalidPsbtError,
	BroadcastError,
	BumpError
} from './transactions';

// The broadcast/bump tests exercise the real service path up to the network
// edge; only the chain source itself is faked.
const { broadcastMock, getTxMock, getTxHexMock, broadcastPackageMock } = vi.hoisted(() => ({
	broadcastMock: vi.fn(),
	getTxMock: vi.fn(),
	getTxHexMock: vi.fn(),
	broadcastPackageMock: vi.fn()
}));
vi.mock('./chain', () => ({
	getChain: () => ({
		electrum: { broadcast: broadcastMock, broadcastPackage: broadcastPackageMock },
		getTx: getTxMock,
		getTxHex: getTxHexMock,
		getMinFeeRate: async () => 1
	})
}));

function wipe(): void {
	db.exec(
		'DELETE FROM transactions; DELETE FROM sessions; DELETE FROM wallets; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	broadcastMock.mockReset();
	getTxMock.mockReset();
	getTxHexMock.mockReset();
	broadcastPackageMock.mockReset();
	setSetting('registration_mode', 'open');
});

// ---- a real, fully signed PSBT (BIP84 documentation keys, not a real wallet)
const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const ZPRV =
	'zprvAWgYBBk7JR8Gjrh4UJQ2uJdG1r3WNRRfURiABBE3RvMXYSrRJL62XuezvGdPvG6GFBZduosCc1YP5wixPox7zhZLfiUm8aunE96BBa4Kei5';
const RECEIVE_0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'; // m/0/0
const CHANGE_0 = 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el'; // m/1/0
const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

let signedPsbtCache: string | null = null;
async function signedPsbt(): Promise<string> {
	if (signedPsbtCache) return signedPsbtCache;
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
	raw.set([0x04, 0x88, 0xad, 0xe4], 0); // rewrite SLIP-132 zprv → xprv
	const account = HDKey.fromExtendedKey(b58.encode(raw)).derive("m/84'/0'/0'");
	const tx = Transaction.fromPSBT(base64.decode(draft.psbtBase64));
	for (let i = 0; i < tx.inputsLength; i++) {
		const path = tx.getInput(i).bip32Derivation![0][1].path;
		tx.signIdx(account.deriveChild(path[3]).deriveChild(path[4]).privateKey!, i);
	}
	signedPsbtCache = base64.encode(tx.toPSBT());
	return signedPsbtCache;
}

/** The true txid of the fully-signed PSBT — what an honest server echoes back on
 *  broadcast (equals the locally-computed finalized.txid the code now verifies). */
async function signedTxid(): Promise<string> {
	const tx = Transaction.fromPSBT(base64.decode(await signedPsbt()));
	tx.finalize();
	return tx.id;
}

/** Simulates Bitcoin Core's descriptorprocesspsbt/walletprocesspsbt with their
 *  default `finalize=true`: the PSBT handed back already carries each input's
 *  final witness data, with partial_sig cleared (cairn QA F3). */
let finalizedByExternalSignerCache: string | null = null;
async function finalizedByExternalSigner(): Promise<string> {
	if (finalizedByExternalSignerCache) return finalizedByExternalSignerCache;
	const tx = Transaction.fromPSBT(base64.decode(await signedPsbt()));
	for (let i = 0; i < tx.inputsLength; i++) tx.finalizeIdx(i);
	finalizedByExternalSignerCache = base64.encode(tx.toPSBT());
	return finalizedByExternalSignerCache;
}

async function seedWallet(userEmail: string): Promise<{ userId: number; walletId: number }> {
	const user = await registerUser({ email: userEmail, password: 'correct horse battery', displayName: 'u' });
	const res = db
		.prepare(
			"INSERT INTO wallets (user_id, name, type, xpub, script_type) VALUES (?, 'W', 'xpub', ?, 'p2wpkh')"
		)
		.run(user.id, `xpub-${userEmail}`);
	return { userId: user.id, walletId: Number(res.lastInsertRowid) };
}

function seedTx(
	walletId: number,
	status: 'draft' | 'awaiting_signature' | 'completed' = 'draft',
	txid: string | null = null,
	psbt = 'cHNidP8='
): number {
	const res = db
		.prepare(
			`INSERT INTO transactions (wallet_id, status, psbt, txid, recipient, amount, fee, fee_rate)
			 VALUES (?, ?, ?, ?, 'bc1qexample', 1000, 200, 1.5)`
		)
		.run(walletId, status, psbt, txid);
	return Number(res.lastInsertRowid);
}

describe('transaction lifecycle', () => {
	it('scopes reads to the owning user', async () => {
		const alice = await seedWallet('alice@example.com');
		const bob = await seedWallet('bob@example.com');
		const txId = seedTx(alice.walletId);

		expect(getTransaction(alice.userId, alice.walletId, txId)).not.toBeNull();
		// Bob cannot read Alice's transaction through his own wallet id...
		expect(getTransaction(bob.userId, bob.walletId, txId)).toBeNull();
		// ...nor by naming Alice's wallet id with his user id.
		expect(getTransaction(bob.userId, alice.walletId, txId)).toBeNull();
		expect(listTransactions(bob.userId, alice.walletId)).toBeNull();
	});

	it('lists a wallet transactions newest first', async () => {
		const { userId, walletId } = await seedWallet('a@example.com');
		seedTx(walletId);
		seedTx(walletId);
		const list = listTransactions(userId, walletId);
		expect(list).toHaveLength(2);
		expect(list![0].id).toBeGreaterThan(list![1].id);
	});

	it('advances status and stores a signed PSBT', async () => {
		const { userId, walletId } = await seedWallet('a@example.com');
		const txId = seedTx(walletId);
		const updated = updateTransaction(userId, walletId, txId, {
			status: 'awaiting_signature',
			psbt: 'c2lnbmVk'
		});
		expect(updated?.status).toBe('awaiting_signature');
		expect(updated?.psbt).toBe('c2lnbmVk');
	});

	it('keeps completed transactions (not deletable)', async () => {
		const { userId, walletId } = await seedWallet('a@example.com');
		const draft = seedTx(walletId, 'draft');
		const done = seedTx(walletId, 'completed', 'ff'.repeat(32));

		expect(deleteTransaction(userId, walletId, draft)).toBe(true);
		expect(getTransaction(userId, walletId, draft)).toBeNull();

		expect(deleteTransaction(userId, walletId, done)).toBe(false);
		expect(getTransaction(userId, walletId, done)).not.toBeNull();
	});

	// cairn-up0q: the old check-then-delete raced broadcastTransaction's
	// atomic claim — a delete could land between the claim and the trailing
	// status='completed' update, wiping a row for a tx already on the
	// network. Simulate the claim directly (as broadcastTransaction's claim
	// UPDATE would leave it mid-flight) and assert the delete is refused.
	it('refuses to delete a transaction with an in-flight broadcast claim', async () => {
		const { userId, walletId } = await seedWallet('a@example.com');
		const txId = seedTx(walletId, 'awaiting_signature');
		db.prepare(
			"UPDATE transactions SET broadcast_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
		).run(txId);

		expect(deleteTransaction(userId, walletId, txId)).toBe(false);
		expect(getTransaction(userId, walletId, txId)).not.toBeNull();
	});

	// cairn-ytnc: the up0q guard above blocked on ANY non-null claim, including
	// one left by a broadcast that crashed mid-flight — broadcastTransaction
	// itself treats a claim older than 60s as reclaimable (a retry overwrites
	// it), but the delete guard didn't share that staleness window, wedging a
	// crashed draft undeletable forever. A stale claim must now allow deletion;
	// a fresh one (the test above) must still refuse it.
	it('allows deleting a transaction once its broadcast claim goes stale (>60s)', async () => {
		const { userId, walletId } = await seedWallet('a@example.com');
		const txId = seedTx(walletId, 'awaiting_signature');
		db.prepare(
			"UPDATE transactions SET broadcast_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 seconds') WHERE id = ?"
		).run(txId);

		expect(deleteTransaction(userId, walletId, txId)).toBe(true);
		expect(getTransaction(userId, walletId, txId)).toBeNull();
	});

	it('refuses to broadcast an already-broadcast transaction before touching the network', async () => {
		const { userId, walletId } = await seedWallet('a@example.com');
		const done = seedTx(walletId, 'completed', 'ab'.repeat(32));
		// The already-sent guard runs before any finalize/network call, so this
		// rejects deterministically with no chain access.
		await expect(broadcastTransaction(userId, walletId, done)).rejects.toMatchObject({
			code: 'already_sent'
		});
		expect(BroadcastError).toBeDefined();
	});

	it('refuses to broadcast an unknown transaction', async () => {
		const { userId, walletId } = await seedWallet('a@example.com');
		await expect(broadcastTransaction(userId, walletId, 99999)).rejects.toMatchObject({
			code: 'not_found'
		});
	});

	it('broadcasts a fully signed transaction and records the LOCALLY-computed txid', async () => {
		const { userId, walletId } = await seedWallet('a@example.com');
		const signed = await signedPsbt();
		const txId = seedTx(walletId, 'awaiting_signature', null, signed);
		// An honest server echoes back the real txid (the double-SHA256 of the tx
		// we sent). Recompute it here the same way finalizePsbt does.
		const expectedTxid = Transaction.fromPSBT(base64.decode(signed));
		expectedTxid.finalize();
		broadcastMock.mockResolvedValueOnce(expectedTxid.id);

		// cairn-g1u2: a successful broadcast spends a coin, so the wallet must be
		// marked dirty — the next send load then re-scans live rather than serving the
		// pre-spend snapshot from the clean-wallet fast path (the async watcher
		// notification for the status change may not have landed yet). Seed a CLEAN
		// snapshot row so the mark has something to flip.
		db.prepare(
			`INSERT INTO wallet_snapshots (wallet_kind, wallet_id, snapshot, summary, last_synced_at, dirty_since)
			 VALUES ('wallet', ?, '{}', NULL, ?, NULL)
			 ON CONFLICT(wallet_kind, wallet_id) DO UPDATE SET dirty_since = NULL, last_synced_at = excluded.last_synced_at`
		).run(walletId, Date.now());
		expect(readDirtySince('wallet', walletId)).toBeNull(); // clean before

		const { txid, transaction } = await broadcastTransaction(userId, walletId, txId);
		expect(txid).toBe(expectedTxid.id);
		expect(transaction.status).toBe('completed');
		expect(transaction.txid).toBe(expectedTxid.id);
		expect(broadcastMock).toHaveBeenCalledTimes(1);
		expect(readDirtySince('wallet', walletId)).not.toBeNull(); // dirty after
	});

	it('refuses to record a broadcast whose server-reported txid differs from ours (cairn-ziwm)', async () => {
		const { userId, walletId } = await seedWallet('a@example.com');
		const txId = seedTx(walletId, 'awaiting_signature', null, await signedPsbt());
		// A malicious/misbehaving server claims success with a txid it invented for a
		// broadcast it never performed.
		broadcastMock.mockResolvedValueOnce('cc'.repeat(32));

		await expect(broadcastTransaction(userId, walletId, txId)).rejects.toMatchObject({
			code: 'rejected'
		});
		// Nothing was recorded, and the claim was released so a retry is possible.
		const tx = getTransaction(userId, walletId, txId);
		expect(tx?.txid ?? null).toBeNull();
		expect(tx?.status).not.toBe('completed');
	});

	it('lets exactly one of two concurrent broadcasts through (atomic claim)', async () => {
		const { userId, walletId } = await seedWallet('a@example.com');
		const txId = seedTx(walletId, 'awaiting_signature', null, await signedPsbt());

		// First call claims the row and parks on the (unresolved) network send;
		// the second must lose the claim and get the friendly already-sent error
		// even though no txid has been written yet.
		const want = await signedTxid(); // the honest txid the server echoes back
		let resolveBroadcast!: (txid: string) => void;
		broadcastMock.mockImplementationOnce(
			() => new Promise<string>((res) => (resolveBroadcast = res))
		);
		const first = broadcastTransaction(userId, walletId, txId);
		const second = broadcastTransaction(userId, walletId, txId);
		await expect(second).rejects.toMatchObject({ code: 'already_sent' });

		resolveBroadcast(want);
		const winner = await first;
		expect(winner.txid).toBe(want);
		expect(broadcastMock).toHaveBeenCalledTimes(1);
		expect(getTransaction(userId, walletId, txId)?.status).toBe('completed');
	});

	it('releases the claim when broadcast fails, so the user can retry', async () => {
		const { userId, walletId } = await seedWallet('a@example.com');
		const txId = seedTx(walletId, 'awaiting_signature', null, await signedPsbt());

		broadcastMock.mockRejectedValueOnce(new Error('mempool full'));
		await expect(broadcastTransaction(userId, walletId, txId)).rejects.toMatchObject({
			code: 'rejected'
		});
		const afterFailure = getTransaction(userId, walletId, txId);
		expect(afterFailure?.txid).toBeNull();
		expect(afterFailure?.status).not.toBe('completed');

		// The row is NOT wedged: an immediate retry succeeds.
		const want = await signedTxid();
		broadcastMock.mockResolvedValueOnce(want);
		const retry = await broadcastTransaction(userId, walletId, txId);
		expect(retry.txid).toBe(want);
	});

	// cairn-kva0: prior coverage here only ever fed tryPackageRescue a
	// NON-rescuable rejection ('mempool full' above, which fails
	// PACKAGE_RESCUABLE_REJECTION's regex and returns null before ever touching
	// chain.getTx/getTxHex/broadcastPackage). This pins the actual rescue
	// SUCCESS path: a min-relay-fee rejection, an unconfirmed+fetchable parent,
	// and an Electrum server that accepts the [parent, child] package — the
	// broadcast must be recorded as completed with the (locally-computed, not
	// server-echoed) child txid, never surfacing the original rejection.
	it('rescues a min-relay-fee rejection via package relay and records the child txid as completed', async () => {
		const { userId, walletId } = await seedWallet('a@example.com');
		const txId = seedTx(walletId, 'awaiting_signature', null, await signedPsbt());
		const want = await signedTxid();
		const PARENT_TXID = '11'.repeat(32); // the fixture PSBT's one spent input

		broadcastMock.mockRejectedValueOnce(new Error('min relay fee not met'));
		getTxMock.mockResolvedValueOnce({ confirmed: false }); // the parent hasn't confirmed
		getTxHexMock.mockResolvedValueOnce('aa'.repeat(110)); // its raw hex, fetchable
		broadcastPackageMock.mockResolvedValueOnce({ accepted: true }); // server takes the package

		const { txid, transaction } = await broadcastTransaction(userId, walletId, txId);

		expect(txid).toBe(want);
		expect(transaction.status).toBe('completed');
		expect(transaction.txid).toBe(want);

		expect(getTxMock).toHaveBeenCalledWith(PARENT_TXID);
		expect(getTxHexMock).toHaveBeenCalledWith(PARENT_TXID);

		// Parent first, child (the just-rejected raw tx) last — dependency order.
		expect(broadcastPackageMock).toHaveBeenCalledTimes(1);
		const [rawTxHexes] = broadcastPackageMock.mock.calls[0] as [string[]];
		expect(rawTxHexes[0]).toBe('aa'.repeat(110));
		expect(rawTxHexes).toHaveLength(2);

		// The single standalone broadcast attempt, no separate direct rebroadcast.
		expect(broadcastMock).toHaveBeenCalledTimes(1);
	});

	it('does not attempt a package rescue for a non-rescuable rejection reason (regression guard: mempool full stays a plain rejection)', async () => {
		const { userId, walletId } = await seedWallet('a@example.com');
		const txId = seedTx(walletId, 'awaiting_signature', null, await signedPsbt());

		broadcastMock.mockRejectedValueOnce(new Error('mempool full'));
		await expect(broadcastTransaction(userId, walletId, txId)).rejects.toMatchObject({ code: 'rejected' });

		expect(getTxMock).not.toHaveBeenCalled();
		expect(broadcastPackageMock).not.toHaveBeenCalled();
	});

	it('rejects a corrupt signed PSBT with a plain corruption message, not the substitution guard', async () => {
		const { userId, walletId } = await seedWallet('a@example.com');
		const txId = seedTx(walletId, 'awaiting_signature', null, await signedPsbt());
		// Keep the magic bytes, drop the tail: recognizably a PSBT, unreadable.
		const corrupt = base64.encode(base64.decode(await signedPsbt()).slice(0, 20));

		const p = broadcastTransaction(userId, walletId, txId, corrupt);
		await expect(p).rejects.toMatchObject({ code: 'incomplete' });
		await expect(
			broadcastTransaction(userId, walletId, txId, corrupt)
		).rejects.toThrow(/truncated or corrupted/);
		expect(broadcastMock).not.toHaveBeenCalled();
	});

	// cairn QA F3: Core's descriptorprocesspsbt/walletprocesspsbt default
	// finalize=true — the PSBT they hand back has NO partial_sig, only final
	// witness data. The old unconditional tx.finalize() crashed on this with
	// "Not enough partial sign"; finalizePsbt() now passes already-finalized
	// inputs through instead of re-finalizing them.
	it('broadcasts a PSBT already finalized by an external signer (Bitcoin Core default finalize=true)', async () => {
		const { userId, walletId } = await seedWallet('a@example.com');
		const finalized = await finalizedByExternalSigner();
		const txId = seedTx(walletId, 'awaiting_signature', null, finalized);
		const want = await signedTxid();
		broadcastMock.mockResolvedValueOnce(want);

		const { txid, transaction } = await broadcastTransaction(userId, walletId, txId);
		expect(txid).toBe(want);
		expect(transaction.status).toBe('completed');
		expect(broadcastMock).toHaveBeenCalledTimes(1);
	});

	// cairn QA R7 B4 sub-case 1: several drafts built from IDENTICAL inputs,
	// recipient, amount and fee rate (the exact shape the coin-reservation race
	// produces before its fix) sign to the byte-identical transaction
	// (deterministic ECDSA). Broadcasting each individually used to return 200
	// OK and mark EVERY row 'completed' with the one real txid — N "sends" on
	// record for a single transfer. Now only the first completes; the rest are
	// recorded as duplicates and never touch the network.
	it('broadcasting several identical drafts yields one completed row and marks the rest duplicates', async () => {
		const { userId, walletId } = await seedWallet('dup@example.com');
		const signed = await signedPsbt();
		const want = await signedTxid();
		const txIds = [
			seedTx(walletId, 'awaiting_signature', null, signed),
			seedTx(walletId, 'awaiting_signature', null, signed),
			seedTx(walletId, 'awaiting_signature', null, signed)
		];
		broadcastMock.mockResolvedValueOnce(want); // only the first draft should ever call this

		const first = await broadcastTransaction(userId, walletId, txIds[0]);
		expect(first.txid).toBe(want);
		expect(first.transaction.status).toBe('completed');
		expect(first.duplicate).toBeFalsy();

		for (const txId of txIds.slice(1)) {
			const dup = await broadcastTransaction(userId, walletId, txId);
			expect(dup.duplicate).toBe(true);
			expect(dup.txid).toBe(want);
			expect(dup.transaction.status).toBe('superseded');
			expect(dup.transaction.txid).toBe(want);
			expect(dup.message).toMatch(/duplicat/i);
		}

		// Only the FIRST draft ever reached the network — the rest short-circuited.
		expect(broadcastMock).toHaveBeenCalledTimes(1);

		// History integrity: exactly one completed row, the rest superseded
		// (kept for the record, never deletable), all pointing at the ONE real
		// txid — never N "successful" completed sends for a single transfer.
		const all = listTransactions(userId, walletId)!;
		expect(all.filter((t) => t.status === 'completed')).toHaveLength(1);
		expect(all.filter((t) => t.status === 'superseded')).toHaveLength(2);
		expect(new Set(all.filter((t) => t.txid).map((t) => t.txid))).toEqual(new Set([want]));
		for (const txId of txIds.slice(1)) {
			expect(deleteTransaction(userId, walletId, txId)).toBe(false); // kept, not erasable
		}
	});

	it('gives an accurate, non-raw-library message when a PSBT genuinely lacks a signature', async () => {
		const { userId, walletId } = await seedWallet('a@example.com');
		// Same single-UTXO shape as signedPsbt(), just never signed.
		const draft = await constructPsbt({
			xpub: ZPUB,
			utxos: [
				{ txid: '11'.repeat(32), vout: 0, value: 60_000, height: 800_000, address: RECEIVE_0, chain: 0, index: 0 }
			],
			recipients: [{ address: RECIPIENT, amount: 30_000 }],
			feeRate: 5,
			changeAddress: CHANGE_0,
			changeIndex: 0,
			origin: { fingerprint: '73c5da0a', path: "m/84'/0'/0'" }
		});
		const txId = seedTx(walletId, 'awaiting_signature', null, draft.psbtBase64);

		let caught: unknown;
		try {
			await broadcastTransaction(userId, walletId, txId);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(BroadcastError);
		const err = caught as BroadcastError;
		expect(err.code).toBe('incomplete');
		expect(err.message).toMatch(/1 of 1 input still needs a signature/);
		expect(err.message).not.toMatch(/partial sign/i); // never btc-signer's raw exception text
		expect(broadcastMock).not.toHaveBeenCalled();
	});

	it('removes transactions when their wallet is deleted (cascade)', async () => {
		const { userId, walletId } = await seedWallet('a@example.com');
		const txId = seedTx(walletId);
		db.prepare('DELETE FROM wallets WHERE id = ?').run(walletId);
		expect(
			db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE id = ?').get(txId)
		).toMatchObject({ n: 0 });
		void userId;
	});
});

describe('batch row storage (recipients column)', () => {
	it('round-trips a batch recipient breakdown through the recipients JSON column', async () => {
		const { userId, walletId } = await seedWallet('batch@example.com');
		const recipients = [
			{ address: RECIPIENT, amount: 20_000 },
			{ address: 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', amount: 30_000 }
		];
		// Stored the way buildDraft stores batch rows: recipient = first address,
		// amount = total, full breakdown in the JSON column.
		const res = db
			.prepare(
				`INSERT INTO transactions (wallet_id, status, psbt, recipient, amount, fee, fee_rate, recipients)
				 VALUES (?, 'draft', 'cHNidP8=', ?, ?, 500, 5, ?)`
			)
			.run(walletId, recipients[0].address, 50_000, JSON.stringify(recipients));

		const tx = getTransaction(userId, walletId, Number(res.lastInsertRowid));
		expect(tx).not.toBeNull();
		expect(tx!.recipients).toEqual(recipients);
		expect(tx!.recipient).toBe(recipients[0].address);
		expect(tx!.amount).toBe(50_000);
	});

	it('derives a length-1 recipients array for single-recipient rows (NULL column)', async () => {
		const { userId, walletId } = await seedWallet('single@example.com');
		const txId = seedTx(walletId); // seedTx never touches the recipients column
		const tx = getTransaction(userId, walletId, txId);
		expect(tx!.recipients).toEqual([{ address: 'bc1qexample', amount: 1000 }]);
	});

	it('falls back to the single-recipient shape when the JSON column is garbage', async () => {
		const { userId, walletId } = await seedWallet('garbage@example.com');
		const res = db
			.prepare(
				`INSERT INTO transactions (wallet_id, status, psbt, recipient, amount, fee, fee_rate, recipients)
				 VALUES (?, 'draft', 'cHNidP8=', 'bc1qexample', 1000, 200, 1.5, 'not json')`
			)
			.run(walletId);
		const tx = getTransaction(userId, walletId, Number(res.lastInsertRowid));
		expect(tx!.recipients).toEqual([{ address: 'bc1qexample', amount: 1000 }]);
	});
});

describe('normalizePsbt', () => {
	it('round-trips a valid PSBT in base64 and hex forms', async () => {
		const valid = await signedPsbt();
		expect(normalizePsbt(valid)).toBe(valid);
		expect(normalizePsbt(bytesToHex(base64.decode(valid)))).toBe(valid);
	});

	it('rejects a truncated PSBT with a corruption message before the guard runs', async () => {
		const bytes = base64.decode(await signedPsbt());
		const corrupt = base64.encode(bytes.slice(0, 20)); // magic intact, body gone
		expect(() => normalizePsbt(corrupt)).toThrow(InvalidPsbtError);
		expect(() => normalizePsbt(corrupt)).toThrow(/truncated or corrupted/);
		// Hex form of the same corruption fails the same way.
		expect(() => normalizePsbt(bytesToHex(bytes.slice(0, 20)))).toThrow(/truncated or corrupted/);
	});

	it('still rejects things that are not PSBTs at all', () => {
		expect(() => normalizePsbt('')).toThrow();
		expect(() => normalizePsbt('definitely not a psbt')).toThrow();
		expect(() => normalizePsbt(base64.encode(new TextEncoder().encode('hello world')))).toThrow();
	});
});

describe('bumpTransaction (RBF fee bumping)', () => {
	/**
	 * A synthetic previous transaction with a REAL txid (display-order hex), so
	 * the replacement's nonWitnessUtxo fetch passes hash verification.
	 */
	function fundingTx(outputs: { address: string; value: number }[]): { hex: string; txid: string } {
		const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
		tx.addInput({ txid: '00'.repeat(32), index: 0 });
		for (const o of outputs) tx.addOutputAddress(o.address, BigInt(o.value), NETWORK);
		return { hex: tx.hex, txid: tx.id };
	}
	const FUND = fundingTx([{ address: RECEIVE_0, value: 100_000 }]);
	const ORIGINAL_TXID = 'ab'.repeat(32);

	function accountKey(): HDKey {
		const b58 = base58check(sha256);
		const raw = b58.decode(ZPRV);
		raw.set([0x04, 0x88, 0xad, 0xe4], 0); // rewrite SLIP-132 zprv → xprv
		return HDKey.fromExtendedKey(b58.encode(raw)).derive("m/84'/0'/0'");
	}

	/** A wallet whose xpub is real (bump re-derives the change address from it). */
	async function seedRealWallet(email: string): Promise<{ userId: number; walletId: number }> {
		const user = await registerUser({ email, password: 'correct horse battery', displayName: 'u' });
		const res = db
			.prepare(
				`INSERT INTO wallets (user_id, name, type, xpub, script_type, master_fingerprint, derivation_path)
				 VALUES (?, 'W', 'xpub', ?, 'p2wpkh', ?, ?)`
			)
			.run(user.id, ZPUB, '73c5da0a', "m/84'/0'/0'");
		return { userId: user.id, walletId: Number(res.lastInsertRowid) };
	}

	/** A Cairn-built, already-broadcast original: RBF-signaling, with change. */
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
		return { txId: Number(res.lastInsertRowid), txid: ORIGINAL_TXID, details };
	}

	beforeEach(() => {
		// Defaults: the original is still unconfirmed, and prev-tx fetches for
		// the replacement's nonWitnessUtxo resolve from the funding tx.
		getTxMock.mockResolvedValue({ confirmed: false });
		getTxHexMock.mockResolvedValue(FUND.hex);
	});

	it('builds a replacement spending identical inputs with the same recipient and amount', async () => {
		const { userId, walletId } = await seedRealWallet('rbf@example.com');
		const orig = await seedBroadcastOriginal(walletId);

		const { draft, details } = await bumpTransaction(userId, walletId, orig.txId, 25);

		expect(draft.status).toBe('draft');
		expect(draft.replacesTxid).toBe(orig.txid);
		expect(draft.recipient).toBe(RECIPIENT);
		expect(draft.amount).toBe(30_000);

		// Identical input set — the two transactions necessarily conflict.
		expect(details.inputs.map((i) => `${i.txid}:${i.vout}`)).toEqual(
			orig.details.inputs.map((i) => `${i.txid}:${i.vout}`)
		);
		// The recipient output is untouched; the entire fee delta comes out of
		// change (value conservation over the same inputs).
		const summary = summarizePsbt(details.psbtBase64);
		expect(summary.outputs).toContainEqual({ address: RECIPIENT, value: 30_000 });
		expect(details.change).not.toBeNull();
		expect(details.change!.address).toBe(CHANGE_0);
		expect(orig.details.change!.value - details.change!.value).toBe(details.fee - orig.details.fee);
		// And the replacement clears the BIP-125 rule-4 floor.
		expect(details.fee).toBeGreaterThanOrEqual(orig.details.fee + details.vsize);
	});

	it('bumps a batch original preserving every recipient output', async () => {
		const { userId, walletId } = await seedRealWallet('rbf-batch@example.com');
		const RECIPIENT_2 = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';
		const recipients = [
			{ address: RECIPIENT, amount: 20_000 },
			{ address: RECIPIENT_2, amount: 10_000 }
		];
		const details = await constructPsbt({
			xpub: ZPUB,
			utxos: [
				{ txid: FUND.txid, vout: 0, value: 100_000, height: 800_000, address: RECEIVE_0, chain: 0, index: 0 }
			],
			recipients,
			feeRate: 5,
			changeAddress: CHANGE_0,
			changeIndex: 0,
			origin: { fingerprint: '73c5da0a', path: "m/84'/0'/0'" },
			fetchRawTx: async () => FUND.hex
		});
		const res = db
			.prepare(
				`INSERT INTO transactions (wallet_id, status, psbt, txid, recipient, amount, fee, fee_rate, change_index, recipients)
				 VALUES (?, 'completed', ?, ?, ?, ?, ?, ?, 0, ?)`
			)
			.run(
				walletId,
				details.psbtBase64,
				'ba'.repeat(32),
				details.recipient,
				details.amount,
				details.fee,
				details.feeRate,
				JSON.stringify(details.recipients)
			);
		const txId = Number(res.lastInsertRowid);

		const { draft, details: bumped } = await bumpTransaction(userId, walletId, txId, 25);
		// The stored breakdown drives the replacement: both outputs survive intact.
		expect(draft.recipients).toEqual(recipients);
		expect(draft.amount).toBe(30_000);
		const summary = summarizePsbt(bumped.psbtBase64);
		expect(summary.outputs).toContainEqual({ address: RECIPIENT, value: 20_000 });
		expect(summary.outputs).toContainEqual({ address: RECIPIENT_2, value: 10_000 });
		// The fee delta comes out of change, as with single-recipient bumps.
		expect(bumped.change).not.toBeNull();
		expect(details.change!.value - bumped.change!.value).toBe(bumped.fee - details.fee);
	});

	it('rejects a fee rate at or below the original effective rate', async () => {
		const { userId, walletId } = await seedRealWallet('rbf@example.com');
		const orig = await seedBroadcastOriginal(walletId);
		const origRate = getTransaction(userId, walletId, orig.txId)!.feeRate;

		await expect(bumpTransaction(userId, walletId, orig.txId, origRate)).rejects.toMatchObject({
			code: 'fee_too_low'
		});
		await expect(bumpTransaction(userId, walletId, orig.txId, origRate - 1)).rejects.toThrow(
			/higher than the original/
		);
	});

	it('enforces the BIP-125 rule-4 absolute fee minimum (old fee + vsize sats)', async () => {
		const { userId, walletId } = await seedRealWallet('rbf@example.com');
		const orig = await seedBroadcastOriginal(walletId);
		const origRate = getTransaction(userId, walletId, orig.txId)!.feeRate;

		// Marginally above the original's rate: passes the rate check but cannot
		// pay the original fee plus 1 sat/vB of the replacement's own size.
		const p = bumpTransaction(userId, walletId, orig.txId, origRate + 0.3);
		await expect(p).rejects.toMatchObject({ code: 'fee_too_low' });
		await expect(
			bumpTransaction(userId, walletId, orig.txId, origRate + 0.3)
		).rejects.toThrow(/original fee plus 1 sat\/vB/);
	});

	it('rejects when change cannot absorb the higher fee', async () => {
		const { userId, walletId } = await seedRealWallet('rbf@example.com');
		const orig = await seedBroadcastOriginal(walletId);
		// change ≈ 69k sats; at 500 sat/vB the fee (~73k) overruns it.
		await expect(bumpTransaction(userId, walletId, orig.txId, 500)).rejects.toMatchObject({
			code: 'insufficient_funds'
		});
	});

	it('rejects an original that does not signal RBF', async () => {
		const { userId, walletId } = await seedRealWallet('rbf@example.com');
		// Hand-built with default (0xffffffff) sequences — like rows created
		// before Cairn started setting RBF_SEQUENCE on every input.
		const legacy = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
		legacy.addInput({ txid: FUND.txid, index: 0 });
		legacy.addOutputAddress(RECIPIENT, 30_000n, NETWORK);
		const res = db
			.prepare(
				`INSERT INTO transactions (wallet_id, status, psbt, txid, recipient, amount, fee, fee_rate, change_index)
				 VALUES (?, 'completed', ?, ?, ?, 30000, 700, 5, 0)`
			)
			.run(walletId, base64.encode(legacy.toPSBT()), 'cd'.repeat(32), RECIPIENT);
		const txId = Number(res.lastInsertRowid);

		await expect(bumpTransaction(userId, walletId, txId, 25)).rejects.toMatchObject({
			code: 'not_rbf'
		});
		await expect(bumpTransaction(userId, walletId, txId, 25)).rejects.toThrow(
			/doesn't signal RBF/
		);
	});

	it('rejects an already-confirmed original', async () => {
		const { userId, walletId } = await seedRealWallet('rbf@example.com');
		const orig = await seedBroadcastOriginal(walletId);
		getTxMock.mockResolvedValue({ confirmed: true });
		await expect(bumpTransaction(userId, walletId, orig.txId, 25)).rejects.toMatchObject({
			code: 'confirmed'
		});
	});

	it('rejects non-broadcast rows, superseded rows, and duplicate replacements', async () => {
		const { userId, walletId } = await seedRealWallet('rbf@example.com');
		const draftRow = seedTx(walletId, 'draft');
		await expect(bumpTransaction(userId, walletId, draftRow, 25)).rejects.toMatchObject({
			code: 'not_bumpable'
		});
		await expect(bumpTransaction(userId, walletId, 99_999, 25)).rejects.toMatchObject({
			code: 'not_found'
		});

		const orig = await seedBroadcastOriginal(walletId);
		await bumpTransaction(userId, walletId, orig.txId, 25);
		// A live replacement draft already points at this txid.
		await expect(bumpTransaction(userId, walletId, orig.txId, 30)).rejects.toMatchObject({
			code: 'already_replaced'
		});
		// Once marked superseded, the row itself refuses further bumps.
		db.prepare("UPDATE transactions SET status = 'superseded' WHERE id = ?").run(orig.txId);
		await expect(bumpTransaction(userId, walletId, orig.txId, 30)).rejects.toMatchObject({
			code: 'superseded'
		});
		expect(BumpError).toBeDefined();
	});

	it('marks the original superseded when the replacement broadcasts', async () => {
		const { userId, walletId } = await seedRealWallet('rbf@example.com');
		const orig = await seedBroadcastOriginal(walletId);
		const { draft } = await bumpTransaction(userId, walletId, orig.txId, 25);

		// Sign the replacement the way a hardware wallet would, via the
		// embedded derivation paths.
		const account = accountKey();
		const tx = Transaction.fromPSBT(base64.decode(draft.psbt));
		for (let i = 0; i < tx.inputsLength; i++) {
			const path = tx.getInput(i).bip32Derivation![0][1].path;
			tx.signIdx(account.deriveChild(path[3]).deriveChild(path[4]).privateKey!, i);
		}

		const signedReplacement = base64.encode(tx.toPSBT());
		// Honest server echoes back the real txid of the replacement we broadcast.
		const wantReplaced = Transaction.fromPSBT(base64.decode(signedReplacement));
		wantReplaced.finalize();
		broadcastMock.mockResolvedValueOnce(wantReplaced.id);
		const { transaction } = await broadcastTransaction(
			userId,
			walletId,
			draft.id,
			signedReplacement
		);
		expect(transaction.status).toBe('completed');
		expect(transaction.txid).toBe(wantReplaced.id);
		// The replaced original leaves the 'completed' pool but stays on record.
		expect(getTransaction(userId, walletId, orig.txId)?.status).toBe('superseded');
		expect(deleteTransaction(userId, walletId, orig.txId)).toBe(false);
	});
});
