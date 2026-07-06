import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { getLabels, setLabel, deleteWallet, TX_LABEL_MAX } from './wallets';

const TXID_A = 'a'.repeat(64);
const TXID_B = 'b'.repeat(64);

function wipe(): void {
	db.exec(
		'DELETE FROM tx_labels; DELETE FROM sessions; DELETE FROM wallets; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

let xpubSeq = 0;
function makeWallet(userId: number): number {
	const res = db
		.prepare(
			"INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'w', ?, 'p2wpkh')"
		)
		.run(userId, `xpub-test-${xpubSeq++}`);
	return Number(res.lastInsertRowid);
}

describe('tx labels', () => {
	it('getLabels returns an empty record for an owned wallet with no labels', () => {
		const user = makeUser('owner@example.com');
		const walletId = makeWallet(user.id);
		expect(getLabels(user.id, walletId)).toEqual({});
	});

	it('getLabels and setLabel return null for missing or non-owned wallets', () => {
		const owner = makeUser('owner@example.com');
		const other = makeUser('other@example.com');
		const walletId = makeWallet(owner.id);

		expect(getLabels(other.id, walletId)).toBeNull();
		expect(getLabels(owner.id, 9999)).toBeNull();
		expect(setLabel(other.id, walletId, TXID_A, 'sneaky')).toBeNull();
		expect(setLabel(owner.id, 9999, TXID_A, 'nope')).toBeNull();
		// The non-owner write must not have landed.
		expect(getLabels(owner.id, walletId)).toEqual({});
	});

	it('setLabel inserts a trimmed label and getLabels returns it keyed by txid', () => {
		const user = makeUser('owner@example.com');
		const walletId = makeWallet(user.id);

		expect(setLabel(user.id, walletId, TXID_A, '  rent  ')).toEqual({
			txid: TXID_A,
			label: 'rent'
		});
		setLabel(user.id, walletId, TXID_B, 'invoice #4021');
		expect(getLabels(user.id, walletId)).toEqual({
			[TXID_A]: 'rent',
			[TXID_B]: 'invoice #4021'
		});
	});

	it('setLabel upserts: relabeling the same txid replaces the old label', () => {
		const user = makeUser('owner@example.com');
		const walletId = makeWallet(user.id);

		setLabel(user.id, walletId, TXID_A, 'rent');
		setLabel(user.id, walletId, TXID_A, 'rent — March');
		expect(getLabels(user.id, walletId)).toEqual({ [TXID_A]: 'rent — March' });
		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM tx_labels WHERE wallet_id = ?')
			.get(walletId) as { n: number };
		expect(n).toBe(1);
	});

	it(`setLabel caps labels at ${TX_LABEL_MAX} characters`, () => {
		const user = makeUser('owner@example.com');
		const walletId = makeWallet(user.id);

		const long = 'x'.repeat(TX_LABEL_MAX + 40);
		const res = setLabel(user.id, walletId, TXID_A, long);
		expect(res?.label).toHaveLength(TX_LABEL_MAX);
		expect(getLabels(user.id, walletId)?.[TXID_A]).toHaveLength(TX_LABEL_MAX);
	});

	it('setLabel with an empty or whitespace label clears an existing one', () => {
		const user = makeUser('owner@example.com');
		const walletId = makeWallet(user.id);

		setLabel(user.id, walletId, TXID_A, 'rent');
		expect(setLabel(user.id, walletId, TXID_A, '   ')).toEqual({ txid: TXID_A, label: '' });
		expect(getLabels(user.id, walletId)).toEqual({});
		// Clearing a label that never existed is a harmless no-op.
		expect(setLabel(user.id, walletId, TXID_B, '')).toEqual({ txid: TXID_B, label: '' });
	});

	it('labels are scoped per wallet: same txid can carry different labels', () => {
		const user = makeUser('owner@example.com');
		const w1 = makeWallet(user.id);
		const w2 = makeWallet(user.id);

		setLabel(user.id, w1, TXID_A, 'rent');
		setLabel(user.id, w2, TXID_A, 'savings top-up');
		expect(getLabels(user.id, w1)).toEqual({ [TXID_A]: 'rent' });
		expect(getLabels(user.id, w2)).toEqual({ [TXID_A]: 'savings top-up' });
	});

	it('deleting a wallet cascades away its labels', () => {
		const user = makeUser('owner@example.com');
		const walletId = makeWallet(user.id);
		setLabel(user.id, walletId, TXID_A, 'rent');

		expect(deleteWallet(user.id, walletId)).toBe(true);
		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM tx_labels WHERE wallet_id = ?')
			.get(walletId) as { n: number };
		expect(n).toBe(0);
	});
});

// ---- cairn-cvcu: wallet creation shows up in the activity feed ------------------

import { createWallet } from './wallets';
import { listUserFeed, listAllActivity } from './activity';

// BIP84 test-vector account zpub — public test key, never a real wallet.
const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

describe('createWallet activity event (cairn-cvcu)', () => {
	beforeEach(() => {
		db.exec('DELETE FROM events;');
	});

	it('emits wallet_added into the user feed and the admin log', () => {
		const user = makeUser('feed@example.com');
		const summary = createWallet(user.id, { name: 'Cold storage', xpub: ZPUB, deviceType: 'trezor' });

		const feed = listUserFeed(user.id);
		expect(feed).toHaveLength(1);
		expect(feed[0].type).toBe('wallet_added');
		expect(feed[0].level).toBe('success');
		expect(feed[0].message).toContain('Cold storage');
		expect(feed[0].scope).toBe('you');

		const admin = listAllActivity({ type: 'wallet_added', includeDetail: true });
		expect(admin.total).toBe(1);
		expect(admin.events[0].userId).toBe(user.id);
		expect(admin.events[0].detail).toMatchObject({
			walletKind: 'wallet',
			walletId: summary.id,
			deviceType: 'trezor'
		});
		// Privacy: the xpub itself never lands in the event detail.
		expect(JSON.stringify(admin.events[0].detail)).not.toContain(ZPUB);
	});

	it('does not emit when creation fails (duplicate key)', () => {
		const user = makeUser('dup@example.com');
		createWallet(user.id, { name: 'First', xpub: ZPUB });
		db.exec('DELETE FROM events;');
		expect(() => createWallet(user.id, { name: 'Second', xpub: ZPUB })).toThrow(/already/i);
		expect(listUserFeed(user.id)).toHaveLength(0);
	});
});
