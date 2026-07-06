import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { detectCosignerContacts } from './cosignerDetection';

// Detection must match a cosigner fingerprint ONLY against the importer's
// ACCEPTED contacts (anti-enumeration), across both single-sig wallets and
// multisig cosigner keys, and never against strangers or the unknown sentinel.

function wipe(): void {
	db.exec(
		'DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM wallets; DELETE FROM contacts; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

let seq = 0;
function mkUser() {
	setSetting('registration_mode', 'open');
	return registerUser({
		email: `u${seq++}@example.com`,
		password: 'correct horse battery',
		displayName: `User ${seq}`
	});
}

function makeContacts(a: number, b: number): void {
	db.prepare(
		"INSERT INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, 'accepted')"
	).run(a, b);
}

function giveWallet(userId: number, fp: string): void {
	db.prepare(
		"INSERT INTO wallets (user_id, name, type, xpub, script_type, master_fingerprint) VALUES (?, 'W', 'xpub', ?, 'p2wpkh', ?)"
	).run(userId, `xpub-${userId}-${fp}`, fp);
}

const FP_A = 'aabbccdd';
const FP_B = '11223344';

beforeEach(wipe);

describe('detectCosignerContacts', () => {
	it('matches a fingerprint held by an accepted contact', () => {
		const me = mkUser();
		const friend = mkUser();
		makeContacts(me.id, friend.id);
		giveWallet(friend.id, FP_A);

		const matches = detectCosignerContacts(me.id, [FP_A, FP_B]);
		expect(matches.length).toBe(1);
		expect(matches[0].fingerprint).toBe(FP_A);
		expect(matches[0].contactUserId).toBe(friend.id);
	});

	it('does NOT match a stranger (anti-enumeration)', () => {
		const me = mkUser();
		const stranger = mkUser(); // no contact relationship
		giveWallet(stranger.id, FP_A);
		expect(detectCosignerContacts(me.id, [FP_A])).toEqual([]);
	});

	it('ignores the unknown-fingerprint sentinel and malformed input', () => {
		const me = mkUser();
		const friend = mkUser();
		makeContacts(me.id, friend.id);
		giveWallet(friend.id, '00000000');
		expect(detectCosignerContacts(me.id, ['00000000', 'nothex', ''])).toEqual([]);
	});

	it('matches a contact who holds the key inside a multisig, not just single-sig', () => {
		const me = mkUser();
		const friend = mkUser();
		makeContacts(me.id, friend.id);
		const ms = db
			.prepare(
				"INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, 'MS', 2, 'p2wsh')"
			)
			.run(friend.id);
		db.prepare(
			"INSERT INTO multisig_keys (multisig_id, position, name, category, xpub, fingerprint, path) VALUES (?, 0, 'K', 'hardware', 'xpubX', ?, 'm')"
		).run(Number(ms.lastInsertRowid), FP_B);

		const matches = detectCosignerContacts(me.id, [FP_B]);
		expect(matches.length).toBe(1);
		expect(matches[0].contactUserId).toBe(friend.id);
	});

	it('matches regardless of contact-row direction and is case-insensitive', () => {
		const me = mkUser();
		const friend = mkUser();
		makeContacts(friend.id, me.id); // friend initiated
		giveWallet(friend.id, FP_A);
		expect(detectCosignerContacts(me.id, [FP_A.toUpperCase()]).length).toBe(1);
	});

	it('returns empty when the user has no contacts', () => {
		const me = mkUser();
		giveWallet(me.id, FP_A); // my own key doesn't count as a contact
		expect(detectCosignerContacts(me.id, [FP_A])).toEqual([]);
	});
});
