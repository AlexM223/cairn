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
const { broadcastMock, getTxMock, getTxHexMock } = vi.hoisted(() => ({
	broadcastMock: vi.fn(),
	getTxMock: vi.fn(),
	getTxHexMock: vi.fn()
}));
vi.mock('./chain', () => ({
	getChain: () => ({
		electrum: { broadcast: broadcastMock },
		getTx: getTxMock,
		getTxHex: getTxHexMock
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
		recipient: RECIPIENT,
		amount: 30_000,
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

function seedWallet(userEmail: string): { userId: number; walletId: number } {
	const user = registerUser({ email: userEmail, password: 'correct horse battery', displayName: 'u' });
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
	it('scopes reads to the owning user', () => {
		const alice = seedWallet('alice@example.com');
		const bob = seedWallet('bob@example.com');
		const txId = seedTx(alice.walletId);

		expect(getTransaction(alice.userId, alice.walletId, txId)).not.toBeNull();
		// Bob cannot read Alice's transaction through his own wallet id...
		expect(getTransaction(bob.userId, bob.walletId, txId)).toBeNull();
		// ...nor by naming Alice's wallet id with his user id.
		expect(getTransaction(bob.userId, alice.walletId, txId)).toBeNull();
		expect(listTransactions(bob.userId, alice.walletId)).toBeNull();
	});

	it('lists a wallet transactions newest first', () => {
		const { userId, walletId } = seedWallet('a@example.com');
		seedTx(walletId);
		seedTx(walletId);
		const list = listTransactions(userId, walletId);
		expect(list).toHaveLength(2);
		expect(list![0].id).toBeGreaterThan(list![1].id);
	});

	it('advances status and stores a signed PSBT', () => {
		const { userId, walletId } = seedWallet('a@example.com');
		const txId = seedTx(walletId);
		const updated = updateTransaction(userId, walletId, txId, {
			status: 'awaiting_signature',
			psbt: 'c2lnbmVk'
		});
		expect(updated?.status).toBe('awaiting_signature');
		expect(updated?.psbt).toBe('c2lnbmVk');
	});

	it('keeps completed transactions (not deletable)', () => {
		const { userId, walletId } = seedWallet('a@example.com');
		const draft = seedTx(walletId, 'draft');
		const done = seedTx(walletId, 'completed', 'ff'.repeat(32));

		expect(deleteTransaction(userId, walletId, draft)).toBe(true);
		expect(getTransaction(userId, walletId, draft)).toBeNull();

		expect(deleteTransaction(userId, walletId, done)).toBe(false);
		expect(getTransaction(userId, walletId, done)).not.toBeNull();
	});

	it('refuses to broadcast an already-broadcast transaction before touching the network', async () => {
		const { userId, walletId } = seedWallet('a@example.com');
		const done = seedTx(walletId, 'completed', 'ab'.repeat(32));
		// The already-sent guard runs before any finalize/network call, so this
		// rejects deterministically with no chain access.
		await expect(broadcastTransaction(userId, walletId, done)).rejects.toMatchObject({
			code: 'already_sent'
		});
		expect(BroadcastError).toBeDefined();
	});

	it('refuses to broadcast an unknown transaction', async () => {
		const { userId, walletId } = seedWallet('a@example.com');
		await expect(broadcastTransaction(userId, walletId, 99999)).rejects.toMatchObject({
			code: 'not_found'
		});
	});

	it('broadcasts a fully signed transaction and records the txid', async () => {
		const { userId, walletId } = seedWallet('a@example.com');
		const txId = seedTx(walletId, 'awaiting_signature', null, await signedPsbt());
		broadcastMock.mockResolvedValueOnce('cc'.repeat(32));

		const { txid, transaction } = await broadcastTransaction(userId, walletId, txId);
		expect(txid).toBe('cc'.repeat(32));
		expect(transaction.status).toBe('completed');
		expect(transaction.txid).toBe('cc'.repeat(32));
		expect(broadcastMock).toHaveBeenCalledTimes(1);
	});

	it('lets exactly one of two concurrent broadcasts through (atomic claim)', async () => {
		const { userId, walletId } = seedWallet('a@example.com');
		const txId = seedTx(walletId, 'awaiting_signature', null, await signedPsbt());

		// First call claims the row and parks on the (unresolved) network send;
		// the second must lose the claim and get the friendly already-sent error
		// even though no txid has been written yet.
		let resolveBroadcast!: (txid: string) => void;
		broadcastMock.mockImplementationOnce(
			() => new Promise<string>((res) => (resolveBroadcast = res))
		);
		const first = broadcastTransaction(userId, walletId, txId);
		const second = broadcastTransaction(userId, walletId, txId);
		await expect(second).rejects.toMatchObject({ code: 'already_sent' });

		resolveBroadcast('dd'.repeat(32));
		const winner = await first;
		expect(winner.txid).toBe('dd'.repeat(32));
		expect(broadcastMock).toHaveBeenCalledTimes(1);
		expect(getTransaction(userId, walletId, txId)?.status).toBe('completed');
	});

	it('releases the claim when broadcast fails, so the user can retry', async () => {
		const { userId, walletId } = seedWallet('a@example.com');
		const txId = seedTx(walletId, 'awaiting_signature', null, await signedPsbt());

		broadcastMock.mockRejectedValueOnce(new Error('mempool full'));
		await expect(broadcastTransaction(userId, walletId, txId)).rejects.toMatchObject({
			code: 'rejected'
		});
		const afterFailure = getTransaction(userId, walletId, txId);
		expect(afterFailure?.txid).toBeNull();
		expect(afterFailure?.status).not.toBe('completed');

		// The row is NOT wedged: an immediate retry succeeds.
		broadcastMock.mockResolvedValueOnce('ee'.repeat(32));
		const retry = await broadcastTransaction(userId, walletId, txId);
		expect(retry.txid).toBe('ee'.repeat(32));
	});

	it('rejects a corrupt signed PSBT with a plain corruption message, not the substitution guard', async () => {
		const { userId, walletId } = seedWallet('a@example.com');
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

	it('removes transactions when their wallet is deleted (cascade)', () => {
		const { userId, walletId } = seedWallet('a@example.com');
		const txId = seedTx(walletId);
		db.prepare('DELETE FROM wallets WHERE id = ?').run(walletId);
		expect(
			db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE id = ?').get(txId)
		).toMatchObject({ n: 0 });
		void userId;
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

	/** A Cairn-built, already-broadcast original: RBF-signaling, with change. */
	async function seedBroadcastOriginal(walletId: number, feeRate = 5) {
		const details = await constructPsbt({
			xpub: ZPUB,
			utxos: [
				{ txid: FUND.txid, vout: 0, value: 100_000, height: 800_000, address: RECEIVE_0, chain: 0, index: 0 }
			],
			recipient: RECIPIENT,
			amount: 30_000,
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
		const { userId, walletId } = seedRealWallet('rbf@example.com');
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

	it('rejects a fee rate at or below the original effective rate', async () => {
		const { userId, walletId } = seedRealWallet('rbf@example.com');
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
		const { userId, walletId } = seedRealWallet('rbf@example.com');
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
		const { userId, walletId } = seedRealWallet('rbf@example.com');
		const orig = await seedBroadcastOriginal(walletId);
		// change ≈ 69k sats; at 500 sat/vB the fee (~73k) overruns it.
		await expect(bumpTransaction(userId, walletId, orig.txId, 500)).rejects.toMatchObject({
			code: 'insufficient_funds'
		});
	});

	it('rejects an original that does not signal RBF', async () => {
		const { userId, walletId } = seedRealWallet('rbf@example.com');
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
		const { userId, walletId } = seedRealWallet('rbf@example.com');
		const orig = await seedBroadcastOriginal(walletId);
		getTxMock.mockResolvedValue({ confirmed: true });
		await expect(bumpTransaction(userId, walletId, orig.txId, 25)).rejects.toMatchObject({
			code: 'confirmed'
		});
	});

	it('rejects non-broadcast rows, superseded rows, and duplicate replacements', async () => {
		const { userId, walletId } = seedRealWallet('rbf@example.com');
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
		const { userId, walletId } = seedRealWallet('rbf@example.com');
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

		broadcastMock.mockResolvedValueOnce('ee'.repeat(32));
		const { transaction } = await broadcastTransaction(
			userId,
			walletId,
			draft.id,
			base64.encode(tx.toPSBT())
		);
		expect(transaction.status).toBe('completed');
		expect(transaction.txid).toBe('ee'.repeat(32));
		// The replaced original leaves the 'completed' pool but stays on record.
		expect(getTransaction(userId, walletId, orig.txId)?.status).toBe('superseded');
		expect(deleteTransaction(userId, walletId, orig.txId)).toBe(false);
	});
});
