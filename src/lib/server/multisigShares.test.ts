// cairn-a6c8 — multisigShares.ts (collaborative-custody access control) had no
// test at ANY layer. Pins: share creation per role (viewer/cosigner, with and
// without assigned keys), multisigAccessRole resolution for owner/viewer/
// cosigner/stranger, revocation removing access AND key assignments, and
// redactMultisigKeysForViewer stripping key derivation paths for non-owners
// (xpub/fingerprint deliberately stay visible — they distinguish keys and are
// not secret; `path` is what gets redacted, per the implementation and plan §6).

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import {
	shareMultisig,
	updateMultisigShare,
	revokeMultisigShare,
	revokeAllSharesBetween,
	listCollaborators,
	listSharedMultisigs,
	multisigAccessRole,
	redactMultisigKeysForViewer,
	ShareError,
	type ShareRole
} from './multisigShares';
import { getMultisig } from './wallets/multisig';

function wipe(): void {
	db.exec(
		'DELETE FROM multisig_shares; DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM contacts; DELETE FROM events; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

/** Insert an ACCEPTED contact row directly — the sharing precondition. */
function befriend(userIdA: number, userIdB: number): void {
	db.prepare(
		`INSERT INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, 'accepted')`
	).run(userIdA, userIdB);
}

/** Bare multisig row, same shape backups.test.ts uses. */
function makeMultisig(userId: number, name = 'Family vault'): number {
	const info = db
		.prepare(
			"INSERT INTO multisigs (user_id, name, threshold, script_type, source) VALUES (?, ?, 2, 'p2wsh', 'created')"
		)
		.run(userId, name);
	return Number(info.lastInsertRowid);
}

const KEY_PATH = "m/48'/0'/0'/2'";

/** One quorum key of a multisig. xpub only needs to be unique per multisig. */
function makeKey(multisigId: number, position: number): number {
	const info = db
		.prepare(
			`INSERT INTO multisig_keys (multisig_id, position, name, category, xpub, fingerprint, path)
			 VALUES (?, ?, ?, 'hardware', ?, 'aabbccdd', ?)`
		)
		.run(multisigId, position, `Key ${position}`, `xpub-fake-${multisigId}-${position}`, KEY_PATH);
	return Number(info.lastInsertRowid);
}

function shareIdOf(multisigId: number, sharedWithId: number): number {
	const row = db
		.prepare('SELECT id FROM multisig_shares WHERE multisig_id = ? AND shared_with_id = ?')
		.get(multisigId, sharedWithId) as { id: number } | undefined;
	expect(row).toBeDefined();
	return row!.id;
}

function assignedUserOf(keyId: number): number | null {
	const row = db
		.prepare('SELECT assigned_user_id FROM multisig_keys WHERE id = ?')
		.get(keyId) as { assigned_user_id: number | null };
	return row.assigned_user_id;
}

function expectShareError(fn: () => unknown, code: ShareError['code']): void {
	let caught: unknown = null;
	try {
		fn();
	} catch (e) {
		caught = e;
	}
	expect(caught).toBeInstanceOf(ShareError);
	expect((caught as ShareError).code).toBe(code);
}

describe('shareMultisig + multisigAccessRole', () => {
	it('viewer share: owner resolves owner, contact resolves viewer, stranger resolves null', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		const mallory = makeUser('mallory@example.com');
		befriend(alice.id, bob.id);
		const ms = makeMultisig(alice.id);

		shareMultisig(alice.id, ms, bob.id, 'viewer');

		expect(multisigAccessRole(alice.id, ms)).toBe('owner');
		expect(multisigAccessRole(bob.id, ms)).toBe('viewer');
		expect(multisigAccessRole(mallory.id, ms)).toBeNull();
		// A viewer holds no keys.
		expect(listCollaborators(alice.id, ms)).toEqual([
			expect.objectContaining({ userId: bob.id, role: 'viewer', assignedKeyIds: [] })
		]);
	});

	it('cosigner share with an assigned key claims exactly that key', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		befriend(alice.id, bob.id);
		const ms = makeMultisig(alice.id);
		const k1 = makeKey(ms, 0);
		const k2 = makeKey(ms, 1);

		shareMultisig(alice.id, ms, bob.id, 'cosigner', [k1]);

		expect(multisigAccessRole(bob.id, ms)).toBe('cosigner');
		expect(assignedUserOf(k1)).toBe(bob.id);
		expect(assignedUserOf(k2)).toBeNull();
		expect(listCollaborators(alice.id, ms)).toEqual([
			expect.objectContaining({ userId: bob.id, role: 'cosigner', assignedKeyIds: [k1] })
		]);
	});

	it('cosigner without keys is a valid "decide later" state', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		befriend(alice.id, bob.id);
		const ms = makeMultisig(alice.id);
		makeKey(ms, 0);

		shareMultisig(alice.id, ms, bob.id, 'cosigner');

		expect(multisigAccessRole(bob.id, ms)).toBe('cosigner');
		expect(listCollaborators(alice.id, ms)[0].assignedKeyIds).toEqual([]);
	});

	it('re-sharing as viewer downgrades the role AND clears key assignments (upsert path)', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		befriend(alice.id, bob.id);
		const ms = makeMultisig(alice.id);
		const k1 = makeKey(ms, 0);
		shareMultisig(alice.id, ms, bob.id, 'cosigner', [k1]);
		expect(assignedUserOf(k1)).toBe(bob.id);

		shareMultisig(alice.id, ms, bob.id, 'viewer');

		expect(multisigAccessRole(bob.id, ms)).toBe('viewer');
		expect(assignedUserOf(k1)).toBeNull();
		// Still exactly one share row (ON CONFLICT updated, not duplicated).
		const rows = db
			.prepare('SELECT COUNT(*) AS n FROM multisig_shares WHERE multisig_id = ?')
			.get(ms) as { n: number };
		expect(rows.n).toBe(1);
	});

	it('listSharedMultisigs shows the wallet from the recipient side with owner identity', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		befriend(alice.id, bob.id);
		const ms = makeMultisig(alice.id, 'Family vault');
		shareMultisig(alice.id, ms, bob.id, 'viewer');

		expect(listSharedMultisigs(bob.id)).toEqual([
			{
				multisigId: ms,
				name: 'Family vault',
				threshold: 2,
				role: 'viewer',
				ownerId: alice.id,
				ownerName: 'alice'
			}
		]);
		expect(listSharedMultisigs(alice.id)).toEqual([]); // owning is not "shared with"
	});

	describe('rejections', () => {
		it('refuses to share with someone who is not an accepted contact', () => {
			const alice = makeUser('alice@example.com');
			const mallory = makeUser('mallory@example.com');
			const ms = makeMultisig(alice.id);
			expectShareError(() => shareMultisig(alice.id, ms, mallory.id, 'viewer'), 'not_contact');
			expect(multisigAccessRole(mallory.id, ms)).toBeNull();
		});

		it('refuses to share with yourself', () => {
			const alice = makeUser('alice@example.com');
			const ms = makeMultisig(alice.id);
			expectShareError(() => shareMultisig(alice.id, ms, alice.id, 'viewer'), 'self');
		});

		it('refuses an unknown role', () => {
			const alice = makeUser('alice@example.com');
			const bob = makeUser('bob@example.com');
			befriend(alice.id, bob.id);
			const ms = makeMultisig(alice.id);
			expectShareError(
				() => shareMultisig(alice.id, ms, bob.id, 'admin' as ShareRole),
				'bad_role'
			);
		});

		it('a non-owner cannot share someone else’s wallet', () => {
			const alice = makeUser('alice@example.com');
			const bob = makeUser('bob@example.com');
			const carol = makeUser('carol@example.com');
			befriend(bob.id, carol.id);
			const ms = makeMultisig(alice.id);
			expectShareError(() => shareMultisig(bob.id, ms, carol.id, 'viewer'), 'not_owner');
		});

		it('rejects a key that belongs to a different multisig', () => {
			const alice = makeUser('alice@example.com');
			const bob = makeUser('bob@example.com');
			befriend(alice.id, bob.id);
			const ms = makeMultisig(alice.id);
			const otherMs = makeMultisig(alice.id, 'Other vault');
			const foreignKey = makeKey(otherMs, 0);
			expectShareError(
				() => shareMultisig(alice.id, ms, bob.id, 'cosigner', [foreignKey]),
				'bad_keys'
			);
			// The failed key validation must not leave a claim behind.
			expect(assignedUserOf(foreignKey)).toBeNull();
		});

		it('rejects a key already assigned to another collaborator', () => {
			const alice = makeUser('alice@example.com');
			const bob = makeUser('bob@example.com');
			const carol = makeUser('carol@example.com');
			befriend(alice.id, bob.id);
			befriend(alice.id, carol.id);
			const ms = makeMultisig(alice.id);
			const k1 = makeKey(ms, 0);
			shareMultisig(alice.id, ms, carol.id, 'cosigner', [k1]);

			expectShareError(
				() => shareMultisig(alice.id, ms, bob.id, 'cosigner', [k1]),
				'bad_keys'
			);
			expect(assignedUserOf(k1)).toBe(carol.id); // carol keeps her key
		});
	});
});

