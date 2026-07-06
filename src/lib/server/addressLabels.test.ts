import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import {
	getAddressLabels,
	setAddressLabel,
	deleteAddressLabels,
	LabelAccessError,
	ADDRESS_LABEL_MAX
} from './addressLabels';

function wipe(): void {
	db.exec(
		'DELETE FROM address_labels; DELETE FROM multisig_shares; DELETE FROM multisigs; DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

const ADDR_A = 'bc1qaddressa';
const ADDR_B = 'bc1qaddressb';

let uid: number;
let walletId: number;
let walletId2: number;
let msId: number;

let xpubSeq = 0;
function makeWallet(userId: number): number {
	return Number(
		db
			.prepare("INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'w', ?, 'p2wpkh')")
			.run(userId, `xpub-test-${xpubSeq++}`).lastInsertRowid
	);
}

function makeMultisig(userId: number): number {
	return Number(
		db
			.prepare("INSERT INTO multisigs (user_id, name, threshold, script_type) VALUES (?, 'ms', 2, 'p2wsh')")
			.run(userId).lastInsertRowid
	);
}

function makeUser(email: string): number {
	return registerUser({
		email,
		password: 'correct horse battery',
		displayName: email.split('@')[0]
	}).id;
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	uid = makeUser('owner@example.com');
	walletId = makeWallet(uid);
	walletId2 = makeWallet(uid);
	msId = makeMultisig(uid);
});

describe('addressLabels', () => {
	it('sets and reads a label back', () => {
		setAddressLabel(uid, 'wallet', walletId, ADDR_A, 'exchange deposit');
		expect(getAddressLabels(uid, 'wallet', walletId)).toEqual({ [ADDR_A]: 'exchange deposit' });
	});

	it('upserts on the same address rather than duplicating', () => {
		setAddressLabel(uid, 'wallet', walletId, ADDR_A, 'first');
		const r = setAddressLabel(uid, 'wallet', walletId, ADDR_A, 'second');
		expect(r).toEqual({ address: ADDR_A, label: 'second' });
		expect(getAddressLabels(uid, 'wallet', walletId)).toEqual({ [ADDR_A]: 'second' });
	});

	it('clears a label when set to empty/whitespace', () => {
		setAddressLabel(uid, 'wallet', walletId, ADDR_A, 'temp');
		const r = setAddressLabel(uid, 'wallet', walletId, ADDR_A, '   ');
		expect(r).toEqual({ address: ADDR_A, label: '' });
		expect(getAddressLabels(uid, 'wallet', walletId)).toEqual({});
	});

	it('trims and caps at ADDRESS_LABEL_MAX', () => {
		const long = 'x'.repeat(ADDRESS_LABEL_MAX + 50);
		const r = setAddressLabel(uid, 'wallet', walletId, ADDR_A, `  ${long}  `);
		expect(r.label.length).toBe(ADDRESS_LABEL_MAX);
	});

	it('keeps wallet and multisig kinds separate for the same id', () => {
		// Force a multisig whose numeric id equals a wallet id via direct SQL.
		setAddressLabel(uid, 'wallet', walletId, ADDR_A, 'w-label');
		setAddressLabel(uid, 'multisig', msId, ADDR_A, 'm-label');
		expect(getAddressLabels(uid, 'wallet', walletId)).toEqual({ [ADDR_A]: 'w-label' });
		expect(getAddressLabels(uid, 'multisig', msId)).toEqual({ [ADDR_A]: 'm-label' });
	});

	it('deleteAddressLabels drops only the given wallet/kind', () => {
		setAddressLabel(uid, 'wallet', walletId, ADDR_A, 'a');
		setAddressLabel(uid, 'wallet', walletId, ADDR_B, 'b');
		setAddressLabel(uid, 'wallet', walletId2, ADDR_A, 'other');
		setAddressLabel(uid, 'multisig', msId, ADDR_A, 'ms');
		deleteAddressLabels('wallet', walletId);
		expect(getAddressLabels(uid, 'wallet', walletId)).toEqual({});
		expect(getAddressLabels(uid, 'wallet', walletId2)).toEqual({ [ADDR_A]: 'other' });
		expect(getAddressLabels(uid, 'multisig', msId)).toEqual({ [ADDR_A]: 'ms' });
	});
});

// cairn-o1dp.3 — the label layer re-verifies access itself, independent of any
// route-level gating: a direct call with someone else's wallet id must throw,
// never silently read or write.
describe('addressLabels internal access re-check (cairn-o1dp.3)', () => {
	it('denies reads and writes against another user’s wallet', () => {
		const stranger = makeUser('stranger@example.com');
		setAddressLabel(uid, 'wallet', walletId, ADDR_A, 'mine');

		expect(() => getAddressLabels(stranger, 'wallet', walletId)).toThrow(LabelAccessError);
		expect(() => setAddressLabel(stranger, 'wallet', walletId, ADDR_A, 'theirs')).toThrow(
			LabelAccessError
		);
		// Nothing changed.
		expect(getAddressLabels(uid, 'wallet', walletId)).toEqual({ [ADDR_A]: 'mine' });
	});

	it('denies a nonexistent wallet id outright', () => {
		expect(() => getAddressLabels(uid, 'wallet', 999_999)).toThrow(LabelAccessError);
	});

	it('multisig: any participant reads; only owner/cosigner writes', () => {
		const cosigner = makeUser('cosigner@example.com');
		const viewer = makeUser('viewer@example.com');
		const outsider = makeUser('outsider@example.com');
		const share = db.prepare(
			'INSERT INTO multisig_shares (multisig_id, owner_id, shared_with_id, role) VALUES (?, ?, ?, ?)'
		);
		share.run(msId, uid, cosigner, 'cosigner');
		share.run(msId, uid, viewer, 'viewer');

		setAddressLabel(uid, 'multisig', msId, ADDR_A, 'from owner');
		setAddressLabel(cosigner, 'multisig', msId, ADDR_B, 'from cosigner');
		expect(getAddressLabels(viewer, 'multisig', msId)).toEqual({
			[ADDR_A]: 'from owner',
			[ADDR_B]: 'from cosigner'
		});

		expect(() => setAddressLabel(viewer, 'multisig', msId, ADDR_A, 'nope')).toThrow(
			LabelAccessError
		);
		expect(() => getAddressLabels(outsider, 'multisig', msId)).toThrow(LabelAccessError);
	});
});
