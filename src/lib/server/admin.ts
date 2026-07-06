import { db } from './db';
import { destroyUserSessions, generateInviteCode, AuthError } from './auth';
import type { AdminUserInfo, InviteInfo } from '$lib/types';

// ---------- Users ----------

export function listUsers(): AdminUserInfo[] {
	const rows = db
		.prepare(
			`SELECT u.id, u.email, u.display_name, u.is_admin, u.disabled, u.created_at, u.last_login,
			        (SELECT COUNT(*) FROM wallets w WHERE w.user_id = u.id)
			          + (SELECT COUNT(*) FROM multisigs m WHERE m.user_id = u.id) AS wallet_count
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
		wallet_count: number;
	}[];

	return rows.map((r) => ({
		id: r.id,
		email: r.email,
		displayName: r.display_name,
		isAdmin: r.is_admin === 1,
		disabled: r.disabled === 1,
		createdAt: r.created_at,
		lastLogin: r.last_login,
		walletCount: r.wallet_count
	}));
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
 * Factory-reset the instance: delete every user, session, wallet, invite and
 * setting in one transaction. The next visit to /signup is the first-run flow
 * again (the first account created becomes admin). The caller's own session is
 * wiped along with everything else — that is intentional.
 */
export function resetInstance(): void {
	db.exec(`
		BEGIN;
		DELETE FROM wallets;
		DELETE FROM invites;
		DELETE FROM sessions;
		DELETE FROM users;
		DELETE FROM settings;
		-- Instance-wide activity (events.user_id IS NULL) and the notified-txid
		-- ledger have no FK target to cascade from, so they must be cleared
		-- explicitly. Otherwise a new operator sees the prior instance's activity
		-- history and dedup state, contradicting the "nothing else survives" copy
		-- in the reset danger-zone (cairn-5s8y, cairn-zari).
		DELETE FROM events;
		DELETE FROM notified_txids;
		COMMIT;
	`);
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
	const wallets = (db.prepare('SELECT COUNT(*) AS n FROM wallets').get() as { n: number }).n;
	const activeInvites = listInvites().filter((i) => i.status === 'active').length;
	return { users, admins: adminCount(), wallets, activeInvites };
}
