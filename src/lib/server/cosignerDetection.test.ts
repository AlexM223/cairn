import { describe, it, expect, beforeEach } from 'vitest';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { detectCosignerContacts, detectXpubReuse } from './cosignerDetection';

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

// ── detectXpubReuse (cairn-1kc3.4) ───────────────────────────────────────────

// Deterministic test-only xpubs, same construction as the multisig suites.
function xpubAt(seedByte: number, path = "m/48'/0'/0'/2'"): string {
	return HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte)).derive(path).publicExtendedKey;
}

/** Re-encode an xpub with the SLIP-132 Zpub (p2wsh multisig) version bytes. */
function asZpub(xpub: string): string {
	const b58check = createBase58check(sha256);
	const out = new Uint8Array(b58check.decode(xpub));
	out.set([0x02, 0xaa, 0x7e, 0xd3], 0);
	return b58check.encode(out);
}

function giveSingleSigXpub(userId: number, name: string, xpub: string): number {
	return Number(
		db
			.prepare(
				"INSERT INTO wallets (user_id, name, type, xpub, script_type) VALUES (?, ?, 'xpub', ?, 'p2wpkh')"
			)
			.run(userId, name, xpub).lastInsertRowid
	);
}

function giveMultisigKey(userId: number, name: string, xpub: string): number {
	const ms = db
		.prepare("INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, ?, 2, 'p2wsh')")
		.run(userId, name);
	db.prepare(
		"INSERT INTO multisig_keys (multisig_id, position, name, category, xpub, fingerprint, path) VALUES (?, 0, 'K', 'hardware', ?, '00000000', 'm')"
	).run(Number(ms.lastInsertRowid), xpub);
	return Number(ms.lastInsertRowid);
}

describe('detectXpubReuse (cairn-1kc3.4)', () => {
	it('finds an xpub already stored as one of the user\'s single-sig wallets', () => {
		const me = mkUser();
		const id = giveSingleSigXpub(me.id, 'Daily wallet', xpubAt(1));
		const matches = detectXpubReuse(me.id, [xpubAt(1), xpubAt(2)]);
		expect(matches).toEqual([
			{ xpub: xpubAt(1), kind: 'wallet', walletId: id, walletName: 'Daily wallet' }
		]);
	});

	it("finds an xpub already stored as a cosigner key in another of the user's multisigs", () => {
		const me = mkUser();
		const msId = giveMultisigKey(me.id, 'Old vault', xpubAt(3));
		const matches = detectXpubReuse(me.id, [xpubAt(3)]);
		expect(matches).toEqual([
			{ xpub: xpubAt(3), kind: 'multisig', walletId: msId, walletName: 'Old vault' }
		]);
	});

	it('matches through SLIP-132 aliases in either direction', () => {
		const me = mkUser();
		giveSingleSigXpub(me.id, 'Zpub wallet', asZpub(xpubAt(4)));
		// Stored as Zpub, offered as xpub…
		expect(detectXpubReuse(me.id, [xpubAt(4)])).toHaveLength(1);
		// …and stored as xpub, offered as Zpub.
		giveMultisigKey(me.id, 'Plain vault', xpubAt(5));
		expect(detectXpubReuse(me.id, [asZpub(xpubAt(5))])).toHaveLength(1);
	});

	it("never matches another user's rows (no enumeration surface)", () => {
		const me = mkUser();
		const other = mkUser();
		giveSingleSigXpub(other.id, 'Their wallet', xpubAt(6));
		giveMultisigKey(other.id, 'Their vault', xpubAt(7));
		expect(detectXpubReuse(me.id, [xpubAt(6), xpubAt(7)])).toEqual([]);
	});

	it('ignores garbage input and returns empty on no overlap', () => {
		const me = mkUser();
		giveSingleSigXpub(me.id, 'Wallet', xpubAt(8));
		expect(detectXpubReuse(me.id, ['not-an-xpub', ''])).toEqual([]);
		expect(detectXpubReuse(me.id, [xpubAt(9)])).toEqual([]);
	});
});
