import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { db } from './db';
import {
	registerUser,
	createSession,
	getSessionUser,
	destroySession,
	destroyUserSessions,
	userCount,
	getUserByEmail,
	getUserById,
	addCredential,
	listCredentials,
	credentialDescriptors,
	credentialExists,
	getCredentialForAuth,
	updateCredentialCounter,
	renameCredential,
	deleteCredential,
	AuthError
} from './auth';
import { createInvites, revokeInvite } from './admin';
import { setSetting } from './settings';

function wipe(): void {
	// user_credentials cascade when users are deleted (foreign_keys are ON).
	db.exec('DELETE FROM sessions; DELETE FROM wallets; DELETE FROM invites; DELETE FROM users; DELETE FROM settings;');
}

beforeEach(wipe);

function registerAdmin() {
	// First user always becomes admin, no invite needed. Auth is passkey-only —
	// registerUser creates the account; a passkey is attached separately.
	return registerUser({ email: 'admin@example.com', displayName: 'Admin' });
}

describe('registerUser', () => {
	it('makes the first user an admin with no invite required', () => {
		const user = registerAdmin();
		expect(user.isAdmin).toBe(true);
		expect(user.email).toBe('admin@example.com');
		expect(userCount()).toBe(1);
	});

	it('requires an invite code for the second user in default invite mode', () => {
		registerAdmin();
		expect(() => registerUser({ email: 'b@example.com', displayName: 'B' })).toThrowError(
			expect.objectContaining({ code: 'invite_required' })
		);
	});

	it('accepts a valid invite and increments used_count', () => {
		const admin = registerAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1 });
		const user = registerUser({ email: 'b@example.com', displayName: 'B', inviteCode: invite.code });
		expect(user.isAdmin).toBe(false);

		const row = db.prepare('SELECT used_count FROM invites WHERE id = ?').get(invite.id) as {
			used_count: number;
		};
		expect(row.used_count).toBe(1);
	});

	it('rejects an exhausted invite', () => {
		const admin = registerAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1, maxUses: 1 });
		registerUser({ email: 'b@example.com', displayName: 'B', inviteCode: invite.code });
		expect(() =>
			registerUser({ email: 'c@example.com', displayName: 'C', inviteCode: invite.code })
		).toThrowError(expect.objectContaining({ code: 'bad_invite' }));
	});

	it('rejects a revoked invite', () => {
		const admin = registerAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1 });
		revokeInvite(invite.id);
		expect(() =>
			registerUser({ email: 'b@example.com', displayName: 'B', inviteCode: invite.code })
		).toThrowError(expect.objectContaining({ code: 'bad_invite' }));
	});

	it('rejects everyone after the first user in closed mode', () => {
		registerAdmin();
		setSetting('registration_mode', 'closed');
		expect(() => registerUser({ email: 'b@example.com', displayName: 'B' })).toThrowError(
			expect.objectContaining({ code: 'closed' })
		);
	});

	it('needs no invite in open mode', () => {
		registerAdmin();
		setSetting('registration_mode', 'open');
		const user = registerUser({ email: 'b@example.com', displayName: 'B' });
		expect(user.isAdmin).toBe(false);
		expect(userCount()).toBe(2);
	});

	it('rejects a duplicate email (case-insensitively)', () => {
		registerAdmin();
		setSetting('registration_mode', 'open');
		expect(() => registerUser({ email: 'ADMIN@example.com', displayName: 'Dup' })).toThrowError(
			expect.objectContaining({ code: 'email_taken' })
		);
	});

	it('rejects an invalid email', () => {
		expect(() => registerUser({ email: 'not-an-email', displayName: 'A' })).toThrowError(
			expect.objectContaining({ code: 'invalid_email' })
		);
	});

	it('rejects an empty display name', () => {
		expect(() => registerUser({ email: 'a@example.com', displayName: '   ' })).toThrowError(
			expect.objectContaining({ code: 'invalid_name' })
		);
	});

	it('does not store the ignored legacy password field', () => {
		const user = registerUser({ email: 'a@example.com', displayName: 'A', password: 'ignored' });
		const cols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map(
			(c) => c.name
		);
		expect(cols).not.toContain('password_hash');
		expect(getUserById(user.id)?.email).toBe('a@example.com');
	});
});

describe('lookups', () => {
	it('getUserByEmail normalizes case and skips disabled users', () => {
		const admin = registerAdmin();
		expect(getUserByEmail('  ADMIN@Example.com ')?.id).toBe(admin.id);
		db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(admin.id);
		expect(getUserByEmail('admin@example.com')).toBeNull();
	});

	it('getUserById returns null for unknown/disabled', () => {
		const admin = registerAdmin();
		expect(getUserById(admin.id)?.email).toBe('admin@example.com');
		expect(getUserById(9999)).toBeNull();
	});
});

