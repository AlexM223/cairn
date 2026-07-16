// Coverage for txOwnership()'s speedUpWallet field (cairn-cqch) — the explorer
// tx-detail page's "Speed this up" CTA reads this to decide whether to show a
// link into the wallet-detail page's existing RBF/CPFP flow. The field is read
// straight off each wallet/multisig snapshot's already-computed `speedUp` list
// (detectUnconfirmedInflows' output) — this locks in that it's a passthrough,
// not a re-derivation, and that the multisig-viewer exclusion (mirroring the
// multisig detail page's own `role !== 'viewer'` gate on the same button) holds.

import { describe, it, expect } from 'vitest';
import { db } from '$lib/server/db';
import { txOwnership } from './ownership.server';
import type { WalletTx, WalletAddress, TxDetail } from '$lib/types';
import type { UnconfirmedInflow } from '$lib/server/transactions';
import type { MultisigScanAddress, MultisigTx } from '$lib/server/multisigScan';

// Unique user ids per case: the ownership index memoizes per userId for a few
// seconds, so reusing an id across cases could serve a stale build.
let nextUid = 390_000;
function freshUid(label: string): number {
	const id = ++nextUid;
	db.prepare(
		"INSERT INTO users (id, email, password_hash, display_name, is_admin) VALUES (?, ?, NULL, ?, 0)"
	).run(id, `speedup-ownership-${id}@example.test`, label);
	return id;
}

let xpubSeq = 0;
function seedWallet(
	userId: number,
	opts: { txs?: WalletTx[]; addresses?: WalletAddress[]; speedUp?: UnconfirmedInflow[] } = {}
): number {
	const walletId = Number(
		db
			.prepare(
				"INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'Test wallet', ?, 'p2wpkh')"
			)
			.run(userId, `xpub-speedup-${xpubSeq++}`).lastInsertRowid
	);
	const snapshot = {
		scan: { addresses: opts.addresses ?? [], txs: opts.txs ?? [], confirmed: 0, unconfirmed: 0 },
		receive: null,
		coinbaseUtxos: [],
		tipHeight: 800_000,
		maturingTotal: 0,
		speedUp: opts.speedUp ?? [],
		scanError: null
	};
	db.prepare(
		`INSERT INTO wallet_snapshots (wallet_kind, wallet_id, snapshot, summary, last_synced_at)
		 VALUES ('wallet', ?, ?, NULL, ?)`
	).run(walletId, JSON.stringify(snapshot), Date.now());
	return walletId;
}

let keySeq = 0;
function seedMultisig(
	ownerId: number,
	opts: { addresses?: MultisigScanAddress[]; history?: MultisigTx[]; speedUp?: UnconfirmedInflow[] } = {}
): number {
	const multisigId = Number(
		db
			.prepare(
				"INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, ?, 2, 'p2wsh')"
			)
			.run(ownerId, `Test multisig ${keySeq}`).lastInsertRowid
	);
	for (let i = 0; i < 3; i++) {
		db.prepare(
			`INSERT INTO multisig_keys (multisig_id, position, name, category, xpub, fingerprint, path)
			 VALUES (?, ?, ?, 'hardware', ?, '00000000', 'm/48h/0h/0h/2h')`
		).run(multisigId, i, `Key ${i}`, `xpub-msig-speedup-${keySeq++}`);
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
		maturingTotal: 0,
		speedUp: opts.speedUp ?? [],
		scanError: null
	};
	db.prepare(
		`INSERT INTO wallet_snapshots (wallet_kind, wallet_id, snapshot, summary, last_synced_at)
		 VALUES ('multisig', ?, ?, NULL, ?)`
	).run(multisigId, JSON.stringify(snapshot), Date.now());
	return multisigId;
}

function shareWith(
	multisigId: number,
	ownerId: number,
	sharedWithId: number,
	role: 'viewer' | 'cosigner'
): void {
	db.prepare(
		`INSERT INTO multisig_shares (multisig_id, owner_id, shared_with_id, role) VALUES (?, ?, ?, ?)`
	).run(multisigId, ownerId, sharedWithId, role);
}

function walletTx(over: Partial<WalletTx> & { txid: string }): WalletTx {
	return { height: 0, time: 1_700_000_000, delta: 1000, fee: 200, ...over };
}

function multisigTx(over: Partial<MultisigTx> & { txid: string }): MultisigTx {
	return { height: 0, time: 1_700_000_000, delta: 1000, fee: 200, ...over };
}

function inflow(over: Partial<UnconfirmedInflow> & { txid: string }): UnconfirmedInflow {
	return {
		ours: true,
		trust: 'own-change',
		signalsRbf: true,
		ourValueSats: 5000,
		vouts: [0],
		action: 'rbf',
		parentFeeUnknown: false,
		...over
	};
}

/** Minimal well-formed TxDetail — txOwnership only reads txid/vin/vout. */
function mkTx(over: Partial<TxDetail> & { txid: string }): TxDetail {
	return {
		confirmed: false,
		blockHeight: null,
		blockHash: null,
		blockTime: null,
		confirmations: 0,
		size: 200,
		vsize: 150,
		weight: 600,
		fee: 300,
		feeRate: 2,
		locktime: 0,
		version: 2,
		segwit: true,
		rbf: true,
		vin: [],
		vout: [],
		...over
	};
}

