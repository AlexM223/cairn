import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import {
	listTransactions,
	getTransaction,
	updateTransaction,
	deleteTransaction,
	broadcastTransaction,
	BroadcastError
} from './transactions';

function wipe(): void {
	db.exec(
		'DELETE FROM transactions; DELETE FROM sessions; DELETE FROM wallets; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

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
	txid: string | null = null
): number {
	const res = db
		.prepare(
			`INSERT INTO transactions (wallet_id, status, psbt, txid, recipient, amount, fee, fee_rate)
			 VALUES (?, ?, 'cHNidP8=', ?, 'bc1qexample', 1000, 200, 1.5)`
		)
		.run(walletId, status, txid);
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
