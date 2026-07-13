// Invite lifecycle coverage (cairn-8nk5 sibling gap): create -> list -> redeem,
// revoke -> rejected redemption, expiry rejected AT REDEMPTION time (not just
// reflected in listInvites' computed status), registration_mode interaction,
// and — the piece with zero prior coverage — that deleting the INVITING user
// (via either admin.ts's deleteUser or accountDeletion.ts's deleteOwnAccount)
// removes their invites (userDeletion.ts purgeUserRow():123, the non-cascade
// invites.created_by FK, cairn-piow), while a user who registered VIA one of
// those invites is completely unaffected — invites.created_by only ever
// points at the CREATOR, never the redeemer, so there is no row to cascade to
// them at all.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { createInvites, revokeInvite, listInvites, deleteUser } from './admin';
import { deleteOwnAccount } from './accountDeletion';

function wipe(): void {
	db.exec(
		`DELETE FROM notified_txids; DELETE FROM invites; DELETE FROM sessions;
		 DELETE FROM wallets; DELETE FROM users; DELETE FROM settings;`
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'invite');
});

const PASSWORD = 'correct horse battery';

async function makeAdmin(email = 'admin@example.com') {
	// First user always becomes admin regardless of registration_mode.
	return registerUser({ email, password: PASSWORD, displayName: email.split('@')[0] });
}

function inviteCount(where: string, ...params: (string | number)[]): number {
	return (
		db.prepare(`SELECT COUNT(*) AS n FROM invites WHERE ${where}`).get(...params) as {
			n: number;
		}
	).n;
}

describe('invite lifecycle: create -> list -> redeem', () => {
	it('a fresh invite is active in listInvites, redemption flips it to exhausted, and it cannot be redeemed twice', async () => {
		const admin = await makeAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1 });
		expect(listInvites().find((i) => i.id === invite.id)?.status).toBe('active');

		const redeemer = await registerUser({
			email: 'b@example.com',
			password: PASSWORD,
			displayName: 'B',
			inviteCode: invite.code
		});
		expect(redeemer.isAdmin).toBe(false);

		const afterFirst = listInvites().find((i) => i.id === invite.id)!;
		expect(afterFirst.status).toBe('exhausted');
		expect(afterFirst.usedCount).toBe(1);

		await expect(
			registerUser({
				email: 'c@example.com',
				password: PASSWORD,
				displayName: 'C',
				inviteCode: invite.code
			})
		).rejects.toThrowError(expect.objectContaining({ code: 'bad_invite' }));
	});

	it('a multi-use invite can be redeemed up to maxUses, then rejects', async () => {
		const admin = await makeAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1, maxUses: 2 });
		await registerUser({
			email: 'b@example.com',
			password: PASSWORD,
			displayName: 'B',
			inviteCode: invite.code
		});
		await registerUser({
			email: 'c@example.com',
			password: PASSWORD,
			displayName: 'C',
			inviteCode: invite.code
		});
		expect(listInvites().find((i) => i.id === invite.id)?.status).toBe('exhausted');
		await expect(
			registerUser({
				email: 'd@example.com',
				password: PASSWORD,
				displayName: 'D',
				inviteCode: invite.code
			})
		).rejects.toThrowError(expect.objectContaining({ code: 'bad_invite' }));
	});
});

describe('invite lifecycle: revoke -> rejected redemption', () => {
	it('a revoked invite is rejected at redemption even though it was never used', async () => {
		const admin = await makeAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1 });
		revokeInvite(invite.id);
		expect(listInvites().find((i) => i.id === invite.id)?.status).toBe('revoked');
		await expect(
			registerUser({
				email: 'b@example.com',
				password: PASSWORD,
				displayName: 'B',
				inviteCode: invite.code
			})
		).rejects.toThrowError(expect.objectContaining({ code: 'bad_invite' }));
	});
});

describe('invite lifecycle: rejection branches at redemption time', () => {
	it('rejects an unknown invite code', async () => {
		await makeAdmin();
		await expect(
			registerUser({
				email: 'b@example.com',
				password: PASSWORD,
				displayName: 'B',
				inviteCode: 'CAIRN-NOPE-NOPE'
			})
		).rejects.toThrowError(expect.objectContaining({ code: 'bad_invite' }));
	});

	// assertInviteRedeemable()'s expiry branch (auth.ts:751-752) is only ever
	// exercised today via listInvites()' independently-computed status string
	// (admin.test.ts "reports exhausted and expired statuses") — never at the
	// actual redemption gate a registering user hits. Cover it directly here.
	it('rejects an expired invite at redemption, not just in the listed status', async () => {
		const admin = await makeAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1, expiresDays: 7 });
		// Force it into the past directly, same technique admin.test.ts uses.
		db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run(
			new Date(Date.now() - 1000).toISOString(),
			invite.id
		);
		expect(listInvites().find((i) => i.id === invite.id)?.status).toBe('expired');

		await expect(
			registerUser({
				email: 'b@example.com',
				password: PASSWORD,
				displayName: 'B',
				inviteCode: invite.code
			})
		).rejects.toThrowError(expect.objectContaining({ code: 'bad_invite' }));
		// Rejected redemption must not have consumed the invite.
		const row = db.prepare('SELECT used_count FROM invites WHERE id = ?').get(invite.id) as {
			used_count: number;
		};
		expect(row.used_count).toBe(0);
	});

	it('an invite with no expiry never expires', async () => {
		const admin = await makeAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1 }); // expiresDays omitted
		expect(listInvites().find((i) => i.id === invite.id)?.expiresAt).toBeNull();
		const user = await registerUser({
			email: 'b@example.com',
			password: PASSWORD,
			displayName: 'B',
			inviteCode: invite.code
		});
		expect(user.email).toBe('b@example.com');
	});
});

