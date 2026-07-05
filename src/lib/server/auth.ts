import { randomBytes, createHash } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { db } from './db';
import { getInstanceSettings } from './settings';
import type { CredentialInfo, SessionUser } from '$lib/types';
import type { WebAuthnCredential } from '@simplewebauthn/server';

export type { CredentialInfo };

// Authentication is passkey-only (WebAuthn). There are no passwords: nothing to
// hash, phish, leak, or reset. A user proves who they are with a device-bound
// credential; the credentials live in user_credentials. See webauthn.ts for the
// ceremony wrappers and the /api/auth routes for the endpoints.

const SESSION_DAYS = 30;

export const SESSION_COOKIE = 'cairn_session';

// ---------- Sessions ----------

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export function createSession(userId: number): { token: string; expiresAt: Date } {
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
	db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
		hashToken(token),
		userId,
		expiresAt.toISOString()
	);
	db.prepare(
		`UPDATE users SET last_login = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
	).run(userId);
	return { token, expiresAt };
}

export function getSessionUser(token: string | undefined): SessionUser | null {
	if (!token) return null;
	const row = db
		.prepare(
			`SELECT u.id, u.email, u.display_name, u.is_admin, u.disabled, s.expires_at
			 FROM sessions s JOIN users u ON u.id = s.user_id
			 WHERE s.token_hash = ?`
		)
		.get(hashToken(token)) as
		| {
				id: number;
				email: string;
				display_name: string;
				is_admin: number;
				disabled: number;
				expires_at: string;
		  }
		| undefined;

	if (!row) return null;
	if (row.disabled) return null;
	if (new Date(row.expires_at).getTime() < Date.now()) {
		db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
		return null;
	}
	return {
		id: row.id,
		email: row.email,
		displayName: row.display_name,
		isAdmin: row.is_admin === 1
	};
}

export function destroySession(token: string | undefined): void {
	if (!token) return;
	db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function destroyUserSessions(userId: number): void {
	db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Set the session cookie (httpOnly, lax) for a freshly created session. */
export function setSessionCookie(cookies: Cookies, token: string, expiresAt: Date): void {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		expires: expiresAt
	});
}

// ---------- Registration / users ----------

export class AuthError extends Error {
	constructor(
		message: string,
		public code: string
	) {
		super(message);
	}
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function userCount(): number {
	const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
	return row.n;
}

export interface RegisterInput {
	email: string;
	displayName: string;
	inviteCode?: string;
	/** @deprecated Passwords were removed with the move to passkeys. Ignored. */
	password?: string;
}

/**
 * Validate registration eligibility WITHOUT creating anything: email/name shape,
 * the instance's registration mode, and (in invite mode) that the invite is
 * currently redeemable. Used by the passkey registration `options` step, before
 * a passkey exists. Throws AuthError on any problem. Returns whether this would
 * be the first (admin) user.
 */
export function assertCanRegister(input: {
	email: string;
	displayName: string;
	inviteCode?: string;
}): { isFirstUser: boolean } {
	const email = input.email.trim().toLowerCase();
	const displayName = input.displayName.trim();
	const inviteCode = input.inviteCode?.trim();

	if (!EMAIL_RE.test(email)) throw new AuthError('Enter a valid email address.', 'invalid_email');
	if (!displayName) throw new AuthError('Display name is required.', 'invalid_name');

	const isFirstUser = userCount() === 0;
	if (!isFirstUser) {
		const mode = getInstanceSettings().registrationMode;
		if (mode === 'closed')
			throw new AuthError('Registration is closed on this instance.', 'closed');
		if (mode === 'invite') {
			if (!inviteCode) throw new AuthError('An invite code is required.', 'invite_required');
			assertInviteRedeemable(inviteCode);
		}
	}

	const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
	if (existing) throw new AuthError('An account with this email already exists.', 'email_taken');

	return { isFirstUser };
}

/**
 * Create a user (passkey-only — no password). Re-validates eligibility, consumes
 * the invite if one is required, and inserts the row. The caller then attaches
 * the first passkey; do both inside one transaction so a half-registered account
 * can never exist. Returns the new user.
 */
export function registerUser(input: RegisterInput): SessionUser {
	const email = input.email.trim().toLowerCase();
	const displayName = input.displayName.trim();
	const inviteCode = input.inviteCode?.trim();

	const { isFirstUser } = assertCanRegister({ email, displayName, inviteCode });

	// Consume the invite only now, on the real create.
	if (!isFirstUser && getInstanceSettings().registrationMode === 'invite' && inviteCode) {
		redeemInvite(inviteCode);
	}

	const result = db
		.prepare('INSERT INTO users (email, display_name, is_admin) VALUES (?, ?, ?)')
		.run(email, displayName, isFirstUser ? 1 : 0);

	return {
		id: Number(result.lastInsertRowid),
		email,
		displayName,
		isAdmin: isFirstUser
	};
}

/** Look up a user by id. Null when unknown/disabled. */
export function getUserById(id: number): SessionUser | null {
	const row = db
		.prepare('SELECT id, email, display_name, is_admin, disabled FROM users WHERE id = ?')
		.get(id) as
		| { id: number; email: string; display_name: string; is_admin: number; disabled: number }
		| undefined;
	if (!row || row.disabled) return null;
	return { id: row.id, email: row.email, displayName: row.display_name, isAdmin: row.is_admin === 1 };
}

/** True when the user has no passkeys — only possible for accounts brought in by
 *  a backup restore (every normal account is created with its first passkey). */
export function hasNoCredentials(userId: number): boolean {
	const { n } = db
		.prepare('SELECT COUNT(*) AS n FROM user_credentials WHERE user_id = ?')
		.get(userId) as { n: number };
	return n === 0;
}

/**
 * The id of an existing account this email is allowed to RECLAIM by adding a
 * passkey (rather than registering fresh), or null. Reclaim is how a
 * credential-less account restored from a backup gets a passkey and becomes
 * usable again. Only credential-less, non-disabled accounts qualify, so an
 * account that already has a passkey can never be taken over this way.
 */
export function reclaimableUserId(email: string): number | null {
	const user = getUserByEmail(email);
	if (user && hasNoCredentials(user.id)) return user.id;
	return null;
}

/** Look up a user by email for the login ceremony. Null when unknown/disabled. */
export function getUserByEmail(email: string): SessionUser | null {
	const row = db
		.prepare(
			'SELECT id, email, display_name, is_admin, disabled FROM users WHERE email = ?'
		)
		.get(email.trim().toLowerCase()) as
		| { id: number; email: string; display_name: string; is_admin: number; disabled: number }
		| undefined;
	if (!row || row.disabled) return null;
	return { id: row.id, email: row.email, displayName: row.display_name, isAdmin: row.is_admin === 1 };
}

// ---------- Passkey credentials ----------

export interface StoredCredentialInput {
	credentialId: string; // base64url
	publicKey: Uint8Array;
	counter: number;
	transports?: string[];
	deviceType?: string; // 'singleDevice' | 'multiDevice'
	backedUp?: boolean;
	name?: string | null;
}

export function addCredential(userId: number, cred: StoredCredentialInput): void {
	db.prepare(
		`INSERT INTO user_credentials
		   (user_id, credential_id, public_key, counter, transports, device_type, backed_up, name)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		userId,
		cred.credentialId,
		Buffer.from(cred.publicKey).toString('base64url'),
		cred.counter,
		cred.transports && cred.transports.length ? JSON.stringify(cred.transports) : null,
		cred.deviceType ?? null,
		cred.backedUp ? 1 : 0,
		cred.name?.trim() || null
	);
}

