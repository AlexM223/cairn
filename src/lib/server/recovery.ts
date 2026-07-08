// Account recovery — getting back INTO Cairn (your LOGIN) after losing every
// passkey. This is a COMPLETELY DIFFERENT thing from bitcoin recovery.
//
//   • A Cairn recovery phrase / recovery code restores the LOGIN only. It can
//     NEVER move, spend, or reveal any bitcoin. Your bitcoin keys live on the
//     hardware wallet and are untouched by anything in this file.
//   • A hardware-wallet SEED phrase (the 12/24 words your Trezor/Ledger showed
//     you) is what controls bitcoin. Cairn never sees it and never stores it.
//
// The Cairn recovery phrase is generated as a valid BIP39 mnemonic ONLY to get
// BIP39's built-in checksum (free typo detection) and a vetted wordlist — it is
// NOT a bitcoin key and is never used as a seed.
//
// Everything here is stored as salted scrypt hashes (reusing auth.ts's
// hashPassword/verifyPassword format) — never plaintext. Verification is
// timing-safe (scrypt + timingSafeEqual inside verifyPassword) and never throws
// on an unknown user or absent secret; callers that must avoid user-enumeration
// use dummyVerify() to burn the same work when a secret is absent.

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { env } from '$env/dynamic/private';
import { db } from './db';
import { hashPassword, verifyPassword } from './auth';
import { childLogger } from './logger';
import { recordActivity } from './activity';

const log = childLogger('recovery');

// A pre-computed scrypt hash of a throwaway value, used to spend equivalent CPU
// when the real secret is absent so timing can't reveal whether a user/secret
// exists. Computed once at module load.
const DUMMY_HASH = hashPassword('cairn-recovery-dummy-verify-target');

/**
 * Burn one scrypt verification's worth of work and return false. Call this
 * instead of returning early when the target user or secret does not exist, so
 * the "unknown" path costs the same as a real "wrong secret" path.
 */
export function dummyVerify(input: string): boolean {
	verifyPassword(input, DUMMY_HASH);
	return false;
}

// ---------------------------------------------------------------- normalization

/**
 * Normalize a recovery phrase for hashing/comparison: NFKD, lowercased, trimmed,
 * and collapsed to single spaces. Applied identically on generate and verify so
 * that differing case or spacing still matches. (BIP39 English words are ASCII,
 * but NFKD is applied defensively in case a device or clipboard introduces
 * compatibility characters.)
 */
export function normalizePhrase(input: string): string {
	return input.normalize('NFKD').trim().toLowerCase().replace(/\s+/g, ' ');
}

// -------------------------------------------------------------- recovery phrase

export interface GeneratedPhrase {
	/** The 12-word phrase to show the user ONCE. Never persisted in plaintext. */
	phrase: string;
	/** Persist the (hashed) phrase for `userId`, replacing any existing one. */
	store(userId: number): void;
}

/**
 * Generate a fresh 12-word Cairn recovery phrase (a valid BIP39 mnemonic for its
 * checksum only — NOT a bitcoin key). Returns the plaintext phrase plus a
 * `store(userId)` fn that hashes and persists it, replacing any prior phrase.
 * The plaintext is only ever in memory here and in the one response that shows
 * it to the user.
 */