describe('updateMultisigShare', () => {
	it('upgrades viewer to cosigner and assigns keys by shareId', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		befriend(alice.id, bob.id);
		const ms = makeMultisig(alice.id);
		const k1 = makeKey(ms, 0);
		shareMultisig(alice.id, ms, bob.id, 'viewer');

		updateMultisigShare(alice.id, shareIdOf(ms, bob.id), { role: 'cosigner', keyIds: [k1] });

		expect(multisigAccessRole(bob.id, ms)).toBe('cosigner');
		expect(assignedUserOf(k1)).toBe(bob.id);
	});

	it('rejects an unknown shareId and a shareId owned by someone else', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		befriend(alice.id, bob.id);
		const ms = makeMultisig(alice.id);
		shareMultisig(alice.id, ms, bob.id, 'viewer');
		const shareId = shareIdOf(ms, bob.id);

		expectShareError(() => updateMultisigShare(alice.id, 999_999, { role: 'viewer' }), 'not_found');
		// bob does not own the share row, so he cannot rewrite it.
		expectShareError(() => updateMultisigShare(bob.id, shareId, { role: 'cosigner' }), 'not_found');
		expect(multisigAccessRole(bob.id, ms)).toBe('viewer'); // untouched
	});
});

describe('revokeMultisigShare', () => {
	it('removes access and unassigns the collaborator’s keys', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		befriend(alice.id, bob.id);
		const ms = makeMultisig(alice.id);
		const k1 = makeKey(ms, 0);
		shareMultisig(alice.id, ms, bob.id, 'cosigner', [k1]);
		const shareId = shareIdOf(ms, bob.id);

		expect(revokeMultisigShare(alice.id, shareId)).toBe(true);

		expect(multisigAccessRole(bob.id, ms)).toBeNull();
		expect(assignedUserOf(k1)).toBeNull();
		expect(listCollaborators(alice.id, ms)).toEqual([]);
		// Idempotent: the row is gone, a second revoke reports false.
		expect(revokeMultisigShare(alice.id, shareId)).toBe(false);
	});

	it('a non-owner cannot revoke: returns false and access is intact', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		befriend(alice.id, bob.id);
		const ms = makeMultisig(alice.id);
		shareMultisig(alice.id, ms, bob.id, 'viewer');
		const shareId = shareIdOf(ms, bob.id);

		expect(revokeMultisigShare(bob.id, shareId)).toBe(false);
		expect(multisigAccessRole(bob.id, ms)).toBe('viewer');
	});
});

