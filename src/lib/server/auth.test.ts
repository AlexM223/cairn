import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { db } from './db';
import {
	registerUser,
	setSessionCookie,
	cookieSecure,
	SESSION_COOKIE,
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
	reclaimableUserId,
	hasNoCredentials,
	hashPassword,
	verifyPassword,
	loginWithPassword,
	setUserPassword,
	hasPassword,
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
	// First user always becomes admin, no invite needed. Password is optional
	// here (this account is passkey-eligible until one is added).
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

	it('rejects a weak password', () => {
		expect(() =>
			registerUser({ email: 'a@example.com', displayName: 'A', password: 'short' })
		).toThrowError(expect.objectContaining({ code: 'weak_password' }));
	});

	it('stores a password hash only when a password is given', () => {
		const withPw = registerUser({ email: 'p@example.com', displayName: 'P', password: 'longenough' });
		expect(hasPassword(withPw.id)).toBe(true);
		setSetting('registration_mode', 'open');
		const noPw = registerUser({ email: 'n@example.com', displayName: 'N' });
		expect(hasPassword(noPw.id)).toBe(false);
	});
});

describe('passwords', () => {
	it('hashPassword / verifyPassword round-trips and rejects wrong/tampered', () => {
		const stored = hashPassword('correct horse battery');
		expect(stored).toMatch(/^scrypt:16384:8:1:/);
		expect(verifyPassword('correct horse battery', stored)).toBe(true);
		expect(verifyPassword('wrong', stored)).toBe(false);
		expect(verifyPassword('correct horse battery', 'not-a-hash')).toBe(false);
		// Two hashes of the same password differ (salted).
		expect(hashPassword('x-password')).not.toBe(hashPassword('x-password'));
	});

	it('loginWithPassword succeeds and normalizes email', () => {
		const admin = registerUser({ email: 'admin@example.com', displayName: 'Admin', password: 'cairn2025x' });
		expect(loginWithPassword('  ADMIN@Example.com ', 'cairn2025x').id).toBe(admin.id);
	});

	it('uses the same error for unknown email, no password, and wrong password', () => {
		registerUser({ email: 'admin@example.com', displayName: 'Admin', password: 'cairn2025x' });
		setSetting('registration_mode', 'open');
		registerUser({ email: 'nopw@example.com', displayName: 'NoPw' }); // passkey-only, no password

		const codes: string[] = [];
		for (const [email, pw] of [
			['admin@example.com', 'wrongpassword'],
			['ghost@example.com', 'cairn2025x'],
			['nopw@example.com', 'cairn2025x']
		] as const) {
			try {
				loginWithPassword(email, pw);
			} catch (e) {
				codes.push((e as AuthError).code);
			}
		}
		expect(codes).toEqual(['bad_credentials', 'bad_credentials', 'bad_credentials']);
	});

	it('rejects a disabled user even with the right password', () => {
		const admin = registerUser({ email: 'admin@example.com', displayName: 'Admin', password: 'cairn2025x' });
		db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(admin.id);
		expect(() => loginWithPassword('admin@example.com', 'cairn2025x')).toThrowError(
			expect.objectContaining({ code: 'disabled' })
		);
	});

	it('setUserPassword sets a first password on a passkey-only account', () => {
		const admin = registerUser({ email: 'admin@example.com', displayName: 'Admin' });
		expect(hasPassword(admin.id)).toBe(false);
		setUserPassword(admin.id, 'brandnew-pass');
		expect(hasPassword(admin.id)).toBe(true);
		expect(loginWithPassword('admin@example.com', 'brandnew-pass').id).toBe(admin.id);
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

	it('reclaim: only a credential-less NON-ADMIN account can be reclaimed', () => {
		const admin = registerAdmin();
		addCredential(admin.id, makeCred()); // admin has a passkey — not the reclaim shape
		// A normal, credential-less account — the shape a backup restore produces.
		setSetting('registration_mode', 'open');
		const bob = registerUser({ email: 'bob@example.com', displayName: 'Bob' });
		expect(bob.isAdmin).toBe(false);
		expect(hasNoCredentials(bob.id)).toBe(true);
		expect(reclaimableUserId('bob@example.com')).toBe(bob.id);
		expect(reclaimableUserId('ghost@example.com')).toBeNull();

		// A credential-less ADMIN account is NEVER reclaimable (cairn-cpb5): reclaim
		// bypasses the registration gate, so it must not be a path to admin.
		db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(bob.id);
		expect(reclaimableUserId('bob@example.com')).toBeNull();
		db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(bob.id);

		addCredential(bob.id, makeCred({ credentialId: 'cred-bob' }));
		// Once a normal account has a passkey it can never be reclaimed (taken over).
		expect(reclaimableUserId('bob@example.com')).toBeNull();
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

// cairn-jtfa — pins the fix for cairn-gy4: the session cookie's `secure` flag
// deliberately FOLLOWS the request protocol rather than being hard-coded true.
// A plain-HTTP LAN deployment (Umbrel on http://umbrel.local) must be able to
// log in — an always-secure cookie is silently dropped there — while an HTTPS
// deployment stays locked to HTTPS.
describe('setSessionCookie', () => {
	function captureCookies() {
		const jar: { name: string; value: string; opts: Record<string, unknown> }[] = [];
		const cookies = {
			set: (name: string, value: string, opts: Record<string, unknown>) => {
				jar.push({ name, value, opts });
			}
		} as unknown as Cookies;
		return { cookies, jar };
	}

	const expiresAt = new Date(Date.now() + 60_000);

	it('plain HTTP (Umbrel LAN) gets secure:false so the browser keeps the cookie', () => {
		const { cookies, jar } = captureCookies();
		setSessionCookie(cookies, 'tok-http', expiresAt, new URL('http://umbrel.local/login'));

		expect(jar).toHaveLength(1);
		expect(jar[0].name).toBe(SESSION_COOKIE);
		expect(jar[0].value).toBe('tok-http');
		expect(jar[0].opts.secure).toBe(false);
	});

	it('HTTPS gets secure:true', () => {
		const { cookies, jar } = captureCookies();
		setSessionCookie(cookies, 'tok-https', expiresAt, new URL('https://cairn.example.com/login'));

		expect(jar).toHaveLength(1);
		expect(jar[0].name).toBe(SESSION_COOKIE);
		expect(jar[0].opts.secure).toBe(true);
	});

	it('always sets the hardening basics regardless of protocol', () => {
		for (const url of ['http://umbrel.local/login', 'https://cairn.example.com/login']) {
			const { cookies, jar } = captureCookies();
			setSessionCookie(cookies, 'tok', expiresAt, new URL(url));
			expect(jar[0].opts).toMatchObject({
				httpOnly: true,
				path: '/',
				sameSite: 'lax',
				expires: expiresAt
			});
		}
	});
});

// The request URL's protocol can LIE: adapter-node assumes https whenever
// neither ORIGIN nor PROTOCOL_HEADER is configured, so a plain-HTTP deployment
// behind Umbrel's app_proxy sees https request URLs while the browser is on
// http://umbrel.local — and a Secure cookie there is silently dropped (login
// 200s but the session never sticks). A declared plain-HTTP CAIRN_ORIGIN must
// therefore veto the Secure flag.
describe('cookieSecure', () => {
	const ORIGINAL = process.env.CAIRN_ORIGIN;
	afterEach(() => {
		if (ORIGINAL === undefined) delete process.env.CAIRN_ORIGIN;
		else process.env.CAIRN_ORIGIN = ORIGINAL;
	});

	it('declared http origin vetoes Secure even when the request URL claims https (Umbrel behind app_proxy)', () => {
		process.env.CAIRN_ORIGIN = 'http://umbrel.local:3211';
		expect(cookieSecure(new URL('https://umbrel.local:3211/login'))).toBe(false);
	});

	it('declared https origin keeps following the request protocol', () => {
		process.env.CAIRN_ORIGIN = 'https://cairn.example.com';
		expect(cookieSecure(new URL('https://cairn.example.com/login'))).toBe(true);
		expect(cookieSecure(new URL('http://umbrel.local/login'))).toBe(false);
	});

	it('no declared origin: follows the request protocol', () => {
		delete process.env.CAIRN_ORIGIN;
		expect(cookieSecure(new URL('https://cairn.example.com/login'))).toBe(true);
		expect(cookieSecure(new URL('http://umbrel.local/login'))).toBe(false);
	});

	it('malformed CAIRN_ORIGIN falls back to the request protocol', () => {
		process.env.CAIRN_ORIGIN = 'not a url';
		expect(cookieSecure(new URL('https://cairn.example.com/login'))).toBe(true);
	});
});