export function generateRecoveryPhrase(): GeneratedPhrase {
	const phrase = generateMnemonic(wordlist, 128); // 128 bits → 12 words
	return {
		phrase,
		store(userId: number): void {
			const hash = hashPassword(normalizePhrase(phrase));
			// Replace any existing phrase (UNIQUE on user_id).
			db.prepare(
				`INSERT INTO account_recovery_phrases (user_id, phrase_hash)
				 VALUES (?, ?)
				 ON CONFLICT(user_id) DO UPDATE SET phrase_hash = excluded.phrase_hash,
				     created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
			).run(userId, hash);
		}
	};
}

/**
 * Verify a submitted recovery phrase against the user's stored hash. Normalizes
 * identically, scrypt-verifies (timing-safe), and NEVER throws — returns false
 * for an unknown user or when no phrase is stored (burning equivalent work so
 * absence isn't observable via timing). A phrase is reusable: verifying it does
 * NOT consume it.
 */
export function verifyRecoveryPhrase(userId: number, input: string): boolean {
	const normalized = normalizePhrase(input);
	const row = db
		.prepare('SELECT phrase_hash FROM account_recovery_phrases WHERE user_id = ?')
		.get(userId) as { phrase_hash: string } | undefined;
	if (!row) return dummyVerify(normalized);
	return verifyPassword(normalized, row.phrase_hash);
}

// --------------------------------------------------------------- recovery codes

/** How many one-time recovery codes a full set contains. */
export const RECOVERY_CODE_COUNT = 8;

// Crockford base32 without the ambiguous 0/O/1/I/L/U — same readability goal as
// the invite alphabet, but higher entropy per code.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const CODE_GROUPS = 2;
const CODE_GROUP_LEN = 5; // 10 chars total → ~49 bits of entropy per code.

/** One random, human-formatted recovery code, e.g. "K7QMP-3XR9T". */
function makeCode(): string {
	const groups: string[] = [];
	for (let g = 0; g < CODE_GROUPS; g++) {
		const bytes = randomBytes(CODE_GROUP_LEN);
		let s = '';
		for (let i = 0; i < CODE_GROUP_LEN; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
		groups.push(s);
	}
	return groups.join('-');
}

/**
 * Normalize a recovery code for hashing/comparison: uppercase, trim, strip all
 * non-alphanumerics (so the user may type it with or without the dash/spaces).
 */
export function normalizeCode(input: string): string {
	return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface GeneratedCodes {
	/** The 8 plaintext codes to show the user ONCE. Never persisted in plaintext. */
	codes: string[];
	/** Persist the (individually hashed) codes for `userId`, replacing the prior set. */
	store(userId: number): void;
}

/**
 * Generate a fresh set of 8 single-use recovery codes. Returns the plaintext
 * codes plus a `store(userId)` fn that hashes each one and persists the set,
 * REPLACING any prior set for that user (old codes stop working). Each code is
 * hashed independently with its own salt.
 */
export function generateRecoveryCodes(): GeneratedCodes {
	const codes = Array.from({ length: RECOVERY_CODE_COUNT }, makeCode);
	return {
		codes,
		store(userId: number): void {
			const insert = db.prepare(
				'INSERT INTO account_recovery_codes (user_id, code_hash) VALUES (?, ?)'
			);
			const del = db.prepare('DELETE FROM account_recovery_codes WHERE user_id = ?');
			db.exec('BEGIN');
			try {
				del.run(userId);
				for (const code of codes) insert.run(userId, hashPassword(normalizeCode(code)));
				db.exec('COMMIT');
			} catch (e) {
				db.exec('ROLLBACK');
				throw e;
			}
		}
	};
}

/**
 * Mint a single admin-issued recovery code for `userId` (cairn-j1q9). This is
 * the out-of-band replacement for the old public "reclaim by email" path: an
 * account restored from a backup arrives with no password and no passkeys (a
 * backup never contains credentials), so it has no way back in on its own. An
 * admin hands the owner this one code out-of-band; they redeem it at /recover.
 *
 * Deletes the user's existing UNUSED codes FIRST, then inserts exactly one new
 * one — this preserves the <= RECOVERY_CODE_COUNT unused-codes invariant
 * consumeRecoveryCode's constant-work scan depends on (it iterates exactly
 * RECOVERY_CODE_COUNT rows; a 9th unused code would silently never be checked
 * and so could never be redeemed). Already-USED codes are left alone — they
 * don't count toward the invariant and are harmless history. Runs in one
 * transaction so a crash between the delete and insert can't leave the user
 * with zero codes. Returns the plaintext code — shown once, never persisted.
 */
export function mintAdminRecoveryCode(userId: number): string {
	const code = makeCode();
	db.exec('BEGIN');
	try {
		db.prepare('DELETE FROM account_recovery_codes WHERE user_id = ? AND used_at IS NULL').run(
			userId
		);
		db.prepare('INSERT INTO account_recovery_codes (user_id, code_hash) VALUES (?, ?)').run(
			userId,
			hashPassword(normalizeCode(code))
		);
		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	}
	return code;
}

/**
 * Verify a submitted recovery code against the user's UNUSED codes and, on a
 * match, atomically mark that one code used so it can never be spent twice
 * (even under concurrency). Returns whether a code was consumed. NEVER throws;
 * returns false for an unknown user or when no unused code matches, burning
 * equivalent scrypt work when there is nothing to compare against.
 *
 * Constant work / no enumeration oracle: this always performs exactly
 * RECOVERY_CODE_COUNT scrypt verifications — real ones for the user's unused
 * codes, dummy ones to pad — regardless of how many codes exist or whether the
 * user exists at all, and never breaks early on a match. A naive early-return
 * loop would make a real account with codes respond measurably slower than an
 * unknown email (up to 8 scrypt ops vs 1), leaking account existence via timing.
 *
 * Concurrency: the match is confirmed by scrypt, then spent with
 * `UPDATE ... WHERE id = ? AND used_at IS NULL`. Two racing requests submitting
 * the same code both match the hash, but only the first UPDATE changes a row
 * (changes === 1); the loser sees changes === 0, so exactly one consumption
 * succeeds.
 */
export function consumeRecoveryCode(userId: number, code: string): boolean {
	const normalized = normalizeCode(code);
	// Invariant: a user has at most RECOVERY_CODE_COUNT unused codes (a set of 8
	// is minted at once and regeneration replaces the set), so iterating exactly
	// that many covers every real code while keeping the scrypt cost constant.
	const rows = db
		.prepare(
			'SELECT id, code_hash FROM account_recovery_codes WHERE user_id = ? AND used_at IS NULL'
		)
		.all(userId) as { id: number; code_hash: string }[];

	let matchedId: number | null = null;
	for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
		const row = rows[i];
		if (!row) {
			dummyVerify(normalized);
			continue;
		}
		// Record only the first match but keep verifying the rest, so the number
		// of scrypt ops never depends on the match position.
		if (verifyPassword(normalized, row.code_hash) && matchedId === null) {
			matchedId = row.id;
		}
	}

	if (matchedId === null) return false;
	const res = db
		.prepare(
			`UPDATE account_recovery_codes SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			 WHERE id = ? AND used_at IS NULL`
		)
		.run(matchedId);
	return res.changes === 1;
}

// ------------------------------------------------------------- setup inspection

/** What recovery secrets a user currently has configured. */
export function hasRecoverySetup(userId: number): { phrase: boolean; codesRemaining: number } {
	const phrase = !!db
		.prepare('SELECT 1 FROM account_recovery_phrases WHERE user_id = ?')
		.get(userId);
	const { n } = db
		.prepare('SELECT COUNT(*) AS n FROM account_recovery_codes WHERE user_id = ? AND used_at IS NULL')
		.get(userId) as { n: number };
	return { phrase, codesRemaining: n };
}

// -------------------------------------------------------- recovery grant (login)

// A recovery grant is a short-lived, single-purpose authorization minted after a
// successful recovery verify. It authorizes ONLY registering a new passkey for
// exactly one user — it is NOT a session and grants NO app access. It mirrors
// the sessions table (opaque random token; only its sha256 is stored), so it
// survives a restart and needs no separate signing secret. The recover routes
// set the token in an httpOnly cookie; the passkey-registration route validates
// it via consumeRecoveryGrant() and, only then, attaches the passkey and starts
// a real session.

/** How long a recovery grant is valid — long enough for one passkey ceremony. */
export const RECOVERY_GRANT_TTL_MS = 10 * 60_000; // 10 minutes

/** Cookie carrying the opaque recovery-grant token between verify and register. */
export const RECOVERY_GRANT_COOKIE = 'cairn_recovery';

function hashGrantToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/**
 * Mint a recovery grant for `userId`. Returns the opaque token (to put in the
 * grant cookie) and its expiry. Only the token's hash is stored. Any prior
 * grants for the user are cleared so a recovery attempt supersedes an earlier
 * one.
 */
export function createRecoveryGrant(userId: number): { token: string; expiresAt: Date } {
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(Date.now() + RECOVERY_GRANT_TTL_MS);
	db.prepare('DELETE FROM recovery_grants WHERE user_id = ?').run(userId);
	db.prepare(
		"INSERT INTO recovery_grants (token_hash, user_id, purpose, expires_at) VALUES (?, ?, 'register_passkey', ?)"
	).run(hashGrantToken(token), userId, expiresAt.toISOString());
	return { token, expiresAt };
}

/**
 * Resolve a recovery-grant token to the user id it authorizes, WITHOUT consuming
 * it (so the register `options` step can look up the user before the ceremony).
 * Returns null for an absent, unknown, or expired token (expired grants are
 * swept). Timing-safe token comparison against the stored hash.
 */
export function peekRecoveryGrant(token: string | undefined): { userId: number } | null {
	if (!token) return null;
	const hash = hashGrantToken(token);
	const row = db
		.prepare('SELECT user_id, token_hash, expires_at FROM recovery_grants WHERE token_hash = ?')
		.get(hash) as { user_id: number; token_hash: string; expires_at: string } | undefined;
	if (!row) return null;
	// Constant-time compare (the lookup already matched on hash, but keep the
	// comparison timing-safe against the fetched value).
	const a = Buffer.from(hash);
	const b = Buffer.from(row.token_hash);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	if (new Date(row.expires_at).getTime() < Date.now()) {
		db.prepare('DELETE FROM recovery_grants WHERE token_hash = ?').run(hash);
		return null;
	}
	return { userId: row.user_id };
}

/**
 * Consume a recovery-grant token: validate it and delete it atomically so it can
 * authorize exactly one passkey registration. Returns the authorized user id, or
 * null if the token is absent/unknown/expired. The DELETE ... WHERE token_hash
 * guard makes consumption single-use even under concurrency.
 */
export function consumeRecoveryGrant(token: string | undefined): { userId: number } | null {
	if (!token) return null;
	const hash = hashGrantToken(token);
	const row = db
		.prepare('SELECT user_id, expires_at FROM recovery_grants WHERE token_hash = ?')
		.get(hash) as { user_id: number; expires_at: string } | undefined;
	if (!row) return null;
	const res = db.prepare('DELETE FROM recovery_grants WHERE token_hash = ?').run(hash);
	if (res.changes !== 1) return null; // lost a concurrent consume race
	if (new Date(row.expires_at).getTime() < Date.now()) return null; // expired
	return { userId: row.user_id };
}

// ----------------------------------------------------- admin break-glass (env)

// Break-glass admin recovery: an escape hatch for the operator who has lost every
// passkey on the ADMIN account and cannot use the phrase/code flow either.
// GATED HARD and OFF by default. It authenticates the admin with the deployment
// password env var (the same one bootstrapAdminFromEnv seeds), and ONLY when:
//   • CAIRN_ADMIN_RECOVERY === 'true' (explicitly enabled), AND
//   • the login target is THE admin account (the bootstrap admin), AND
//   • that admin currently has NO usable passkeys, AND
//   • the submitted password equals CAIRN_ADMIN_PASSWORD (or APP_PASSWORD).
// It never widens normal password auth: with the env flag unset it always
// returns false, regardless of inputs.

/** The break-glass admin account (the bootstrap admin — first admin by id), or null. */
export function breakGlassAdmin(): { id: number; email: string } | null {
	const row = db
		.prepare(
			'SELECT id, email FROM users WHERE is_admin = 1 AND disabled = 0 ORDER BY id ASC LIMIT 1'
		)
		.get() as { id: number; email: string } | undefined;
	return row ? { id: row.id, email: row.email } : null;
}

/**
 * Decide whether an email+password login should be allowed via the admin
 * break-glass path. Pure gate + timing-safe password compare; the caller does
 * the session creation and logging. Returns the admin user id on success, else
 * null. OFF (always null) unless CAIRN_ADMIN_RECOVERY === 'true'.
 *
 * `hasNoPasskeys(userId)` is injected (from auth.hasNoCredentials) to avoid a
 * cross-module import cycle and to keep this unit-testable.
 */
export function tryAdminBreakGlass(
	email: string,
	password: string,
	hasNoPasskeys: (userId: number) => boolean
): { userId: number; email: string } | null {
	if (env.CAIRN_ADMIN_RECOVERY !== 'true') return null;

	const configured = env.CAIRN_ADMIN_PASSWORD ?? env.APP_PASSWORD;
	if (!configured) return null;

	const admin = breakGlassAdmin();
	if (!admin) return null;

	// Only the admin account, matched case-insensitively like the rest of auth.
	if (email.trim().toLowerCase() !== admin.email.trim().toLowerCase()) return null;

	// Break-glass is only for a locked-out admin: it must have no usable passkeys.
	if (!hasNoPasskeys(admin.id)) return null;

	// Timing-safe password comparison.
	const a = Buffer.from(password);
	const b = Buffer.from(configured);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

	return { userId: admin.id, email: admin.email };
}

/**
 * Record the break-glass login prominently: a WARN log line and an activity
 * event. Call after a successful tryAdminBreakGlass + session creation.
 */
export function recordBreakGlassLogin(userId: number, email: string): void {
	log.warn({ userId, email }, 'Admin recovery login via environment variable');
	recordActivity({
		type: 'admin_break_glass',
		level: 'warn',
		userId,
		message: 'Admin recovery login via environment variable (break-glass).'
	});
}
