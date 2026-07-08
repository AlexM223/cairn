// Regression test for cairn-xkpd: the collaborative-custody access gates
// (getViewableMultisig / getSignableMultisig / listSharedMultisigs /
// multisigAccessRole / redactMultisigKeysForViewer) must actually surface a
// shared wallet to the user it was shared with. The bug this guards against was
// not a logic error in these functions — it was that NOTHING called them, so a
// cosigner saw {multisigs:[]} and got 404 on the wallet by id. These assertions
// exercise the exact functions the routes now call.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import {
	getViewableMultisig,
	getSignableMultisig,
	type MultisigKeyRow
} from './wallets/multisig';
import {
	shareMultisig,
	listSharedMultisigs,
	multisigAccessRole,
	redactMultisigKeysForViewer
} from './multisigShares';
import {
	getMultisigTransaction,
	listMultisigTransactions,
	listMultisigTransactionSummaries
} from './multisigTransactions';

function wipe(): void {
	db.exec(
		'DELETE FROM multisig_transactions; DELETE FROM multisig_shares; DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM contacts; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

async function makeUser(email: string): Promise<number> {
	return (
		await registerUser({
			email,
			password: 'correct horse battery',
			displayName: email.split('@')[0]
		})
	).id;
}

/** An accepted, bidirectional contact relationship (what shareMultisig requires). */
function befriend(a: number, b: number): void {
	db.prepare(
		"INSERT INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, 'accepted')"
	).run(a, b);
}

/** A 2-of-2 multisig owned by ownerId with two keys; returns ids. */
function makeMultisig(ownerId: number): { msId: number; keyIds: number[] } {
	const msId = Number(
		db
			.prepare('INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, ?, 2, ?)')
			.run(ownerId, 'Family vault', 'p2wsh').lastInsertRowid
	);
	const keyIds = [0, 1].map((i) =>
		Number(
			db
				.prepare(
					'INSERT INTO multisig_keys (multisig_id, position, name, category, xpub, fingerprint, path) VALUES (?, ?, ?, ?, ?, ?, ?)'
				)
				.run(msId, i, `Key ${i}`, 'hardware', `xpub${i}`, `0000000${i}`, `m/48'/0'/0'/2'/${i}`)
				.lastInsertRowid
		)
	);
	return { msId, keyIds };
}

describe('collaborative custody access gates (cairn-xkpd)', () => {
	it('a wallet is invisible/inaccessible until it is shared', async () => {
		const owner = await makeUser('owner@example.com');
		const outsider = await makeUser('outsider@example.com');
		const { msId } = makeMultisig(owner);

		// Owner sees it; a non-participant sees nothing and gets null (→ 404) by id.
		expect(getViewableMultisig(owner, msId)).not.toBeNull();
		expect(getViewableMultisig(outsider, msId)).toBeNull();
		expect(getSignableMultisig(outsider, msId)).toBeNull();
		expect(listSharedMultisigs(outsider)).toEqual([]);
		expect(multisigAccessRole(outsider, msId)).toBeNull();
	});

	it('a cosigner can see AND sign a wallet shared with them', async () => {
		const owner = await makeUser('owner@example.com');
		const bob = await makeUser('bob@example.com');
		const { msId, keyIds } = makeMultisig(owner);
		befriend(owner, bob);

		shareMultisig(owner, msId, bob, 'cosigner', [keyIds[1]]);

		// Visible on Bob's own list, tagged with the role and the owner's name.
		const shared = listSharedMultisigs(bob);
		expect(shared).toHaveLength(1);
		expect(shared[0]).toMatchObject({ multisigId: msId, role: 'cosigner', ownerName: 'owner' });

		// Reachable by id through both the read and the sign gate.
		expect(getViewableMultisig(bob, msId)?.id).toBe(msId);
		expect(getSignableMultisig(bob, msId)?.id).toBe(msId);
		expect(multisigAccessRole(bob, msId)).toBe('cosigner');
	});

	it('a viewer can see but NOT sign a wallet shared with them', async () => {
		const owner = await makeUser('owner@example.com');
		const carol = await makeUser('carol@example.com');
		const { msId } = makeMultisig(owner);
		befriend(owner, carol);

		shareMultisig(owner, msId, carol, 'viewer');

		expect(getViewableMultisig(carol, msId)?.id).toBe(msId);
		// The sign gate rejects a pure viewer — they never reach the send flow.
		expect(getSignableMultisig(carol, msId)).toBeNull();
		expect(multisigAccessRole(carol, msId)).toBe('viewer');
	});

	it('a viewer cannot fetch a saved transaction (raw PSBT) — only the summary (cairn-o1dp.1)', async () => {
		const owner = await makeUser('owner@example.com');
		const bob = await makeUser('bob@example.com');
		const carol = await makeUser('carol@example.com');
		const { msId, keyIds } = makeMultisig(owner);
		befriend(owner, bob);
		befriend(owner, carol);
		shareMultisig(owner, msId, bob, 'cosigner', [keyIds[1]]);
		shareMultisig(owner, msId, carol, 'viewer');

		// An in-flight, unbroadcast draft with its (secret-bearing) PSBT.
		const txId = Number(
			db
				.prepare(
					`INSERT INTO multisig_transactions
					   (multisig_id, status, psbt, recipient, amount, fee, fee_rate)
					 VALUES (?, 'awaiting_signature', 'cHNidP8BAF4CAAAAAA==', 'bc1qexample', 100000, 500, 5)`
				)
				.run(msId).lastInsertRowid
		);

		// Owner and cosigner get the full shape (detail, list) — the PSBT rides along.
		for (const uid of [owner, bob]) {
			expect(getMultisigTransaction(uid, msId, txId)?.psbt).toBe('cHNidP8BAF4CAAAAAA==');
			expect(listMultisigTransactions(uid, msId)).toHaveLength(1);
		}

		// A pure viewer is denied on the full-shape functions (→ 404 on the detail,
		// file-download, and list routes built on them)...
		expect(getMultisigTransaction(carol, msId, txId)).toBeNull();
		expect(listMultisigTransactions(carol, msId)).toBeNull();

		// ...but keeps the PSBT-free overview summary.
		const summaries = listMultisigTransactionSummaries(carol, msId);
		expect(summaries).toHaveLength(1);
		expect(summaries![0]).toEqual({ id: txId, txid: null, status: 'awaiting_signature', feeRate: 5 });
		expect(JSON.stringify(summaries)).not.toContain('cHNidP8');

		// A non-participant sees nothing at any tier.
		const outsider = await makeUser('outsider@example.com');
		expect(getMultisigTransaction(outsider, msId, txId)).toBeNull();
		expect(listMultisigTransactionSummaries(outsider, msId)).toBeNull();
	});

	it('redacts other keys’ paths for a cosigner but reveals their own', async () => {
		const owner = await makeUser('owner@example.com');
		const bob = await makeUser('bob@example.com');
		const { msId, keyIds } = makeMultisig(owner);
		befriend(owner, bob);
		shareMultisig(owner, msId, bob, 'cosigner', [keyIds[1]]);

		const keys = getViewableMultisig(bob, msId)!.keys;
		const redacted = redactMultisigKeysForViewer(keys, bob, owner);
		const byId = (id: number) => redacted.find((k: MultisigKeyRow) => k.id === id)!;

		// Bob keeps his own assigned key's path; the other key's path is stripped.
		expect(byId(keyIds[1]).path).not.toBe('');
		expect(byId(keyIds[0]).path).toBe('');

		// The owner sees everything unredacted.
		const ownerView = redactMultisigKeysForViewer(keys, owner, owner);
		expect(ownerView.every((k) => k.path !== '')).toBe(true);
	});
});
