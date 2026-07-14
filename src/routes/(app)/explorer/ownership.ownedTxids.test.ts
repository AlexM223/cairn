import { describe, it, expect } from 'vitest';
import { db } from '$lib/server/db';
import { ownedTxids } from './ownership.server';
import type { WalletTx, WalletAddress } from '$lib/types';

// Unique user ids per case: the ownership index memoizes per userId for a few
// seconds, so reusing an id across cases could serve a stale build. Distinct
// ids keep every assertion reading a freshly-built index.
let nextUid = 190_000;
function freshUid(): number {
	const id = ++nextUid;
	db.prepare(
		"INSERT INTO users (id, email, password_hash, display_name, is_admin) VALUES (?, ?, NULL, 'OwnedTxids Test', 0)"
	).run(id, `ownedtxids-${id}@example.test`);
	return id;
}

let xpubSeq = 0;
function seedWallet(userId: number, txs: WalletTx[], addresses: WalletAddress[] = []): number {
	const walletId = Number(
		db
			.prepare(
				"INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'Test wallet', ?, 'p2wpkh')"
			)
			.run(userId, `xpub-ownedtxids-${xpubSeq++}`).lastInsertRowid
	);
	const snapshot = {
		scan: { addresses, txs, confirmed: 0, unconfirmed: 0 },
		receive: null,
		coinbaseUtxos: [],
		tipHeight: 800_000,
		maturingTotal: 0,
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
	return { height: 800_000, time: 1_700_000_000, delta: 1000, fee: 200, ...over };
}

describe('ownedTxids', () => {
	it('returns an empty set for an anonymous viewer (no chain call, no throw)', () => {
		expect(ownedTxids(undefined, ['a'.repeat(64)])).toEqual(new Set());
	});

	it('returns an empty set for an empty txid list', () => {
		const uid = freshUid();
		expect(ownedTxids(uid, [])).toEqual(new Set());
	});

	it('matches only txids that belong to the viewer\'s own wallets', () => {
		const uid = freshUid();
		const mine = 'a'.repeat(64);
		const notMine = 'b'.repeat(64);
		seedWallet(uid, [tx({ txid: mine })]);
		const result = ownedTxids(uid, [mine, notMine]);
		expect(result.has(mine)).toBe(true);
		expect(result.has(notMine)).toBe(false);
		expect(result.size).toBe(1);
	});

	it('never leaks a match into another user\'s ownership boundary', () => {
		const ownerUid = freshUid();
		const viewerUid = freshUid();
		const txid = 'c'.repeat(64);
		seedWallet(ownerUid, [tx({ txid })]);
		expect(ownedTxids(viewerUid, [txid]).has(txid)).toBe(false);
		expect(ownedTxids(ownerUid, [txid]).has(txid)).toBe(true);
	});

	it('handles multiple wallets and multiple matching txids', () => {
		const uid = freshUid();
		const t1 = 'd'.repeat(64);
		const t2 = 'e'.repeat(64);
		const t3 = 'f'.repeat(64);
		seedWallet(uid, [tx({ txid: t1 })]);
		seedWallet(uid, [tx({ txid: t2 })]);
		const result = ownedTxids(uid, [t1, t2, t3]);
		expect([...result].sort()).toEqual([t1, t2].sort());
	});
});
