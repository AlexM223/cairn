// Personal access tokens (cairn-ivae.1): let a user script against their own
// instance (pull balances into a spreadsheet, trigger a backup from cron, build
// a companion CLI) without replaying their browser session cookie.
//
// Deliberately UNSCOPED in v1 — a token is the user, full stop (Nextcloud's
// app-passwords model). Per-resource scoping can follow once real usage shows
// what needs restricting. Storage mirrors the sessions table exactly: only a
// SHA-256 hash of the token is ever persisted (auth.ts's hashToken), the raw
// value is shown once at creation and can never be retrieved again.
//
// Consumed by requireUser()/requireAdmin() in api.ts, which accept
// `Authorization: Bearer cairn_<secret>` alongside the session cookie and
// resolve it to the same SessionUser context.

import { randomBytes } from 'node:crypto';
import { db } from './db';
import { hashToken } from './auth';
import { childLogger } from './logger';
import { containsNulByte } from './textGuard';
import type { SessionUser } from '$lib/types';

// Security-event log — token issuance/revocation/abuse belongs in /admin/logs,
// same convention as auth.ts. Token values and hashes are never logged.
const log = childLogger('security');

// Schema lives here (not db.ts) so the whole feature is one self-contained
// module; the CREATE is idempotent and runs when the module first loads, which
// is before any route can call into it. Same guarded-migration convention as
// the rest of the schema.
db.exec(`
	CREATE TABLE IF NOT EXISTS api_tokens (
		id           INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		name         TEXT NOT NULL,
		token_hash   TEXT NOT NULL UNIQUE,
		created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
		expires_at   TEXT,             -- NULL = never expires
		last_used_at TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
`);

/** Recognizable prefix (GitHub-style) so a leaked token is greppable by secret
 *  scanners and unambiguous in a config file. */
export const TOKEN_PREFIX = 'cairn_';

/** Sanity cap — a user who wants more than this is probably automating token
 *  creation itself, which unscoped tokens shouldn't encourage. */
export const MAX_TOKENS_PER_USER = 25;

export const MAX_TOKEN_NAME_LENGTH = 64;

export interface ApiTokenInfo {
	id: number;
	name: string;
	createdAt: string;
	expiresAt: string | null;
	lastUsedAt: string | null;
}

export class ApiTokenError extends Error {}

/**
 * Issue a new token for a user. Returns the RAW token — the only time it ever
 * exists outside the caller's hands; only its hash is stored. `expiresDays`
 * null/undefined = never expires (the Nextcloud app-password default).
 */
export function createApiToken(
	userId: number,
	name: string,
	expiresDays?: number | null
): { id: number; token: string; name: string; expiresAt: string | null } {
	const trimmed = name.trim().slice(0, MAX_TOKEN_NAME_LENGTH);
	if (!trimmed) throw new ApiTokenError('Give the token a name so you can recognize it later.');
	// Reject an embedded NUL rather than let node:sqlite silently truncate the
	// token name at it on write (cairn-y73r/cairn-x5m9) — see textGuard.ts.
	if (containsNulByte(trimmed)) {
		throw new ApiTokenError('Token name contains a NUL character (U+0000), which cannot be stored.');
	}
	if (expiresDays != null && (!Number.isInteger(expiresDays) || expiresDays < 1 || expiresDays > 3650)) {
		throw new ApiTokenError('Expiry must be between 1 and 3650 days.');
	}

	const { n } = db
		.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?')
		.get(userId) as { n: number };
	if (n >= MAX_TOKENS_PER_USER) {
		throw new ApiTokenError(
			`You already have ${MAX_TOKENS_PER_USER} tokens — revoke one you no longer use first.`
		);
	}

	const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
	const expiresAt =
		expiresDays != null ? new Date(Date.now() + expiresDays * 86_400_000).toISOString() : null;
	const res = db
		.prepare('INSERT INTO api_tokens (user_id, name, token_hash, expires_at) VALUES (?, ?, ?, ?)')
		.run(userId, trimmed, hashToken(token), expiresAt);
	const id = Number(res.lastInsertRowid);
	log.info({ event: 'api_token_created', userId, tokenId: id }, 'API token created');
	return { id, token, name: trimmed, expiresAt };
}

