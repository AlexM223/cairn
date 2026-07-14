// Multisig-path coverage for ownership.server.ts (cairn-a3fw). The single-sig
// branch of buildIndex() already had coverage (ownership.ownedTxids.test.ts,
// ownership.pending.test.ts); the multisig branch — viewableMultisigsStmt,
// readMultisigSnapshot, snap.detail.addresses/history — was previously only
// typecheck-verified (per the bead's own close note: "multisig path
// typecheck-only — visual QA pending"). This exercises it directly against a
// real seeded multisig + multisig_shares row, matching the single-sig
// fixtures' shape/conventions.

import { describe, it, expect } from 'vitest';
import { db } from '$lib/server/db';
import {
	addressOwnership,
	ownedTxids,
	ownedBlockHeights,
	ownedTxsInBlock,
	viewerPendingTxs
} from './ownership.server';
import type { MultisigScanAddress, MultisigTx } from '$lib/server/multisigScan';

// Unique user ids per case: the ownership index memoizes per userId for a few
// seconds, so reusing an id across cases could serve a stale build.
let nextUid = 290_000;
function freshUid(label: string): number {
	const id = ++nextUid;
	db.prepare(
		"INSERT INTO users (id, email, password_hash, display_name, is_admin) VALUES (?, ?, NULL, ?, 0)"
	).run(id, `msig-ownership-${id}@example.test`, label);
	return id;
}

let keySeq = 0;

/** Seed a multisig owned by `ownerId`, with the given confirmed/pending
 *  addresses + history persisted as its snapshot (mirrors the single-sig
 *  seedWallet fixtures' shape). */
function seedMultisig(
	ownerId: number,
	opts: { addresses?: MultisigScanAddress[]; history?: MultisigTx[] } = {}
): number {
	const multisigId = Number(
		db
			.prepare(
				"INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, ?, 2, 'p2wsh')"
			)
			.run(ownerId, `Test multisig ${keySeq}`).lastInsertRowid
	);
	// multisig_keys has no direct bearing on ownership.server.ts's lookup, but
	// keep the fixture minimally realistic (a threshold-2 multisig needs keys).
	for (let i = 0; i < 3; i++) {
		db.prepare(
			`INSERT INTO multisig_keys (multisig_id, position, name, category, xpub, fingerprint, path)
			 VALUES (?, ?, ?, 'hardware', ?, '00000000', 'm/48h/0h/0h/2h')`
		).run(multisigId, i, `Key ${i}`, `xpub-msig-${keySeq++}`);
	}

	const snapshot = {
		detail: {
			balance: { confirmed: 0, unconfirmed: 0 },
			addresses: opts.addresses ?? [],
			history: opts.history ?? [],
			utxoCount: 0
		},
		receive: null,
		coinbaseUtxos: [],
		tipHeight: 800_000,
		speedUp: [],
		scanError: null
	};
	db.prepare(
		`INSERT INTO wallet_snapshots (wallet_kind, wallet_id, snapshot, summary, last_synced_at)
		 VALUES ('multisig', ?, ?, NULL, ?)`
	).run(multisigId, JSON.stringify(snapshot), Date.now());
	return multisigId;
}

function shareWith(multisigId: number, ownerId: number, sharedWithId: number, role: 'viewer' | 'cosigner' = 'viewer'): void {
	db.prepare(
		`INSERT INTO multisig_shares (multisig_id, owner_id, shared_with_id, role) VALUES (?, ?, ?, ?)`
	).run(multisigId, ownerId, sharedWithId, role);
}

function addr(over: Partial<MultisigScanAddress> & { address: string }): MultisigScanAddress {
	return { chain: 0, index: 0, used: true, balance: 0, txCount: 1, ...over };
}

function tx(over: Partial<MultisigTx> & { txid: string }): MultisigTx {
	return { height: 800_000, time: 1_700_000_000, delta: 1000, fee: 200, ...over };
}