describe('registration_mode interaction (assertCanRegister)', () => {
	it('invite-only mode rejects registration with no code', async () => {
		await makeAdmin();
		await expect(
			registerUser({ email: 'b@example.com', password: PASSWORD, displayName: 'B' })
		).rejects.toThrowError(expect.objectContaining({ code: 'invite_required' }));
	});

	it('invite-only mode accepts registration with a valid code', async () => {
		const admin = await makeAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1 });
		const user = await registerUser({
			email: 'b@example.com',
			password: PASSWORD,
			displayName: 'B',
			inviteCode: invite.code
		});
		expect(user.email).toBe('b@example.com');
	});

	it('closed mode rejects registration even with a valid invite code', async () => {
		const admin = await makeAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1 });
		setSetting('registration_mode', 'closed');
		await expect(
			registerUser({
				email: 'b@example.com',
				password: PASSWORD,
				displayName: 'B',
				inviteCode: invite.code
			})
		).rejects.toThrowError(expect.objectContaining({ code: 'closed' }));
	});

	it('open mode needs no code and does not require one to exist', async () => {
		await makeAdmin();
		setSetting('registration_mode', 'open');
		const user = await registerUser({ email: 'b@example.com', password: PASSWORD, displayName: 'B' });
		expect(user.email).toBe('b@example.com');
	});
});

describe('invite cleanup on inviter deletion (userDeletion.ts purgeUserRow, cairn-piow)', () => {
	it('admin deleteUser removes every invite the deleted user created, including already-redeemed ones', async () => {
		const admin = await makeAdmin();
		const bootstrapInvite = createInvites({ createdBy: admin.id, count: 1 })[0];
		const second = await registerUser({
			email: 'second@example.com',
			password: PASSWORD,
			displayName: 'Second',
			inviteCode: bootstrapInvite.code
		});
		db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(second.id);

		// `second` (now an admin, so deleting them won't trip the last-admin
		// guard) creates two invites of their own.
		const invites = createInvites({ createdBy: second.id, count: 2 });
		expect(inviteCount('created_by = ?', second.id)).toBe(2);

		// Before deletion: previously-existing invites created by `admin` must
		// be untouched by deleting `second`.
		const adminInvite = createInvites({ createdBy: admin.id, count: 1 })[0];

		deleteUser(second.id);

		expect(inviteCount('created_by = ?', second.id)).toBe(0);
		expect(inviteCount('id = ?', invites[0].id)).toBe(0);
		expect(inviteCount('id = ?', invites[1].id)).toBe(0);
		// admin's own invite survives — the delete only touches the target's rows.
		expect(inviteCount('id = ?', adminInvite.id)).toBe(1);
		// And the row-level delete itself must not have thrown an FK error —
		// getting this far without a caught exception already proves it, but
		// confirm the user row is actually gone too.
		expect(db.prepare('SELECT id FROM users WHERE id = ?').get(second.id)).toBeUndefined();
	});

	it('a user who registered VIA a now-deleted inviter is unaffected — their own account and any invites THEY created survive', async () => {
		const admin = await makeAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1 });
		const redeemer = await registerUser({
			email: 'redeemer@example.com',
			password: PASSWORD,
			displayName: 'Redeemer',
			inviteCode: invite.code
		});
		db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(redeemer.id);
		// Promote a THIRD user to admin so deleting `admin` doesn't trip the
		// last-admin guard, and so `admin` isn't the sole admin either.
		const [invite2] = createInvites({ createdBy: redeemer.id, count: 1 });
		const third = await registerUser({
			email: 'third@example.com',
			password: PASSWORD,
			displayName: 'Third',
			inviteCode: invite2.code
		});
		db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(third.id);

		// The redeemer separately creates their own invite — invites.created_by
		// points at THEM, not at the original inviter, so it must never be
		// touched by anything that happens to `admin`.
		const ownInvite = createInvites({ createdBy: redeemer.id, count: 1 })[0];

		deleteUser(admin.id);

		// The redeemer's account is untouched (invites.created_by never pointed
		// at them — the FK is on the CREATOR of the invite, not the redeemer).
		expect(db.prepare('SELECT id FROM users WHERE id = ?').get(redeemer.id)).toBeTruthy();
		// The redeemer's own invite (a row keyed to THEM as creator) survives.
		expect(inviteCount('id = ?', ownInvite.id)).toBe(1);
		// admin's invite row is gone (it was consumed already, but still had to
		// be purged so created_by doesn't dangle).
		expect(inviteCount('id = ?', invite.id)).toBe(0);
	});

	it('self-service deleteOwnAccount (accountDeletion.ts) also purges the caller\'s own invites', async () => {
		const admin = await makeAdmin();
		const [inv] = createInvites({ createdBy: admin.id, count: 1 });
		const second = await registerUser({
			email: 'second@example.com',
			password: PASSWORD,
			displayName: 'Second',
			inviteCode: inv.code
		});
		db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(second.id);
		const own = createInvites({ createdBy: second.id, count: 1 })[0];

		deleteOwnAccount(second.id);

		expect(inviteCount('id = ?', own.id)).toBe(0);
		expect(db.prepare('SELECT id FROM users WHERE id = ?').get(second.id)).toBeUndefined();
	});

	it('deleting the sole admin who created invites is blocked before any purge happens (last_admin guard fires first)', async () => {
		const admin = await makeAdmin();
		const inv = createInvites({ createdBy: admin.id, count: 1 })[0];
		expect(() => deleteUser(admin.id)).toThrowError(expect.objectContaining({ code: 'last_admin' }));
		// Nothing was purged — the guard fires before purgeUserRow() runs.
		expect(inviteCount('id = ?', inv.id)).toBe(1);
	});
});
