import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { db } from './db';
import { getInstanceSettings } from './settings';
import type { SessionUser } from '$lib/types';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SESSION_DAYS = 30;

export const SESSION_COOKIE = 'cairn_session';

// ---------- Password hashing (scrypt — no native deps) ----------

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
	return timingSafeEqual(actual, expected);
}

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

// ---------- Registration / login ----------

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
	password: string;
	displayName: string;
	inviteCode?: string;
}

export function registerUser(input: RegisterInput): SessionUser {
	const email = input.email.trim().toLowerCase();
	const displayName = input.displayName.trim();
	const inviteCode = input.inviteCode?.trim();

	if (!EMAIL_RE.test(email)) throw new AuthError('Enter a valid email address.', 'invalid_email');
	if (input.password.length < 8)
		throw new AuthError('Password must be at least 8 characters.', 'weak_password');
	if (!displayName) throw new AuthError('Display name is required.', 'invalid_name');

	const isFirstUser = userCount() === 0;

	if (!isFirstUser) {
		const mode = getInstanceSettings().registrationMode;
		if (mode === 'closed')
			throw new AuthError('Registration is closed on this instance.', 'closed');
		if (mode === 'invite') {
			if (!inviteCode) throw new AuthError('An invite code is required.', 'invite_required');
			redeemInvite(inviteCode); // throws if invalid
		}
	}

	const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
	if (existing) throw new AuthError('An account with this email already exists.', 'email_taken');

	const result = db
		.prepare(
			'INSERT INTO users (email, password_hash, display_name, is_admin) VALUES (?, ?, ?, ?)'
		)
		.run(email, hashPassword(input.password), displayName, isFirstUser ? 1 : 0);

	return {
		id: Number(result.lastInsertRowid),
		email,
		displayName,
		isAdmin: isFirstUser
	};
}

export function loginUser(email: string, password: string): SessionUser {
	const row = db
		.prepare(
			'SELECT id, email, password_hash, display_name, is_admin, disabled FROM users WHERE email = ?'
		)
		.get(email.trim().toLowerCase()) as
		| {
				id: number;
				email: string;
				password_hash: string;
				display_name: string;
				is_admin: number;
				disabled: number;
		  }
		| undefined;

	// Same error for unknown email and bad password — don't leak which.
	if (!row || !verifyPassword(password, row.password_hash))
		throw new AuthError('Invalid email or password.', 'bad_credentials');
	if (row.disabled) throw new AuthError('This account has been disabled.', 'disabled');

	return {
		id: row.id,
		email: row.email,
		displayName: row.display_name,
		isAdmin: row.is_admin === 1
	};
}

// ---------- Invites ----------

function redeemInvite(code: string): void {
	const invite = db
		.prepare('SELECT id, max_uses, used_count, revoked, expires_at FROM invites WHERE code = ?')
		.get(code.trim().toUpperCase()) as
		| { id: number; max_uses: number; used_count: number; revoked: number; expires_at: string | null }
		| undefined;

	if (!invite) throw new AuthError('That invite code is not valid.', 'bad_invite');
	if (invite.revoked) throw new AuthError('That invite code has been revoked.', 'bad_invite');
	if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now())
		throw new AuthError('That invite code has expired.', 'bad_invite');
	if (invite.used_count >= invite.max_uses)
		throw new AuthError('That invite code has already been used.', 'bad_invite');

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
