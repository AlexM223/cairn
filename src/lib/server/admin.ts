import { db } from './db';
import { destroyUserSessions, generateInviteCode, AuthError } from './auth';
import type { AdminUserInfo, InviteInfo } from '$lib/types';

// ---------- Users ----------

export function listUsers(): AdminUserInfo[] {
	const rows = db
		.prepare(
			`SELECT u.id, u.email, u.display_name, u.is_admin, u.disabled, u.created_at, u.last_login,
			        u.password_hash,
			        (SELECT COUNT(*) FROM wallets w WHERE w.user_id = u.id)
			          + (SELECT COUNT(*) FROM multisigs m WHERE m.user_id = u.id) AS wallet_count,
			        (SELECT COUNT(*) FROM user_credentials c WHERE c.user_id = u.id) AS credential_count
			 FROM users u ORDER BY u.created_at ASC`
		)
		.all() as {
		id: number;
		email: string;
		display_name: string;
		is_admin: number;
		disabled: number;
		created_at: string;
		last_login: string | null;
		password_hash: string | null;
		wallet_count: number;
		credential_count: number;
	}[];

	return rows.map((r) => ({
		id: r.id,
		email: r.email,
		displayName: r.display_name,
		isAdmin: r.is_admin === 1,
		disabled: r.disabled === 1,
		createdAt: r.created_at,
		lastActivity: activityBucket(r.last_login),
		walletCount: r.wallet_count,
		// The shape a backup restore produces (cairn-j1q9): no passkey AND no
		// password — this account cannot sign in until an admin mints it a
		// recovery code.
		needsRecoveryCode: r.credential_count === 0 && !r.password_hash
	}));
}

/** 30-day window separating "around lately" from "inactive". */
const ACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60_000;

/**
 * Coarsen an exact last_login into the bucket the admin user list shows
 * (cairn-o1dp.6) — the precise timestamp stays in the DB but never leaves the
 * server for this surface.
 */
function activityBucket(lastLogin: string | null): AdminUserInfo['lastActivity'] {
	if (!lastLogin) return 'never';
	const t = Date.parse(lastLogin);
	if (Number.isNaN(t)) return 'never';
	return Date.now() - t <= ACTIVITY_WINDOW_MS ? 'recent' : 'inactive';
}

/** One user's admin-facing info, or null if no such id. Used by /admin/users/[id]. */
export function getUser(id: number): AdminUserInfo | null {
	return listUsers().find((u) => u.id === id) ?? null;
}

function adminCount(): number {
	const row = db
		.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0')
		.get() as { n: number };
	return row.n;
}

function getUserRow(id: number) {
	return db.prepare('SELECT id, is_admin, disabled FROM users WHERE id = ?').get(id) as
		| { id: number; is_admin: number; disabled: number }
		| undefined;
}

export function setUserDisabled(id: number, disabled: boolean): void {
	const user = getUserRow(id);
	if (!user) throw new AuthError('User not found.', 'not_found');
	if (disabled && user.is_admin === 1 && user.disabled === 0 && adminCount() <= 1)
		throw new AuthError('Cannot disable the only administrator.', 'last_admin');

	db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
	if (disabled) destroyUserSessions(id);
}

export function setUserAdmin(id: number, isAdmin: boolean): void {
	const user = getUserRow(id);
	if (!user) throw new AuthError('User not found.', 'not_found');
	if (!isAdmin && user.is_admin === 1 && adminCount() <= 1)
		throw new AuthError('Cannot demote the only administrator.', 'last_admin');

	db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
}

export function deleteUser(id: number): void {
	const user = getUserRow(id);
	if (!user) throw new AuthError('User not found.', 'not_found');
	if (user.is_admin === 1 && user.disabled === 0 && adminCount() <= 1)
		throw new AuthError('Cannot delete the only administrator.', 'last_admin');

	db.prepare('DELETE FROM users WHERE id = ?').run(id); // sessions + wallets cascade
	// notified_txids has no FK, so it does not cascade with the user (cairn-zari).
	db.prepare('DELETE FROM notified_txids WHERE user_id = ?').run(id);
}

/**
 * Factory-reset the instance: delete every user, session, wallet, invite,
 * setting, encrypted instance secret (SMTP/Core-RPC/Telegram/Nostr
 * credentials, scheduled-backup passphrase) and feature-flag override in one
 * transaction. The next visit to /signup is the first-run flow again (the
 * first account created becomes admin). The caller's own session is wiped
 * along with everything else — that is intentional.
 */