describe('revokeAllSharesBetween', () => {
	it('drops shares in BOTH directions and leaves third parties untouched', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		const carol = makeUser('carol@example.com');
		befriend(alice.id, bob.id);
		befriend(alice.id, carol.id);
		const aliceMs = makeMultisig(alice.id, 'Alice vault');
		const bobMs = makeMultisig(bob.id, 'Bob vault');
		const aliceKey = makeKey(aliceMs, 0);
		const bobKey = makeKey(bobMs, 0);
		shareMultisig(alice.id, aliceMs, bob.id, 'cosigner', [aliceKey]);
		shareMultisig(bob.id, bobMs, alice.id, 'cosigner', [bobKey]);
		shareMultisig(alice.id, aliceMs, carol.id, 'viewer'); // must survive

		expect(revokeAllSharesBetween(alice.id, bob.id)).toBe(2);

		expect(multisigAccessRole(bob.id, aliceMs)).toBeNull();
		expect(multisigAccessRole(alice.id, bobMs)).toBeNull();
		expect(assignedUserOf(aliceKey)).toBeNull();
		expect(assignedUserOf(bobKey)).toBeNull();
		expect(multisigAccessRole(carol.id, aliceMs)).toBe('viewer'); // untouched
	});
});

describe('redactMultisigKeysForViewer', () => {
	it('strips path on every key except the viewer’s own; xpub/fingerprint stay visible', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		befriend(alice.id, bob.id);
		const ms = makeMultisig(alice.id);
		const k1 = makeKey(ms, 0);
		makeKey(ms, 1);
		shareMultisig(alice.id, ms, bob.id, 'cosigner', [k1]);

		const keys = getMultisig(alice.id, ms)!.keys;
		const redacted = redactMultisigKeysForViewer(keys, bob.id, alice.id);

		const own = redacted.find((k) => k.id === k1)!;
		const other = redacted.find((k) => k.id !== k1)!;
		expect(own.path).toBe(KEY_PATH); // viewer keeps their OWN key's path
		expect(other.path).toBe(''); // everyone else's path is redacted
		// Per the implementation, xpub and fingerprint are never redacted — they
		// are needed to tell keys apart and are not secret.
		for (const k of redacted) {
			expect(k.xpub).toMatch(/^xpub-fake-/);
			expect(k.fingerprint).toBe('aabbccdd');
		}
	});

	it('a pure viewer (no assigned keys) sees no paths at all; the owner sees everything', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		befriend(alice.id, bob.id);
		const ms = makeMultisig(alice.id);
		makeKey(ms, 0);
		makeKey(ms, 1);
		shareMultisig(alice.id, ms, bob.id, 'viewer');

		const keys = getMultisig(alice.id, ms)!.keys;

		const forViewer = redactMultisigKeysForViewer(keys, bob.id, alice.id);
		expect(forViewer.every((k) => k.path === '')).toBe(true);

		const forOwner = redactMultisigKeysForViewer(keys, alice.id, alice.id);
		expect(forOwner.every((k) => k.path === KEY_PATH)).toBe(true);
	});
});