describe('txOwnership — speedUpWallet (cairn-cqch)', () => {
	it('is null for a tx that touches none of the viewer\'s wallets (public explorer surface)', () => {
		const uid = freshUid('No Wallets');
		const txid = 'a'.repeat(64);
		const result = txOwnership(uid, mkTx({ txid }));
		expect(result).toBeNull();
	});

	it('is null when the tx is owned but not in the wallet\'s speedUp list (e.g. confirmed, or no spendable coin on it)', () => {
		const uid = freshUid('Owned Not Eligible');
		const txid = 'b'.repeat(64);
		seedWallet(uid, { txs: [walletTx({ txid, height: 800_100 })], speedUp: [] });

		const result = txOwnership(uid, mkTx({ txid, confirmed: true, confirmations: 3 }));
		expect(result).not.toBeNull();
		expect(result!.wallets).toHaveLength(1);
		expect(result!.speedUpWallet).toBeNull();
	});

	it('surfaces the owning single-sig wallet when its snapshot flags the tx as speed-up eligible', () => {
		const uid = freshUid('Owned Eligible');
		const txid = 'c'.repeat(64);
		const walletId = seedWallet(uid, {
			txs: [walletTx({ txid, height: 0 })],
			speedUp: [inflow({ txid, action: 'rbf' })]
		});

		const result = txOwnership(uid, mkTx({ txid }));
		expect(result!.speedUpWallet).not.toBeNull();
		expect(result!.speedUpWallet!.kind).toBe('wallet');
		expect(result!.speedUpWallet!.id).toBe(walletId);
		expect(result!.speedUpWallet!.href).toBe(`/wallets/${walletId}`);
	});

	it('is null for a CPFP-only inflow whose parent fee is unknown (cairn-iare — deterministically unbumpable, don\'t link to a dead control)', () => {
		const uid = freshUid('Owned CPFP Fee Unknown');
		const txid = 'c1'.padEnd(64, '0');
		seedWallet(uid, {
			txs: [walletTx({ txid, height: 0 })],
			speedUp: [inflow({ txid, action: 'cpfp', parentFeeUnknown: true })]
		});

		const result = txOwnership(uid, mkTx({ txid }));
		expect(result!.speedUpWallet).toBeNull();
	});

	it('surfaces the owning multisig (owner role) when its snapshot flags the tx as eligible', () => {
		const owner = freshUid('Msig Owner Eligible');
		const txid = 'd'.repeat(64);
		const multisigId = seedMultisig(owner, {
			history: [multisigTx({ txid, height: 0 })],
			speedUp: [inflow({ txid, action: 'cpfp' })]
		});

		const result = txOwnership(owner, mkTx({ txid }));
		expect(result!.speedUpWallet).not.toBeNull();
		expect(result!.speedUpWallet!.kind).toBe('multisig');
		expect(result!.speedUpWallet!.id).toBe(multisigId);
		expect(result!.speedUpWallet!.href).toBe(`/wallets/multisig/${multisigId}`);
	});

	it('excludes a multisig VIEWER share even when the snapshot flags the tx as eligible (mirrors the detail page\'s own role gate)', () => {
		const owner = freshUid('Msig Owner V');
		const viewer = freshUid('Msig Viewer V');
		const txid = 'e'.repeat(64);
		const multisigId = seedMultisig(owner, {
			history: [multisigTx({ txid, height: 0 })],
			speedUp: [inflow({ txid })]
		});
		shareWith(multisigId, owner, viewer, 'viewer');

		const ownerResult = txOwnership(owner, mkTx({ txid }));
		const viewerResult = txOwnership(viewer, mkTx({ txid }));
		expect(ownerResult!.speedUpWallet).not.toBeNull();
		expect(viewerResult!.wallets).toHaveLength(1); // still "yours" — just can't act
		expect(viewerResult!.speedUpWallet).toBeNull();
	});

	it('includes a multisig COSIGNER share (cosigners can act, unlike viewers)', () => {
		const owner = freshUid('Msig Owner Co');
		const cosigner = freshUid('Msig Cosigner Co');
		const txid = 'f'.repeat(64);
		const multisigId = seedMultisig(owner, {
			history: [multisigTx({ txid, height: 0 })],
			speedUp: [inflow({ txid })]
		});
		shareWith(multisigId, owner, cosigner, 'cosigner');

		const result = txOwnership(cosigner, mkTx({ txid }));
		expect(result!.speedUpWallet).not.toBeNull();
		expect(result!.speedUpWallet!.id).toBe(multisigId);
	});

	it('never leaks a speed-up match into another user\'s ownership boundary', () => {
		const owner = freshUid('SpeedUp Owner');
		const outsider = freshUid('SpeedUp Outsider');
		const txid = 'a1'.repeat(32);
		seedWallet(owner, { txs: [walletTx({ txid, height: 0 })], speedUp: [inflow({ txid })] });

		expect(txOwnership(outsider, mkTx({ txid }))).toBeNull();
		expect(txOwnership(owner, mkTx({ txid }))!.speedUpWallet).not.toBeNull();
	});
});
