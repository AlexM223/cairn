import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { db } from './db';
import {
	hashPassword,
	verifyPassword,
	registerUser,
	loginUser,
	createSession,
	getSessionUser,
	destroySession,
	destroyUserSessions,
	userCount,
	AuthError
} from './auth';
import { createInvites, revokeInvite } from './admin';
import { setSetting } from './settings';

function wipe(): void {
	// Order matters: invites reference users without ON DELETE CASCADE.
	db.exec('DELETE FROM sessions; DELETE FROM wallets; DELETE FROM invites; DELETE FROM users; DELETE FROM settings;');
}

beforeEach(wipe);

const PASSWORD = 'correct horse battery';

function registerAdmin() {
	// First user always becomes admin, no invite needed.
	return registerUser({ email: 'admin@example.com', password: PASSWORD, displayName: 'Admin' });
}

describe('hashPassword / verifyPassword', () => {
	it('round-trips a password', () => {
		const stored = hashPassword(PASSWORD);
		expect(verifyPassword(PASSWORD, stored)).toBe(true);
	});

	it('rejects a wrong password', () => {
		const stored = hashPassword(PASSWORD);
		expect(verifyPassword('wrong password', stored)).toBe(false);
	});

	it('rejects a tampered stored string', () => {
		const stored = hashPassword(PASSWORD);
		const parts = stored.split(':');
		// Corrupt the hash portion (flip its first character).
		parts[5] = (parts[5][0] === 'A' ? 'B' : 'A') + parts[5].slice(1);
		expect(verifyPassword(PASSWORD, parts.join(':'))).toBe(false);
		expect(verifyPassword(PASSWORD, 'not-a-hash')).toBe(false);
	});

	it('stores scrypt params in the prefix', () => {
		expect(hashPassword(PASSWORD)).toMatch(/^scrypt:16384:8:1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
	});

	it('salts: two hashes of the same password differ', () => {
		expect(hashPassword(PASSWORD)).not.toBe(hashPassword(PASSWORD));
	});
});

describe('registerUser', () => {
	it('makes the first user an admin with no invite required', () => {
		const user = registerAdmin();
		expect(user.isAdmin).toBe(true);
		expect(user.email).toBe('admin@example.com');
		expect(userCount()).toBe(1);
	});

	it('requires an invite code for the second user in default invite mode', () => {
		registerAdmin();
		expect(() =>
			registerUser({ email: 'b@example.com', password: PASSWORD, displayName: 'B' })
		).toThrowError(expect.objectContaining({ code: 'invite_required' }));
	});

	it('accepts a valid invite and increments used_count', () => {
		const admin = registerAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1 });
		const user = registerUser({
			email: 'b@example.com',
			password: PASSWORD,
			displayName: 'B',
			inviteCode: invite.code
		});
		expect(user.isAdmin).toBe(false);

		const row = db.prepare('SELECT used_count FROM invites WHERE id = ?').get(invite.id) as {
			used_count: number;
		};
		expect(row.used_count).toBe(1);
	});

	it('rejects an exhausted invite', () => {
		const admin = registerAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1, maxUses: 1 });
		registerUser({
			email: 'b@example.com',
			password: PASSWORD,
			displayName: 'B',
			inviteCode: invite.code
		});
		expect(() =>
			registerUser({
				email: 'c@example.com',
				password: PASSWORD,
				displayName: 'C',
				inviteCode: invite.code
			})
		).toThrowError(expect.objectContaining({ code: 'bad_invite' }));
	});

	it('rejects a revoked invite', () => {
		const admin = registerAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1 });
		revokeInvite(invite.id);
		expect(() =>
			registerUser({
				email: 'b@example.com',
				password: PASSWORD,
				displayName: 'B',
				inviteCode: invite.code
			})
		).toThrowError(expect.objectContaining({ code: 'bad_invite' }));
	});

	it('rejects an expired invite', () => {
		const admin = registerAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1 });
		db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run(
			new Date(Date.now() - 60_000).toISOString(),
			invite.id
		);
		expect(() =>
			registerUser({
				email: 'b@example.com',
				password: PASSWORD,
				displayName: 'B',
				inviteCode: invite.code
			})
		).toThrowError(expect.objectContaining({ code: 'bad_invite' }));
	});

	it('rejects an unknown invite code', () => {
		registerAdmin();
		expect(() =>
			registerUser({
				email: 'b@example.com',
				password: PASSWORD,
				displayName: 'B',
				inviteCode: 'CAIRN-XXXX-XXXX'
			})
		).toThrowError(expect.objectContaining({ code: 'bad_invite' }));
	});

	it('rejects everyone after the first user in closed mode', () => {
		registerAdmin();
		setSetting('registration_mode', 'closed');
		expect(() =>
			registerUser({ email: 'b@example.com', password: PASSWORD, displayName: 'B' })
		).toThrowError(expect.objectContaining({ code: 'closed' }));
	});

	it('needs no invite in open mode', () => {
		registerAdmin();
		setSetting('registration_mode', 'open');
		const user = registerUser({ email: 'b@example.com', password: PASSWORD, displayName: 'B' });
		expect(user.isAdmin).toBe(false);
		expect(userCount()).toBe(2);
	});

	it('rejects a duplicate email (case-insensitively)', () => {
		registerAdmin();
		setSetting('registration_mode', 'open');
		expect(() =>
			registerUser({ email: 'ADMIN@example.com', password: PASSWORD, displayName: 'Dup' })
		).toThrowError(expect.objectContaining({ code: 'email_taken' }));
	});

	it('rejects a weak password', () => {
		expect(() =>
			registerUser({ email: 'a@example.com', password: 'short', displayName: 'A' })
		).toThrowError(expect.objectContaining({ code: 'weak_password' }));
	});

	it('rejects an invalid email', () => {
		expect(() =>
			registerUser({ email: 'not-an-email', password: PASSWORD, displayName: 'A' })
		).toThrowError(expect.objectContaining({ code: 'invalid_email' }));
	});

	it('rejects an empty display name', () => {
		expect(() =>
			registerUser({ email: 'a@example.com', password: PASSWORD, displayName: '   ' })
		).toThrowError(expect.objectContaining({ code: 'invalid_name' }));
	});
});

