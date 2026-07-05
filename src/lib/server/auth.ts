import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from './db';
import { getInstanceSettings, getSetting } from './settings';
import { notify } from './notifications';
import type { CredentialInfo, SessionUser } from '$lib/types';
import type { WebAuthnCredential } from '@simplewebauthn/server';

export type { CredentialInfo };

// Authentication supports two methods that coexist:
//   • email + password (scrypt) — the DEFAULT, and required for Umbrel/Docker
//     deployments where a browser passkey ceremony isn't practical;
//   • passkeys (WebAuthn) — an optional, additive login method a user can add
//     in settings (credentials live in user_credentials; see webauthn.ts).
// An account may have a password, one or more passkeys, or both.

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

/**
 * Set the session cookie (httpOnly, lax) for a freshly created session.
 * `secure` follows the request protocol — explicit, matching the WebAuthn
 * challenge cookie: locked to HTTPS when served over it, while plain-HTTP
 * LAN deployments (Umbrel on umbrel.local) keep working.
 */
export function setSessionCookie(
	cookies: Cookies,
	token: string,
	expiresAt: Date,
	url: URL
): void {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		expires: expiresAt
	});
}

// ---------- Passwords (scrypt — no native deps) ----------

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

/** Minimum acceptable password length. */
export const MIN_PASSWORD_LENGTH = 8;

export function hashPassword(password: string): string {
	const salt = randomBytes(16);
	const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
	return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
	const parts = stored.split(':');
	if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
	const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
	const salt = Buffer.from(saltB64, 'base64');
	const expected = Buffer.from(hashB64, 'base64');
	const actual = scryptSync(password, salt, expected.length, {
		N: parseInt(nStr, 10),
		r: parseInt(rStr, 10),
		p: parseInt(pStr, 10)
	});
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Set (or replace) a user's password. */
export function setUserPassword(userId: number, password: string): void {
	db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
}

/** Whether a user currently has a password set (vs passkey-only). */
export function hasPassword(userId: number): boolean {
	const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
		| { password_hash: string | null }
		| undefined;
	return !!row?.password_hash;
}

/**
 * Verify an email + password and return the user. Uses the SAME error for an
 * unknown email, an account with no password, and a wrong password, so it never
 * reveals which accounts exist or use passwords.
 */
export function loginWithPassword(email: string, password: string): SessionUser {
	const row = db
		.prepare(
			'SELECT id, email, password_hash, display_name, is_admin, disabled FROM users WHERE email = ?'
		)
		.get(email.trim().toLowerCase()) as
		| {
				id: number;
				email: string;
				password_hash: string | null;
				display_name: string;
				is_admin: number;
				disabled: number;
		  }
		| undefined;

	if (!row || !row.password_hash || !verifyPassword(password, row.password_hash))
		throw new AuthError('Invalid email or password.', 'bad_credentials');
	if (row.disabled) throw new AuthError('This account has been disabled.', 'disabled');

	return { id: row.id, email: row.email, displayName: row.display_name, isAdmin: row.is_admin === 1 };
}

// ---------- Auth mode + deployment bootstrap ----------

export type AuthMode = 'password' | 'passkey';

/**
 * The primary sign-up method. Defaults to 'password'; an admin can switch it in
 * settings (stored key `auth_mode`), and a deployment can force it with the
 * CAIRN_AUTH_MODE env var (which wins — Umbrel/Docker pin 'password'). Passkeys
 * remain available as an additive login method regardless of this.
 */
export function getAuthMode(): AuthMode {
	const raw = (env.CAIRN_AUTH_MODE ?? getSetting('auth_mode') ?? 'password').toLowerCase();
	return raw === 'passkey' ? 'passkey' : 'password';
}

export function setAuthMode(mode: AuthMode): void {
	db.prepare(
		"INSERT INTO settings (key, value) VALUES ('auth_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
	).run(mode);
}

/**
 * Non-interactive admin bootstrap for deployment tooling (Umbrel surfaces the
 * password in its own UI). If CAIRN_ADMIN_PASSWORD (or APP_PASSWORD) is set:
 * create the first admin with it, or give an existing passwordless first admin
 * that password. Never clobbers a password the operator already chose. Runs
 * once at server start (see hooks.server.ts).
 */
export function bootstrapAdminFromEnv(): void {
	const pw = env.CAIRN_ADMIN_PASSWORD ?? env.APP_PASSWORD;
	if (!pw || pw.length < MIN_PASSWORD_LENGTH) return;

	const first = db.prepare('SELECT id, password_hash FROM users ORDER BY id ASC LIMIT 1').get() as
		| { id: number; password_hash: string | null }
		| undefined;

	if (!first) {
		const email = (env.CAIRN_ADMIN_EMAIL ?? 'admin@cairn.local').trim().toLowerCase();
		db.prepare(
			'INSERT INTO users (email, password_hash, display_name, is_admin) VALUES (?, ?, ?, 1)'
		).run(email, hashPassword(pw), 'Admin');
	} else if (!first.password_hash) {
		setUserPassword(first.id, pw);
	}
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
	/** Optional password (scrypt-hashed). Omitted for a passkey-only account. */
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

	// Password is optional (a passkey-only account leaves it null); when present
	// it must be strong enough.
	const password = input.password;
	if (password != null && password.length < MIN_PASSWORD_LENGTH)
		throw new AuthError(
			`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
			'weak_password'
		);

	// Consume the invite only now, on the real create.
	if (!isFirstUser && getInstanceSettings().registrationMode === 'invite' && inviteCode) {
		redeemInvite(inviteCode);
	}

	const result = db
		.prepare('INSERT INTO users (email, password_hash, display_name, is_admin) VALUES (?, ?, ?, ?)')
		.run(email, password ? hashPassword(password) : null, displayName, isFirstUser ? 1 : 0);

	const newUserId = Number(result.lastInsertRowid);

	// admin_new_signup (Unit 8): a new account was created — broadcast to admins.
	// Skip the very first account: it IS the first admin creating the instance,
	// there's no one to notify and no adminUserIds() to fan out to yet. notify()
	// is best-effort (never throws), so a failure can't abort the registration.
	if (!isFirstUser) {
		notify({
			type: 'admin_new_signup',
			userId: null,
			level: 'info',
			title: 'New account created',
			body: `${displayName} (${email}) just signed up.`,
			detail: { newUserId, email, displayName },
			link: '/admin/users'
		});
	}

	return {
		id: newUserId,
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

	// admin_invite_used (Unit 8): an invite was just redeemed — broadcast to
	// admins so they can see their invites being consumed. userId null = admin
	// fan-out. Best-effort; never blocks redemption.
	notify({
		type: 'admin_invite_used',
		userId: null,
		level: 'info',
		title: 'Invite code redeemed',
		body: `An invite code was just used to register a new account.`,
		detail: { inviteId: invite.id, usedCount: invite.used_count + 1, maxUses: invite.max_uses },
		link: '/admin/invites'
	});
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
