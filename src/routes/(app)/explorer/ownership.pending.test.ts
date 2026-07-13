import { describe, it, expect } from 'vitest';
import { db } from '$lib/server/db';
import { viewerPendingTxs } from './ownership.server';
import type { WalletTx, WalletAddress } from '$lib/types';

// Unique user ids per case: viewerPendingTxs memoizes its index per userId for a
// few seconds, so reusing an id across cases could serve a stale build. Distinct
// ids keep every assertion reading a freshly-built index.
let nextUid = 90_000;
function freshUid(): number {
	const id = ++nextUid;
	// wallets.user_id has a FK to users.id — seed the owning user row.
	db.prepare(
		"INSERT INTO users (id, email, password_hash, display_name, is_admin) VALUES (?, ?, NULL, 'Pending Test', 0)"
	).run(id, `pending-${id}@example.test`);
	return id;
}

let xpubSeq = 0;
function seedWallet(userId: number, txs: WalletTx[], addresses: WalletAddress[] = []): number {
	const walletId = Number(
		db
			.prepare(
				"INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'Test wallet', ?, 'p2wpkh')"
			)
			.run(userId, `xpub-pending-${xpubSeq++}`).lastInsertRowid
	);
	const snapshot = {
		scan: { addresses, txs, confirmed: 0, unconfirmed: 0 },
		receive: null,
		coinbaseUtxos: [],
		tipHeight: 800_000,
		speedUp: [],
		scanError: null
	};
	db.prepare(
		`INSERT INTO wallet_snapshots (wallet_kind, wallet_id, snapshot, summary, last_synced_at)
		 VALUES ('wallet', ?, ?, NULL, ?)`
	).run(walletId, JSON.stringify(snapshot), Date.now());
	return walletId;
}

function tx(over: Partial<WalletTx> & { txid: string }): WalletTx {
	return { height: 0, time: 1_700_000_000, delta: 1000, fee: 200, ...over };
}

describe('viewerPendingTxs', () => {
	it('returns [] for an anonymous viewer (no chain call, no throw)', () => {
		expect(viewerPendingTxs(undefined)).toEqual([]);
	});

	it('returns only unconfirmed txs (height 0 or -1), never confirmed ones', () => {
		const uid = freshUid();
		seedWallet(uid, [
			tx({ txid: 'a'.repeat(64), height: 0 }),
			tx({ txid: 'b'.repeat(64), height: -1 }),
			tx({ txid: 'c'.repeat(64), height: 799_999 }) // confirmed
		]);
		const pending = viewerPendingTxs(uid);
		expect(pending.map((p) => p.txid).sort()).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
	});

	it('carries the amount, fee and owning wallet through honestly', () => {
		const uid = freshUid();
		const walletId = seedWallet(uid, [
			tx({ txid: 'd'.repeat(64), height: 0, delta: -50_000, fee: 1234 })
		]);
		const [p] = viewerPendingTxs(uid);
		expect(p.delta).toBe(-50_000);
		expect(p.fee).toBe(1234);
		expect(p.wallet.id).toBe(walletId);
		expect(p.wallet.kind).toBe('wallet');
		expect(p.wallet.href).toBe(`/wallets/${walletId}`);
	});

	it('orders newest first by first-seen time', () => {
		const uid = freshUid();
		seedWallet(uid, [
			tx({ txid: 'e'.repeat(64), height: 0, time: 1000 }),
			tx({ txid: 'f'.repeat(64), height: 0, time: 3000 }),
			tx({ txid: '1'.repeat(64), height: 0, time: 2000 })
		]);
		expect(viewerPendingTxs(uid).map((p) => p.time)).toEqual([3000, 2000, 1000]);
	});

	it('dedupes a txid that appears in two of the viewer\'s wallets', () => {
		const uid = freshUid();
		const shared = '2'.repeat(64);
		seedWallet(uid, [tx({ txid: shared, height: 0 })]);
		seedWallet(uid, [tx({ txid: shared, height: 0 })]);
		const pending = viewerPendingTxs(uid);
		expect(pending.filter((p) => p.txid === shared)).toHaveLength(1);
	});

	it('honors the limit', () => {
		const uid = freshUid();
		const many: WalletTx[] = Array.from({ length: 20 }, (_, i) =>
			tx({ txid: String(i).padStart(64, '0'), height: 0, time: 1000 + i })
		);
		seedWallet(uid, many);
		expect(viewerPendingTxs(uid, 5)).toHaveLength(5);
	});
});