describe('passkey credentials', () => {
	function makeCred(overrides: Partial<Parameters<typeof addCredential>[1]> = {}) {
		return {
			credentialId: 'cred-a',
			publicKey: new Uint8Array([1, 2, 3, 4]),
			counter: 0,
			transports: ['internal', 'hybrid'],
			deviceType: 'multiDevice',
			backedUp: true,
			name: 'Phone',
			...overrides
		};
	}

	it('adds and lists a credential (metadata only)', () => {
		const admin = registerAdmin();
		addCredential(admin.id, makeCred());
		const list = listCredentials(admin.id);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ name: 'Phone', backedUp: true, deviceType: 'multiDevice' });
		expect(list[0].transports).toEqual(['internal', 'hybrid']);
	});

	it('round-trips the public key and reports it for auth', () => {
		const admin = registerAdmin();
		addCredential(admin.id, makeCred());
		const rec = getCredentialForAuth('cred-a');
		expect(rec?.userId).toBe(admin.id);
		expect(rec?.disabled).toBe(false);
		expect(Array.from(rec!.credential.publicKey)).toEqual([1, 2, 3, 4]);
		expect(rec!.credential.id).toBe('cred-a');
		expect(getCredentialForAuth('nope')).toBeNull();
	});

	it('credentialExists and descriptors reflect stored credentials', () => {
		const admin = registerAdmin();
		addCredential(admin.id, makeCred());
		expect(credentialExists('cred-a')).toBe(true);
		expect(credentialExists('cred-x')).toBe(false);
		expect(credentialDescriptors(admin.id)).toEqual([
			{ id: 'cred-a', transports: ['internal', 'hybrid'] }
		]);
	});

	it('updates the replay counter and last_used', () => {
		const admin = registerAdmin();
		addCredential(admin.id, makeCred());
		updateCredentialCounter('cred-a', 42);
		expect(getCredentialForAuth('cred-a')!.credential.counter).toBe(42);
		expect(listCredentials(admin.id)[0].lastUsedAt).not.toBeNull();
	});

	it('renames a credential (only the owner)', () => {
		const admin = registerAdmin();
		addCredential(admin.id, makeCred());
		const id = listCredentials(admin.id)[0].id;
		expect(renameCredential(admin.id, id, 'My iPhone')).toBe(true);
		expect(listCredentials(admin.id)[0].name).toBe('My iPhone');
		expect(renameCredential(admin.id, 99999, 'x')).toBe(false);
	});

	it('refuses to remove the last passkey but allows removing others', () => {
		const admin = registerAdmin();
		addCredential(admin.id, makeCred({ credentialId: 'cred-a', name: 'Phone' }));
		const firstId = listCredentials(admin.id)[0].id;
		expect(() => deleteCredential(admin.id, firstId)).toThrowError(
			expect.objectContaining({ code: 'last_passkey' })
		);

		addCredential(admin.id, makeCred({ credentialId: 'cred-b', name: 'Laptop' }));
		expect(deleteCredential(admin.id, firstId)).toBe(true);
		expect(listCredentials(admin.id)).toHaveLength(1);
	});

	it('credentials cascade-delete with the user', () => {
		const admin = registerAdmin();
		addCredential(admin.id, makeCred());
		db.prepare('DELETE FROM users WHERE id = ?').run(admin.id);
		expect(getCredentialForAuth('cred-a')).toBeNull();
	});
});

describe('sessions', () => {
	it('createSession -> getSessionUser roundtrip', () => {
		const admin = registerAdmin();
		const { token, expiresAt } = createSession(admin.id);
		expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

		const user = getSessionUser(token);
		expect(user).toEqual({
			id: admin.id,
			email: 'admin@example.com',
			displayName: 'Admin',
			isAdmin: true
		});
	});

	it('returns null for a bogus token and for undefined', () => {
		registerAdmin();
		expect(getSessionUser('bogus-token')).toBeNull();
		expect(getSessionUser(undefined)).toBeNull();
	});

	it('destroySession kills the session', () => {
		const admin = registerAdmin();
		const { token } = createSession(admin.id);
		destroySession(token);
		expect(getSessionUser(token)).toBeNull();
	});

	it('an expired session returns null and is deleted from the table', () => {
		const admin = registerAdmin();
		const token = 'expired-token';
		const tokenHash = createHash('sha256').update(token).digest('hex');
		db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
			tokenHash,
			admin.id,
			new Date(Date.now() - 1000).toISOString()
		);

		expect(getSessionUser(token)).toBeNull();
		const row = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(tokenHash) as {
			n: number;
		};
		expect(row.n).toBe(0);
	});

	it('returns null for a disabled user with a live session', () => {
		const admin = registerAdmin();
		const { token } = createSession(admin.id);
		db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(admin.id);
		expect(getSessionUser(token)).toBeNull();
	});

	it('destroyUserSessions removes all of a user\'s sessions', () => {
		const admin = registerAdmin();
		const a = createSession(admin.id);
		const b = createSession(admin.id);
		destroyUserSessions(admin.id);
		expect(getSessionUser(a.token)).toBeNull();
		expect(getSessionUser(b.token)).toBeNull();
	});
});
