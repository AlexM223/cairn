// No-leak guarantees for the public invite preview (cairn-n1ovc). This suite
// is the review gate for /invite/[code]'s data exposure: it pins (1) that a
// code which is not currently redeemable — unknown, revoked, expired, or
// exhausted, indistinguishably — reveals NOTHING, and (2) the EXACT field
// list a valid code exposes. If you add a field and this fails, that is the
// security contract asking for a review, not a test to update casually.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { createInvites, revokeInvite, setInstanceName } from './admin';
import { getInvitePreview, inviteNodeTitle } from './invitePreview';

function wipe(): void {
	db.exec(
		`DELETE FROM notified_txids; DELETE FROM invites; DELETE FROM sessions;
		 DELETE FROM wallets; DELETE FROM users; DELETE FROM settings;`
	);
}

const PASSWORD = 'correct horse battery';

async function makeAdmin(displayName = 'Alex') {
	return registerUser({ email: 'admin@example.com', password: PASSWORD, displayName });
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'invite');
});

describe('getInvitePreview: null-on-invalid (reveals nothing)', () => {
	it('returns null for an unknown code', async () => {
		await makeAdmin();
		setInstanceName('The Martinez family node');
		expect(getInvitePreview('CAIRN-NOPE-NOPE')).toBeNull();
	});

	it('returns null for empty and absurdly long inputs without touching the DB path', () => {
		expect(getInvitePreview('')).toBeNull();
		expect(getInvitePreview('   ')).toBeNull();
		expect(getInvitePreview('X'.repeat(65))).toBeNull();
	});

	it('returns null for a revoked code', async () => {
		const admin = await makeAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1 });
		revokeInvite(invite.id);
		expect(getInvitePreview(invite.code)).toBeNull();
	});

	it('returns null for an expired code', async () => {
		const admin = await makeAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1, expiresDays: 7 });
		db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run(
			new Date(Date.now() - 1000).toISOString(),
			invite.id
		);
		expect(getInvitePreview(invite.code)).toBeNull();
	});

	it('returns null for an exhausted code', async () => {
		const admin = await makeAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1 });
		await registerUser({
			email: 'b@example.com',
			password: PASSWORD,
			displayName: 'B',
			inviteCode: invite.code
		});
		expect(getInvitePreview(invite.code)).toBeNull();
	});
});

describe('getInvitePreview: the exact exposed field list', () => {
	it('exposes exactly the audited fields, nothing else', async () => {
		const admin = await makeAdmin();
		const [invite] = createInvites({
			createdBy: admin.id,
			count: 1,
			label: 'Family batch — internal bookkeeping',
			welcomeMessage: 'Welcome aboard, kiddo.'
		});
		const p = getInvitePreview(invite.code);
		expect(p).not.toBeNull();
		expect(Object.keys(p!).sort()).toEqual([
			'captainName',
			'instanceName',
			'sharedSurfaces',
			'synced',
			'tipHeight',
			'watching',
			'welcomeMessage'
		]);
		expect(Object.keys(p!.sharedSurfaces).sort()).toEqual(['explorer', 'mining']);
	});

	it('never serializes the admin email, the invite label, or admin bookkeeping', async () => {
		const admin = await makeAdmin();
		const [invite] = createInvites({
			createdBy: admin.id,
			count: 1,
			label: 'SECRET-LABEL-77',
			maxUses: 3,
			expiresDays: 9
		});
		const json = JSON.stringify(getInvitePreview(invite.code));
		expect(json).not.toContain('admin@example.com');
		expect(json).not.toContain('SECRET-LABEL-77');
		expect(json).not.toContain(invite.code); // the caller already has it; we never echo it
		expect(json).not.toMatch(/maxUses|usedCount|expiresAt/);
	});

	it('carries the captain name, instance name, and welcome message for a valid code', async () => {
		const admin = await makeAdmin('Alex');
		setInstanceName('The Martinez family node');
		const [invite] = createInvites({
			createdBy: admin.id,
			count: 1,
			welcomeMessage: 'So glad you are here.'
		});
		const p = getInvitePreview(invite.code)!;
		expect(p.instanceName).toBe('The Martinez family node');
		expect(p.captainName).toBe('Alex');
		expect(p.welcomeMessage).toBe('So glad you are here.');
		expect(typeof p.watching).toBe('boolean');
		expect(typeof p.synced).toBe('boolean');
		expect(p.tipHeight === null || typeof p.tipHeight === 'number').toBe(true);
		expect(typeof p.sharedSurfaces.explorer).toBe('boolean');
		expect(typeof p.sharedSurfaces.mining).toBe('boolean');
	});

	it('welcomeMessage and instanceName are null when never set', async () => {
		const admin = await makeAdmin();
		const [invite] = createInvites({ createdBy: admin.id, count: 1 });
		const p = getInvitePreview(invite.code)!;
		expect(p.instanceName).toBeNull();
		expect(p.welcomeMessage).toBeNull();
	});
});

describe('inviteNodeTitle fallback chain', () => {
	it('prefers the admin-set instance name', async () => {
		const admin = await makeAdmin('Alex');
		setInstanceName('The Grove');
		const [invite] = createInvites({ createdBy: admin.id, count: 1 });
		expect(inviteNodeTitle(getInvitePreview(invite.code)!)).toBe('The Grove');
	});

	it("falls back to the captain's name, then to a neutral generic", async () => {
		const admin = await makeAdmin('Alex');
		const [invite] = createInvites({ createdBy: admin.id, count: 1 });
		expect(inviteNodeTitle(getInvitePreview(invite.code)!)).toBe("Alex's node");
		expect(
			inviteNodeTitle({
				instanceName: null,
				captainName: null,
				welcomeMessage: null,
				watching: true,
				synced: true,
				tipHeight: null,
				sharedSurfaces: { explorer: true, mining: true }
			})
		).toBe('a Heartwood node');
	});
});