describe('loginUser', () => {
	it('logs in with correct credentials', () => {
		const created = registerAdmin();
		const user = loginUser('admin@example.com', PASSWORD);
		expect(user.id).toBe(created.id);
		expect(user.isAdmin).toBe(true);
	});

	it('normalizes email case and whitespace', () => {
		registerAdmin();
		expect(loginUser('  ADMIN@Example.com ', PASSWORD).email).toBe('admin@example.com');
	});

	it('rejects a wrong password', () => {
		registerAdmin();
		expect(() => loginUser('admin@example.com', 'nope nope nope')).toThrow(AuthError);
	});

	it('uses the same error for unknown email and wrong password (no user enumeration)', () => {
		registerAdmin();
		let wrongPassword: AuthError | undefined;
		let unknownEmail: AuthError | undefined;
		try {
			loginUser('admin@example.com', 'nope nope nope');
		} catch (e) {
			wrongPassword = e as AuthError;
		}
		try {
			loginUser('ghost@example.com', PASSWORD);
		} catch (e) {
			unknownEmail = e as AuthError;
		}
		expect(wrongPassword?.message).toBe(unknownEmail?.message);
		expect(wrongPassword?.code).toBe('bad_credentials');
		expect(unknownEmail?.code).toBe('bad_credentials');
	});

	it('rejects a disabled user even with the right password', () => {
		const admin = registerAdmin();
		db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(admin.id);
		expect(() => loginUser('admin@example.com', PASSWORD)).toThrowError(
			expect.objectContaining({ code: 'disabled' })
		);
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