export function resetInstance(): void {
	db.prepare('BEGIN').run();
	try {
		// feature_flags/user_feature_flags.updated_by have no ON DELETE action —
		// a plain `DELETE FROM users` would violate the FK (cairn-hl87).
		// feature_flags itself is instance-wide config with no user_id to cascade
		// from, so it is deleted outright below (not just nulled) — a "reset"
		// instance must not inherit the prior operator's flag overrides. It MUST
		// run before `DELETE FROM users` in the block below: deleting the row
		// satisfies the same NO-ACTION FK concern the null-first idiom existed
		// for, but only if it happens first (cairn-rksw regression: doing this
		// delete alongside the others, after `DELETE FROM users`, still throws).
		db.prepare('DELETE FROM feature_flags').run();
		db.prepare('UPDATE user_feature_flags SET updated_by = NULL').run();

		db.exec(`
			DELETE FROM wallets;
			DELETE FROM invites;
			DELETE FROM sessions;
			DELETE FROM users;
			DELETE FROM settings;
			-- instance_secrets holds the encrypted SMTP/Core-RPC/Telegram-bot-token/
			-- Nostr-privkey credentials (settings.ts setSecretSetting, secretKey.ts
			-- envelopes — cairn-e9mz.4) plus the scheduled-backup passphrase
			-- (backup.ts K_SCHED_PASS). None of these rows have a user_id to cascade
			-- from, so a factory reset silently left every one of them behind for
			-- the next operator to inherit — a confidentiality leak on device
			-- handover/resale (cairn-rksw).
			DELETE FROM instance_secrets;
			-- Instance-wide activity (events.user_id IS NULL) and the notified-txid
			-- ledger have no FK target to cascade from, so they must be cleared
			-- explicitly. Otherwise a new operator sees the prior instance's activity
			-- history and dedup state, contradicting the "nothing else survives" copy
			-- in the reset danger-zone (cairn-5s8y, cairn-zari).
			DELETE FROM events;
			DELETE FROM notified_txids;
			-- Instance-level marketing content also has no user FK to cascade from
			-- (dismissals do cascade with users; the announcements/referral rows
			-- themselves belong to the instance being reset).
			DELETE FROM announcements;
			DELETE FROM multisig_service_referrals;
		`);
		db.prepare('COMMIT').run();
	} catch (e) {
		db.prepare('ROLLBACK').run();
		throw e;
	}
}

// ---------- Invites ----------

function inviteStatus(r: {
	revoked: number;
	expires_at: string | null;
	used_count: number;
	max_uses: number;
}): InviteInfo['status'] {
	if (r.revoked) return 'revoked';
	if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) return 'expired';
	if (r.used_count >= r.max_uses) return 'exhausted';
	return 'active';
}

export function listInvites(): InviteInfo[] {
	const rows = db
		.prepare(
			`SELECT i.*, u.display_name AS created_by_name
			 FROM invites i LEFT JOIN users u ON u.id = i.created_by
			 ORDER BY i.created_at DESC`
		)
		.all() as {
		id: number;
		code: string;
		label: string | null;
		created_by: number;
		created_by_name: string | null;
		max_uses: number;
		used_count: number;
		revoked: number;
		expires_at: string | null;
		created_at: string;
	}[];

	return rows.map((r) => ({
		id: r.id,
		code: r.code,
		label: r.label,
		createdBy: r.created_by,
		createdByName: r.created_by_name ?? undefined,
		maxUses: r.max_uses,
		usedCount: r.used_count,
		expiresAt: r.expires_at,
		createdAt: r.created_at,
		status: inviteStatus(r)
	}));
}

export interface CreateInvitesInput {
	createdBy: number;
	count: number; // batch size
	label?: string;
	maxUses?: number;
	expiresDays?: number | null;
}

export function createInvites(input: CreateInvitesInput): InviteInfo[] {
	const count = Math.min(Math.max(1, input.count || 1), 50);
	const maxUses = Math.min(Math.max(1, input.maxUses || 1), 1000);
	const expiresAt =
		input.expiresDays && input.expiresDays > 0
			? new Date(Date.now() + input.expiresDays * 86400_000).toISOString()
			: null;

	const insert = db.prepare(
		'INSERT INTO invites (code, label, created_by, max_uses, expires_at) VALUES (?, ?, ?, ?, ?)'
	);
	const created: number[] = [];
	for (let i = 0; i < count; i++) {
		// Retry on the (vanishingly rare) code collision.
		for (let attempt = 0; ; attempt++) {
			try {
				const res = insert.run(
					generateInviteCode(),
					input.label?.trim() || null,
					input.createdBy,
					maxUses,
					expiresAt
				);
				created.push(Number(res.lastInsertRowid));
				break;
			} catch (e) {
				if (attempt >= 3) throw e;
			}
		}
	}

	return listInvites().filter((i) => created.includes(i.id));
}

export function revokeInvite(id: number): void {
	db.prepare('UPDATE invites SET revoked = 1 WHERE id = ?').run(id);
}

// ---------- Overview ----------

export function instanceStats(): {
	users: number;
	admins: number;
	wallets: number;
	activeInvites: number;
} {
	const users = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
	// Count single-sig AND multisig wallets, mirroring listUsers()'s per-user
	// total — the Overview page previously omitted multisigs (cairn-xqfb).
	const singleSig = (db.prepare('SELECT COUNT(*) AS n FROM wallets').get() as { n: number }).n;
	const multisig = (db.prepare('SELECT COUNT(*) AS n FROM multisigs').get() as { n: number }).n;
	const activeInvites = listInvites().filter((i) => i.status === 'active').length;
	return { users, admins: adminCount(), wallets: singleSig + multisig, activeInvites };
}