/** All of a user's passkeys, newest first — metadata only, for the settings UI. */
export function listCredentials(userId: number): CredentialInfo[] {
	const rows = db
		.prepare(
			`SELECT id, name, device_type, backed_up, transports, created_at, last_used_at
			   FROM user_credentials WHERE user_id = ? ORDER BY created_at ASC, id ASC`
		)
		.all(userId) as {
		id: number;
		name: string | null;
		device_type: string | null;
		backed_up: number;
		transports: string | null;
		created_at: string;
		last_used_at: string | null;
	}[];
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		deviceType: r.device_type,
		backedUp: r.backed_up === 1,
		transports: parseTransports(r.transports),
		createdAt: r.created_at,
		lastUsedAt: r.last_used_at
	}));
}

/** The {id, transports} descriptors for a user's passkeys — for allow/exclude lists. */
export function credentialDescriptors(
	userId: number
): { id: string; transports: string[] }[] {
	const rows = db
		.prepare('SELECT credential_id, transports FROM user_credentials WHERE user_id = ?')
		.all(userId) as { credential_id: string; transports: string | null }[];
	return rows.map((r) => ({ id: r.credential_id, transports: parseTransports(r.transports) }));
}

/** The credential (and its owner) for an authentication assertion, or null. */
export function getCredentialForAuth(
	credentialId: string
): { userId: number; disabled: boolean; credential: WebAuthnCredential } | null {
	const row = db
		.prepare(
			`SELECT c.credential_id, c.public_key, c.counter, c.transports, c.user_id, u.disabled
			   FROM user_credentials c JOIN users u ON u.id = c.user_id
			  WHERE c.credential_id = ?`
		)
		.get(credentialId) as
		| {
				credential_id: string;
				public_key: string;
				counter: number;
				transports: string | null;
				user_id: number;
				disabled: number;
		  }
		| undefined;
	if (!row) return null;
	return {
		userId: row.user_id,
		disabled: row.disabled === 1,
		credential: {
			id: row.credential_id,
			publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')),
			counter: row.counter,
			transports: parseTransports(row.transports) as WebAuthnCredential['transports']
		}
	};
}

