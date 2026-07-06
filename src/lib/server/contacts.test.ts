// cairn-cgip — removing a contact must revoke their multisig shares
// (fix cairn-2oex, commit 016acf2). Before the fix, removeContact only deleted
// the contacts row: multisig_shares FKs point at users(id), not the contact
// relationship, so nothing cascaded and a removed collaborator silently kept
// viewer/cosigner access and any assigned quorum key indefinitely. removeContact
// now calls revokeAllSharesBetween — shares in BOTH directions are dropped and
// key assignments cleared.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import {
	requestContact,
	respondToContact,
	removeContact,
	areContacts,
	listContacts
} from './contacts';
import { shareMultisig, multisigAccessRole } from './multisigShares';

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

/** Full request→accept flow; returns the contacts.id both sides can act on. */
function befriend(requester: { id: number }, target: { id: number; email: string }): number {
	requestContact(requester.id, target.email);
	const row = db
		.prepare('SELECT id FROM contacts WHERE user_id = ? AND contact_user_id = ?')
		.get(requester.id, target.id) as { id: number };
	expect(respondToContact(target.id, row.id, true)).toBe(true);
	return row.id;
}

/** Bare multisig row (same fixture shape backups.test.ts uses). */
function makeMultisig(userId: number, name = 'Family vault'): number {
	const info = db
		.prepare(
			"INSERT INTO multisigs (user_id, name, threshold, script_type, source) VALUES (?, ?, 2, 'p2wsh', 'created')"
		)
		.run(userId, name);
	return Number(info.lastInsertRowid);
}

function makeKey(multisigId: number, position: number): number {
	const info = db
		.prepare(
			`INSERT INTO multisig_keys (multisig_id, position, name, category, xpub, fingerprint, path)
			 VALUES (?, ?, ?, 'hardware', ?, 'aabbccdd', ?)`
		)
		.run(multisigId, position, `Key ${position}`, `xpub-fake-${multisigId}-${position}`, "m/48'/0'/0'/2'");
	return Number(info.lastInsertRowid);
}

function assignedUserOf(keyId: number): number | null {
	const row = db
		.prepare('SELECT assigned_user_id FROM multisig_keys WHERE id = ?')
		.get(keyId) as { assigned_user_id: number | null };
	return row.assigned_user_id;
}

function shareCount(): number {
	return (db.prepare('SELECT COUNT(*) AS n FROM multisig_shares').get() as { n: number }).n;
}

describe('contact lifecycle (arrange sanity)', () => {
	it('request → accept makes an accepted contact both sides can see', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		befriend(alice, bob);

		expect(areContacts(alice.id, bob.id)).toBe(true);
		expect(areContacts(bob.id, alice.id)).toBe(true);
		expect(listContacts(alice.id).friends.map((f) => f.userId)).toEqual([bob.id]);
		expect(listContacts(bob.id).friends.map((f) => f.userId)).toEqual([alice.id]);
	});
});

describe('removeContact revokes multisig access (cairn-cgip, fix cairn-2oex)', () => {
	it('removing a contact deletes their share and clears their assigned key', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		const contactId = befriend(alice, bob);

		const ms = makeMultisig(alice.id);
		const key = makeKey(ms, 0);
		shareMultisig(alice.id, ms, bob.id, 'cosigner', [key]);
		// Sanity: the share is live before removal.
		expect(multisigAccessRole(bob.id, ms)).toBe('cosigner');
		expect(assignedUserOf(key)).toBe(bob.id);

		expect(removeContact(alice.id, contactId)).toBe(true);

		// The regression: before 016acf2 the share row (and the key assignment)
		// survived contact removal, leaving bob with standing wallet access.
		expect(shareCount()).toBe(0);
		expect(assignedUserOf(key)).toBeNull();
		expect(multisigAccessRole(bob.id, ms)).toBeNull();
		expect(areContacts(alice.id, bob.id)).toBe(false);
	});

	it('revocation is bidirectional and applies when the TARGET side unfriends', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		const contactId = befriend(alice, bob); // alice requested; bob is contact_user_id

		const aliceMs = makeMultisig(alice.id, 'Alice vault');
		const bobMs = makeMultisig(bob.id, 'Bob vault');
		const aliceKey = makeKey(aliceMs, 0);
		const bobKey = makeKey(bobMs, 0);
		shareMultisig(alice.id, aliceMs, bob.id, 'cosigner', [aliceKey]);
		shareMultisig(bob.id, bobMs, alice.id, 'viewer');
		expect(shareCount()).toBe(2);

		// bob (the request TARGET, not the requester) removes the relationship.
		expect(removeContact(bob.id, contactId)).toBe(true);

		expect(shareCount()).toBe(0);
		expect(multisigAccessRole(bob.id, aliceMs)).toBeNull();
		expect(multisigAccessRole(alice.id, bobMs)).toBeNull();
		expect(assignedUserOf(aliceKey)).toBeNull();
		expect(assignedUserOf(bobKey)).toBeNull();
	});

	it('a third party’s shares survive an unrelated contact removal', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		const carol = makeUser('carol@example.com');
		const bobContactId = befriend(alice, bob);
		befriend(alice, carol);

		const ms = makeMultisig(alice.id);
		shareMultisig(alice.id, ms, bob.id, 'viewer');
		shareMultisig(alice.id, ms, carol.id, 'viewer');

		expect(removeContact(alice.id, bobContactId)).toBe(true);

		expect(multisigAccessRole(bob.id, ms)).toBeNull();
		expect(multisigAccessRole(carol.id, ms)).toBe('viewer'); // untouched
	});

	it('an uninvolved user cannot remove the relationship (and nothing is revoked)', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		const mallory = makeUser('mallory@example.com');
		const contactId = befriend(alice, bob);
		const ms = makeMultisig(alice.id);
		shareMultisig(alice.id, ms, bob.id, 'viewer');

		expect(removeContact(mallory.id, contactId)).toBe(false);

		expect(areContacts(alice.id, bob.id)).toBe(true);
		expect(multisigAccessRole(bob.id, ms)).toBe('viewer');
	});
});