describe('ownership.server.ts — multisig path (cairn-a3fw)', () => {
	it('addressOwnership badges a multisig receive address for its owner, with href to the multisig detail page', () => {
		const owner = freshUid('Msig Owner A');
		const address = 'bcrt1qmultisigreceive';
		const multisigId = seedMultisig(owner, { addresses: [addr({ address, chain: 0 })] });

		const result = addressOwnership(owner, address);
		expect(result).not.toBeNull();
		expect(result!.wallet.kind).toBe('multisig');
		expect(result!.wallet.id).toBe(multisigId);
		expect(result!.wallet.href).toBe(`/wallets/multisig/${multisigId}`);
		expect(result!.change).toBe(false);
	});

	it('addressOwnership flags a multisig CHANGE address (chain:1) as change:true', () => {
		const owner = freshUid('Msig Owner B');
		const address = 'bcrt1qmultisigchange';
		seedMultisig(owner, { addresses: [addr({ address, chain: 1 })] });

		const result = addressOwnership(owner, address);
		expect(result!.change).toBe(true);
	});

	it('a share recipient (viewer role) sees the multisig as theirs; a stranger does not', () => {
		const owner = freshUid('Msig Owner C');
		const viewer = freshUid('Msig Viewer C');
		const stranger = freshUid('Msig Stranger C');
		const address = 'bcrt1qmultisigshared';
		const multisigId = seedMultisig(owner, { addresses: [addr({ address })] });
		shareWith(multisigId, owner, viewer, 'viewer');

		expect(addressOwnership(viewer, address)?.wallet.id).toBe(multisigId);
		expect(addressOwnership(stranger, address)).toBeNull();
	});

	it('a cosigner-role share also grants ownership visibility (same access predicate as getViewableMultisig)', () => {
		const owner = freshUid('Msig Owner D');
		const cosigner = freshUid('Msig Cosigner D');
		const address = 'bcrt1qmultisigcosigner';
		const multisigId = seedMultisig(owner, { addresses: [addr({ address })] });
		shareWith(multisigId, owner, cosigner, 'cosigner');

		expect(addressOwnership(cosigner, address)?.wallet.id).toBe(multisigId);
	});

	it('ownedBlockHeights / ownedTxsInBlock surface a confirmed multisig tx at its block height', () => {
		const owner = freshUid('Msig Owner E');
		const txid = 'a1'.repeat(32);
		const height = 800_123;
		seedMultisig(owner, { history: [tx({ txid, height, delta: 25_000 })] });

		expect(ownedBlockHeights(owner).has(height)).toBe(true);
		const inBlock = ownedTxsInBlock(owner, height);
		expect(inBlock).toHaveLength(1);
		expect(inBlock[0]).toMatchObject({ txid, delta: 25_000 });
		expect(inBlock[0].wallet.kind).toBe('multisig');
	});

	it('ownedTxids matches a multisig-owned txid and excludes an unrelated one', () => {
		const owner = freshUid('Msig Owner F');
		const mine = 'b2'.repeat(32);
		const notMine = 'c3'.repeat(32);
		seedMultisig(owner, { history: [tx({ txid: mine })] });

		const result = ownedTxids(owner, [mine, notMine]);
		expect(result.has(mine)).toBe(true);
		expect(result.has(notMine)).toBe(false);
	});

	it('viewerPendingTxs surfaces an unconfirmed multisig tx (height <= 0) for the "your pending txs" band', () => {
		const owner = freshUid('Msig Owner G');
		const txid = 'd4'.repeat(32);
		const multisigId = seedMultisig(owner, {
			history: [tx({ txid, height: 0, delta: -5_000, fee: 300 })]
		});

		const pending = viewerPendingTxs(owner);
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ txid, delta: -5_000, fee: 300 });
		expect(pending[0].wallet.id).toBe(multisigId);
		expect(pending[0].wallet.kind).toBe('multisig');
	});

	it('never leaks a multisig-owner match into another user\'s ownership boundary', () => {
		const owner = freshUid('Msig Owner H');
		const outsider = freshUid('Msig Outsider H');
		const txid = 'e5'.repeat(32);
		seedMultisig(owner, { history: [tx({ txid })] });

		expect(ownedTxids(outsider, [txid]).has(txid)).toBe(false);
		expect(ownedTxids(owner, [txid]).has(txid)).toBe(true);
	});
});
