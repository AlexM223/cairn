// cairn-5u2i.3/.4 — the self-service data surfaces. buildAccountExport must be
// scoped STRICTLY to the requesting user (a second user's data never appears)
// and carry no secret material; the sessions/devices helpers must only ever
// touch the caller's own rows, and revoking a session must invalidate it
// against the real auth path immediately.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser, createSession, getSessionUser } from './auth';
import { setSetting } from './settings';
import { encryptSecret } from './secretKey';
import {
	buildAccountExport,
	listUserSessions,
	revokeUserSession,
	listKnownDevices,
	forgetKnownDevice
} from './accountData';

function wipe(): void {
	db.exec(
		`DELETE FROM notification_channel_config; DELETE FROM notification_preferences;
		 DELETE FROM known_devices; DELETE FROM saved_addresses; DELETE FROM address_labels;
		 DELETE FROM tx_labels; DELETE FROM events; DELETE FROM multisig_keys; DELETE FROM multisigs;
		 DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;`
	);
}

let alice: number;
let bob: number;

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	alice = registerUser({
		email: 'alice@example.com',
		password: 'correct horse battery',
		displayName: 'alice'
	}).id;
	bob = registerUser({
		email: 'bob@example.com',
		password: 'correct horse battery',
		displayName: 'bob'
	}).id;
});

describe('buildAccountExport (cairn-5u2i.3)', () => {
	it('covers the audit checklist and is scoped strictly to the requesting user', () => {
		// Alice's data across the exported tables.
		const aliceWallet = Number(
			db
				.prepare("INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'AW', 'xpub-alice', 'p2wpkh')")
				.run(alice).lastInsertRowid
		);
		db.prepare(
			"INSERT INTO transactions (wallet_id, psbt, recipient, amount, fee, fee_rate) VALUES (?, 'UFVCTF9QU0JU', 'bc1qalice', 5000, 100, 2)"
		).run(aliceWallet);
		db.prepare("INSERT INTO saved_addresses (user_id, label, address) VALUES (?, 'Mom', 'bc1qmom')").run(alice);
		db.prepare("INSERT INTO tx_labels (wallet_id, txid, label) VALUES (?, 'aa', 'rent')").run(aliceWallet);
		db.prepare("INSERT INTO address_labels (wallet_kind, wallet_id, address, label) VALUES ('wallet', ?, 'bc1qx', 'change')").run(aliceWallet);
		db.prepare("INSERT INTO events (user_id, type, level, message) VALUES (?, 'tx_received', 'info', 'Alice payment')").run(alice);
		db.prepare("INSERT INTO known_devices (user_id, fingerprint, user_agent) VALUES (?, 'fp-alice', 'Firefox/1.0')").run(alice);
		db.prepare(
			"INSERT INTO notification_preferences (user_id, event_type, channel, enabled) VALUES (?, 'tx_received', 'email', 1)"
		).run(alice);

		// Bob's data — none of it may appear in Alice's export.
		const bobWallet = Number(
			db
				.prepare("INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'BW', 'xpub-bob-SECRETMARK', 'p2wpkh')")
				.run(bob).lastInsertRowid
		);
		db.prepare("INSERT INTO saved_addresses (user_id, label, address) VALUES (?, 'BobDest', 'bc1qbobonly')").run(bob);
		db.prepare("INSERT INTO events (user_id, type, level, message) VALUES (?, 'tx_received', 'info', 'Bob-only event')").run(bob);
		db.prepare("INSERT INTO tx_labels (wallet_id, txid, label) VALUES (?, 'bb', 'bob-label')").run(bobWallet);

		const out = buildAccountExport(alice);
		const text = JSON.stringify(out);

		// Checklist coverage.
		expect((out.profile as { email: string }).email).toBe('alice@example.com');
		expect(out.wallets).toHaveLength(1);
		expect(out.transactions).toHaveLength(1);
		expect(out.savedAddresses).toHaveLength(1);
		expect(out.txLabels).toHaveLength(1);
		expect(out.addressLabels).toHaveLength(1);
		expect(out.activity).toHaveLength(1);
		expect(out.knownDevices).toHaveLength(1);
		expect(out.notificationPreferences).toHaveLength(1);
		expect(Array.isArray(out.sessions)).toBe(true);
		expect(Array.isArray(out.multisigs)).toBe(true);
		expect(Array.isArray(out.agreementAcceptances)).toBe(true);

		// Strict user scoping.
		expect(text).not.toContain('bob@example.com');
		expect(text).not.toContain('SECRETMARK');
		expect(text).not.toContain('bc1qbobonly');
		expect(text).not.toContain('Bob-only event');
		expect(text).not.toContain('bob-label');
	});

	it('never carries secret material: password hashes, session tokens, raw PSBTs, channel secrets', () => {
		const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(alice) as {
			password_hash: string;
		};
		createSession(alice);
		db.prepare(
			"INSERT INTO notification_channel_config (user_id, channel, config) VALUES (?, 'ntfy', ?)"
		).run(alice, JSON.stringify({ topic: 't', accessTokenEnc: encryptSecret('tk_secret_value') }));
		const walletId = Number(
			db
				.prepare("INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'W', 'xpub-a', 'p2wpkh')")
				.run(alice).lastInsertRowid
		);
		db.prepare(
			"INSERT INTO transactions (wallet_id, psbt, recipient, amount, fee, fee_rate) VALUES (?, 'UFNCVEJMT0I=', 'bc1q', 1, 1, 1)"
		).run(walletId);

		const text = JSON.stringify(buildAccountExport(alice));
		expect(text).not.toContain(row.password_hash);
		expect(text).not.toContain('token_hash');
		expect(text).not.toContain('UFNCVEJMT0I='); // the raw PSBT column is excluded
		expect(text).not.toContain('accessTokenEnc'); // channel secrets → presence booleans
		expect(text).toContain('hasAccessToken');
	});
});

describe('sessions & devices self-service (cairn-5u2i.4)', () => {
	it('revoking own session invalidates it immediately against the auth path', () => {
		const { token } = createSession(alice);
		expect(getSessionUser(token)).not.toBeNull();

		const sessions = listUserSessions(alice, null);
		expect(sessions).toHaveLength(1);
		expect(revokeUserSession(alice, sessions[0].id)).toBe(true);
		expect(getSessionUser(token)).toBeNull(); // rejected on the next request
	});

	it('cannot revoke another user’s session or device by guessing ids', () => {
		const { token } = createSession(alice);
		const aliceSession = listUserSessions(alice, null)[0];
		db.prepare("INSERT INTO known_devices (user_id, fingerprint, user_agent) VALUES (?, 'fp-a', 'UA')").run(alice);

		expect(revokeUserSession(bob, aliceSession.id)).toBe(false);
		expect(forgetKnownDevice(bob, 'fp-a')).toBe(false);
		// Alice is untouched.
		expect(getSessionUser(token)).not.toBeNull();
		expect(listKnownDevices(alice)).toHaveLength(1);

		// And Alice CAN forget her own device.
		expect(forgetKnownDevice(alice, 'fp-a')).toBe(true);
		expect(listKnownDevices(alice)).toHaveLength(0);
	});

	it('marks the current session and lists devices with human labels', () => {
		createSession(alice, { userAgent: 'Mozilla/5.0 Chrome/120 Windows', ip: '203.0.113.5' });
		const all = listUserSessions(alice, null);
		const current = listUserSessions(alice, all[0].id);
		expect(current[0].current).toBe(true);
		expect(current[0].device).toContain('Chrome');
		// The raw IP is not part of the listing shape.
		expect(JSON.stringify(current)).not.toContain('203.0.113.5');
	});
});