/** A user's tokens, newest first — metadata only, never hashes. */
export function listApiTokens(userId: number): ApiTokenInfo[] {
	const rows = db
		.prepare(
			`SELECT id, name, created_at, expires_at, last_used_at
			   FROM api_tokens WHERE user_id = ? ORDER BY id DESC`
		)
		.all(userId) as {
		id: number;
		name: string;
		created_at: string;
		expires_at: string | null;
		last_used_at: string | null;
	}[];
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		createdAt: r.created_at,
		expiresAt: r.expires_at,
		lastUsedAt: r.last_used_at
	}));
}

/** Revoke (delete) one of the user's own tokens. Effective immediately — the
 *  next Bearer request with it gets a 401. */
export function revokeApiToken(userId: number, id: number): boolean {
	const res = db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(id, userId);
	if (res.changes > 0) {
		log.info({ event: 'api_token_revoked', userId, tokenId: id }, 'API token revoked');
	}
	return res.changes > 0;
}

/**
 * Resolve a raw Bearer token to its user — the token-side twin of
 * getSessionUser(). Null for anything unknown, expired, or belonging to a
 * disabled account. Expired rows are deleted on touch (same lazy cleanup as
 * sessions); live rows get last_used_at bumped so the settings UI can show
 * which tokens are actually in use.
 */
export function getApiTokenUser(token: string): SessionUser | null {
	if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
	const tokenHash = hashToken(token);
	const row = db
		.prepare(
			`SELECT t.id, t.expires_at, u.id AS user_id, u.email, u.display_name, u.is_admin, u.disabled
			   FROM api_tokens t JOIN users u ON u.id = t.user_id
			  WHERE t.token_hash = ?`
		)
		.get(tokenHash) as
		| {
				id: number;
				expires_at: string | null;
				user_id: number;
				email: string;
				display_name: string;
				is_admin: number;
				disabled: number;
		  }
		| undefined;

	if (!row) return null;
	if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
		db.prepare('DELETE FROM api_tokens WHERE id = ?').run(row.id);
		return null;
	}
	if (row.disabled) return null;

	db.prepare(
		`UPDATE api_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
	).run(row.id);

	return {
		id: row.user_id,
		email: row.email,
		displayName: row.display_name,
		isAdmin: row.is_admin === 1
	};
}

// ------------------------------------------------- invalid-token throttling
//
// Mirrors rateLimit.ts's fixed-window in-memory failure counters (same
// single-process rationale documented there). A Bearer header is a credential
// like a password: an attacker spraying guessed tokens must hit a wall. Only
// FAILURES count — normal scripted use (the whole point of tokens) is never
// throttled here; per-user limits on specific endpoints (e.g. contacts) apply
// to token requests automatically because the token resolves to the same user.

const WINDOW_MS = 15 * 60_000;
/** Invalid Bearer attempts per IP per window — matches rateLimit's loginIp. */
const BEARER_IP_LIMIT = 20;

const failures = new Map<string, { count: number; windowStart: number }>();

/** Seconds until the IP may try another Bearer auth, or null if under limit. */
export function bearerRetryAfter(ip: string): number | null {
	const b = failures.get(ip);
	if (!b) return null;
	if (Date.now() - b.windowStart > WINDOW_MS) {
		failures.delete(ip);
		return null;
	}
	if (b.count < BEARER_IP_LIMIT) return null;
	const wait = Math.max(1, Math.ceil((b.windowStart + WINDOW_MS - Date.now()) / 1000));
	log.warn({ event: 'bearer_throttled', ip, retryAfter: wait }, 'Bearer auth throttled by rate limiter');
	return wait;
}

export function noteBearerFailure(ip: string): void {
	// Opportunistic sweep so the map can't grow without bound under attack.
	if (failures.size > 10_000) {
		const now = Date.now();
		for (const [k, v] of failures) if (now - v.windowStart > WINDOW_MS) failures.delete(k);
	}
	const b = failures.get(ip);
	if (b && Date.now() - b.windowStart <= WINDOW_MS) b.count++;
	else failures.set(ip, { count: 1, windowStart: Date.now() });
	log.warn({ event: 'bearer_auth_failed', ip }, 'invalid API token presented');
}

export function noteBearerSuccess(ip: string): void {
	failures.delete(ip);
}
