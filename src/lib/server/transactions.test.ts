import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HDKey } from '@scure/bip32';
import { base64, base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Transaction } from '@scure/btc-signer';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { constructPsbt, type SpendableUtxo } from './bitcoin/psbt';
import {
	listTransactions,
	getTransaction,
	updateTransaction,
	deleteTransaction,
	broadcastTransaction,
	normalizePsbt,
	InvalidPsbtError,
	BroadcastError
} from './transactions';

// The broadcast tests exercise the real service path up to the network edge;
// only Electrum itself is faked.
const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }));
vi.mock('./chain', () => ({
	getChain: () => ({ electrum: { broadcast: broadcastMock } })
}));

function wipe(): void {
	db.exec(
		'DELETE FROM transactions; DELETE FROM sessions; DELETE FROM wallets; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	broadcastMock.mockReset();
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