/** Persist the authenticator's replay counter after a successful assertion. */
export function updateCredentialCounter(credentialId: string, counter: number): void {
	db.prepare(
		`UPDATE user_credentials
		    SET counter = ?, last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		  WHERE credential_id = ?`
	).run(counter, credentialId);
}

/** True if this exact credential id is already registered (dedupe on add). */
export function credentialExists(credentialId: string): boolean {
	return !!db
		.prepare('SELECT 1 FROM user_credentials WHERE credential_id = ?')
		.get(credentialId);
}

export function renameCredential(userId: number, id: number, name: string): boolean {
	const res = db
		.prepare('UPDATE user_credentials SET name = ? WHERE id = ? AND user_id = ?')
		.run(name.trim().slice(0, 64) || null, id, userId);
	return res.changes > 0;
}

/**
 * Remove a passkey. Refuses to remove a user's LAST one — that would lock them
 * out of their own account (recovery is by re-import into a new account, not by
 * password). Throws AuthError('last_passkey') in that case.
 */
export function deleteCredential(userId: number, id: number): boolean {
	const owned = db
		.prepare('SELECT id FROM user_credentials WHERE id = ? AND user_id = ?')
		.get(id, userId);
	if (!owned) return false;
	const { n } = db
		.prepare('SELECT COUNT(*) AS n FROM user_credentials WHERE user_id = ?')
		.get(userId) as { n: number };
	if (n <= 1)
		throw new AuthError(
			'This is your only passkey — add another before removing it.',
			'last_passkey'
		);
	db.prepare('DELETE FROM user_credentials WHERE id = ? AND user_id = ?').run(id, userId);
	return true;
}

function parseTransports(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const arr = JSON.parse(raw);
		return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === 'string') : [];
	} catch {
		return [];
	}
}

// ---------- Invites ----------

function findInvite(code: string) {
	return db
		.prepare('SELECT id, max_uses, used_count, revoked, expires_at FROM invites WHERE code = ?')
		.get(code.trim().toUpperCase()) as
		| { id: number; max_uses: number; used_count: number; revoked: number; expires_at: string | null }
		| undefined;
}

/** Throw AuthError('bad_invite') unless the code is currently redeemable. */
function assertInviteRedeemable(code: string): void {
	const invite = findInvite(code);
	if (!invite) throw new AuthError('That invite code is not valid.', 'bad_invite');
	if (invite.revoked) throw new AuthError('That invite code has been revoked.', 'bad_invite');
	if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now())
		throw new AuthError('That invite code has expired.', 'bad_invite');
	if (invite.used_count >= invite.max_uses)
		throw new AuthError('That invite code has already been used.', 'bad_invite');
}

function redeemInvite(code: string): void {
	assertInviteRedeemable(code);
	const invite = findInvite(code)!;
	db.prepare('UPDATE invites SET used_count = used_count + 1 WHERE id = ?').run(invite.id);
}

export function generateInviteCode(): string {
	// CAIRN-XXXX-XXXX, unambiguous alphabet
	const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
	const pick = () =>
		Array.from(randomBytes(4))
			.map((b) => alphabet[b % alphabet.length])
			.join('');
	return `CAIRN-${pick()}-${pick()}`;
}
