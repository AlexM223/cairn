import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import {
	freezeRosterAndNotify,
	reconcileRoster,
	getRoster,
	notifySignSessionComplete
} from './multisigRoster';
import type { MultisigRow, MultisigKeyRow } from './wallets/multisig';
import type { SavedMultisigTransaction } from './multisigTransactions';
import type { MultisigSigningProgress } from './bitcoin/multisigPsbt';

function wipe(): void {
	db.exec(
		'DELETE FROM multisig_transaction_signers; DELETE FROM multisig_transactions; DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM events; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

/** A real multisigs row + its multisig_transactions row (FKs are enforced), and
 *  a MultisigRow object whose keys carry the given assignments. */
function scenario(ownerId: number, keys: { fp: string; path: string; assignedUserId: number | null }[]) {
	const msId = Number(
		db
			.prepare('INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, ?, 2, ?)')
			.run(ownerId, 'Shared vault', 'p2wsh').lastInsertRowid
	);
	const keyRows: MultisigKeyRow[] = keys.map((k, i) => {
		const id = Number(
			db
				.prepare(
					'INSERT INTO multisig_keys (multisig_id, position, name, category, xpub, fingerprint, path, assigned_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
				)
				.run(msId, i, `Key ${i}`, 'hardware', `xpub${i}`, k.fp, k.path, k.assignedUserId).lastInsertRowid
		);
		return {
			id,
			multisigId: msId,
			position: i,
			name: `Key ${i}`,
			category: 'hardware',
			deviceType: null,
			xpub: `xpub${i}`,
			fingerprint: k.fp,
			path: k.path,
			assignedUserId: k.assignedUserId
		};
	});
	const multisig: MultisigRow = {
		id: msId,
		userId: ownerId,
		name: 'Shared vault',
		threshold: 2,
		scriptType: 'p2wsh',
		receiveCursor: 0,
		createdAt: '2026-01-01T00:00:00.000Z',
		keys: keyRows
	};
	const txId = Number(
		db
			.prepare(
				"INSERT INTO multisig_transactions (multisig_id, status, psbt, recipient, amount, fee, fee_rate) VALUES (?, 'draft', 'psbt', 'bc1qx', 1000, 100, 1.0)"
			)
			.run(msId).lastInsertRowid
	);
	const tx = { id: txId, multisigId: msId } as SavedMultisigTransaction;
	return { multisig, tx };
}

function progressFor(multisig: MultisigRow, signedKeyIndexes: number[]): MultisigSigningProgress {
	return {
		required: multisig.threshold,
		collected: signedKeyIndexes.length,
		complete: signedKeyIndexes.length >= multisig.threshold,
		keys: multisig.keys.map((k, i) => ({
			fingerprint: k.fingerprint,
			path: k.path,
			signed: signedKeyIndexes.includes(i)
		})),
		signedFingerprints: [],
		remainingFingerprints: [],
		inputCount: 1
	};
}

describe('multisig sign-session roster', () => {
	it('freezes the roster as {owner} ∪ {assigned users} and notifies everyone but the creator', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		const { multisig, tx } = scenario(alice.id, [
			{ fp: 'aaaaaaaa', path: "m/48'/0'/0'/2'", assignedUserId: alice.id },
			{ fp: 'bbbbbbbb', path: "m/48'/0'/0'/2'", assignedUserId: bob.id },
			{ fp: 'cccccccc', path: "m/48'/0'/0'/2'", assignedUserId: null }
		]);

		freezeRosterAndNotify(multisig, tx, alice.id);

		const members = db
			.prepare('SELECT user_id FROM multisig_transaction_signers WHERE transaction_id = ? ORDER BY user_id')
			.all(tx.id)
			.map((r) => (r as { user_id: number }).user_id);
		expect(members.sort()).toEqual([alice.id, bob.id].sort());

		// Bob (a non-creator roster member) got a sign_session_waiting event; Alice
		// (the creator) did not.
		const bobEvents = db
			.prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND type = 'sign_session_waiting'")
			.get(bob.id) as { n: number };
		const aliceEvents = db
			.prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND type = 'sign_session_waiting'")
			.get(alice.id) as { n: number };
		expect(bobEvents.n).toBe(1);
		expect(aliceEvents.n).toBe(0);
	});

	it('reconciles has_signed from real PSBT progress: a cosigner whose key is signed shows signed', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		const { multisig, tx } = scenario(alice.id, [
			{ fp: 'aaaaaaaa', path: "m/48'/0'/0'/2'", assignedUserId: alice.id },
			{ fp: 'bbbbbbbb', path: "m/48'/0'/0'/2'", assignedUserId: bob.id }
		]);
		freezeRosterAndNotify(multisig, tx, alice.id);

		// Only Bob's key (index 1) is signed so far.
		const status = reconcileRoster(multisig, tx, progressFor(multisig, [1]));
		expect(status.signedBy).toContain(bob.id);
		expect(status.waitingOn).toContain(alice.id);

		const view = getRoster(multisig, tx, progressFor(multisig, [1]));
		expect(view.find((m) => m.userId === bob.id)?.hasSigned).toBe(true);
		expect(view.find((m) => m.userId === alice.id)?.hasSigned).toBe(false);
		expect(view.find((m) => m.userId === alice.id)?.isOwner).toBe(true);
	});

	it('credits the owner the unassigned "remaining" keys when reconciling', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		// Alice owns but holds no explicitly-assigned key; key 0 is unassigned
		// (hers to sign), key 1 is Bob's.
		const { multisig, tx } = scenario(alice.id, [
			{ fp: 'aaaaaaaa', path: "m/48'/0'/0'/2'", assignedUserId: null },
			{ fp: 'bbbbbbbb', path: "m/48'/0'/0'/2'", assignedUserId: bob.id }
		]);
		freezeRosterAndNotify(multisig, tx, alice.id);

		// The unassigned key (index 0) is signed → the owner counts as signed.
		const status = reconcileRoster(multisig, tx, progressFor(multisig, [0]));
		expect(status.signedBy).toContain(alice.id);
		expect(status.waitingOn).toContain(bob.id);
	});

	it('notifies every roster member when quorum is met (ready to broadcast)', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		const { multisig, tx } = scenario(alice.id, [
			{ fp: 'aaaaaaaa', path: "m/48'/0'/0'/2'", assignedUserId: alice.id },
			{ fp: 'bbbbbbbb', path: "m/48'/0'/0'/2'", assignedUserId: bob.id }
		]);
		freezeRosterAndNotify(multisig, tx, alice.id);

		// Both keys signed → quorum met.
		notifySignSessionComplete(multisig, tx, progressFor(multisig, [0, 1]));

		for (const uid of [alice.id, bob.id]) {
			const n = db
				.prepare("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND type = 'sign_session_complete'")
				.get(uid) as { n: number };
			expect(n.n).toBe(1);
		}
	});
});
