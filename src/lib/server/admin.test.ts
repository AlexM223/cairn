import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser, createSession, getSessionUser } from './auth';
import { setSetting } from './settings';
import {
	listUsers,
	setUserAdmin,
	setUserDisabled,
	deleteUser,
	createInvites,
	revokeInvite,
	listInvites,
	instanceStats,
	resetInstance
} from './admin';

function wipe(): void {
	db.exec('DELETE FROM sessions; DELETE FROM wallets; DELETE FROM invites; DELETE FROM users; DELETE FROM settings;');
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

const PASSWORD = 'correct horse battery';

function makeUser(email: string) {
	return registerUser({ email, password: PASSWORD, displayName: email.split('@')[0] });
}

describe('admin guards', () => {
	it('setUserAdmin refuses to demote the only admin', () => {
		const admin = makeUser('admin@example.com');
		expect(() => setUserAdmin(admin.id, false)).toThrowError(
			expect.objectContaining({ code: 'last_admin' })
		);
	});

	it('setUserDisabled refuses to disable the only admin', () => {
		const admin = makeUser('admin@example.com');
		expect(() => setUserDisabled(admin.id, true)).toThrowError(
			expect.objectContaining({ code: 'last_admin' })
		);
	});

	it('deleteUser refuses to delete the only admin', () => {
		const admin = makeUser('admin@example.com');
		expect(() => deleteUser(admin.id)).toThrowError(
			expect.objectContaining({ code: 'last_admin' })
		);
	});

	it('demoting works once a second admin exists', () => {
		const admin = makeUser('admin@example.com');
		const second = makeUser('second@example.com');
		setUserAdmin(second.id, true);
		setUserAdmin(admin.id, false);

		const users = listUsers();
		expect(users.find((u) => u.id === admin.id)?.isAdmin).toBe(false);
		expect(users.find((u) => u.id === second.id)?.isAdmin).toBe(true);
	});

	it('disabling an admin works once a second admin exists, and kills their sessions', () => {
		const admin = makeUser('admin@example.com');
		const second = makeUser('second@example.com');
		setUserAdmin(second.id, true);

		const { token } = createSession(admin.id);
		setUserDisabled(admin.id, true);

		expect(listUsers().find((u) => u.id === admin.id)?.disabled).toBe(true);
		expect(getSessionUser(token)).toBeNull();
		const n = (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(admin.id) as {
			n: number;
		}).n;
		expect(n).toBe(0);
	});

	it('setUserAdmin / setUserDisabled / deleteUser throw not_found for missing users', () => {
		expect(() => setUserAdmin(9999, true)).toThrowError(
			expect.objectContaining({ code: 'not_found' })
		);
		expect(() => setUserDisabled(9999, true)).toThrowError(
			expect.objectContaining({ code: 'not_found' })
		);
		expect(() => deleteUser(9999)).toThrowError(expect.objectContaining({ code: 'not_found' }));
	});

	it('deleteUser cascades to sessions and wallets', () => {
		makeUser('admin@example.com');
		const user = makeUser('user@example.com');
		createSession(user.id);
		db.prepare(
			"INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'w', 'xpub-test', 'p2wpkh')"
		).run(user.id);

		deleteUser(user.id);

		const sessions = (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(user.id) as {
			n: number;
		}).n;
		const wallets = (db.prepare('SELECT COUNT(*) AS n FROM wallets WHERE user_id = ?').get(user.id) as {
			n: number;
		}).n;
		expect(sessions).toBe(0);
		expect(wallets).toBe(0);
		expect(listUsers().some((u) => u.id === user.id)).toBe(false);
	});
});

describe('invites', () => {
	it('createInvites creates the requested batch with CAIRN-prefixed codes', () => {
		const admin = makeUser('admin@example.com');
		const invites = createInvites({ createdBy: admin.id, count: 3, label: 'friends' });
		expect(invites).toHaveLength(3);
		for (const invite of invites) {
			expect(invite.code).toMatch(/^CAIRN-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
			expect(invite.label).toBe('friends');
			expect(invite.status).toBe('active');
			expect(invite.usedCount).toBe(0);
		}
		// Codes are unique.
		expect(new Set(invites.map((i) => i.code)).size).toBe(3);
	});

	it('revokeInvite flips status to revoked', () => {
		const admin = makeUser('admin@example.com');
		const [invite] = createInvites({ createdBy: admin.id, count: 1 });
		revokeInvite(invite.id);
		expect(listInvites().find((i) => i.id === invite.id)?.status).toBe('revoked');
	});

	it('reports exhausted and expired statuses', () => {
		const admin = makeUser('admin@example.com');
		const [used, expired] = createInvites({ createdBy: admin.id, count: 2, maxUses: 1 });
		db.prepare('UPDATE invites SET used_count = 1 WHERE id = ?').run(used.id);
		db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run(
			new Date(Date.now() - 1000).toISOString(),
			expired.id
		);
		const byId = new Map(listInvites().map((i) => [i.id, i.status]));
		expect(byId.get(used.id)).toBe('exhausted');
		expect(byId.get(expired.id)).toBe('expired');
	});
});

describe('resetInstance', () => {
	it('wipes users, sessions, wallets, invites and settings', () => {
		const admin = makeUser('admin@example.com');
		const user = makeUser('user@example.com');
		createSession(admin.id);
		createSession(user.id);
		createInvites({ createdBy: admin.id, count: 2 });
		db.prepare(
			"INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'w', 'xpub-test', 'p2wpkh')"
		).run(user.id);

		resetInstance();

		for (const table of ['users', 'sessions', 'wallets', 'invites', 'settings']) {
			const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
			expect(n, table).toBe(0);
		}
		// Back to first-run: the next registration becomes the admin.
		const fresh = registerUser({ email: 'new@example.com', password: PASSWORD, displayName: 'new' });
		expect(fresh.isAdmin).toBe(true);
	});
});

describe('instanceStats', () => {
	it('counts users, active admins and active invites', () => {
		const admin = makeUser('admin@example.com');
		makeUser('user@example.com');
		const [invite] = createInvites({ createdBy: admin.id, count: 2 });
		revokeInvite(invite.id);

		expect(instanceStats()).toEqual({ users: 2, admins: 1, wallets: 0, activeInvites: 1 });
	});
});
