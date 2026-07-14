import { describe, it, expect, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '../db';
import { registerUser } from '../auth';
import { setUserAdmin } from '../admin';
import { setSetting } from '../settings';
import { requireFeature, requireAdmin } from '../api';
import { FEATURE_FLAGS, FEATURE_FLAG_KEYS } from './registry';
import { resolveAllFlags } from './resolve';
import { setGlobalFlag, setUserOverride, getUserOverrides } from './admin';
import { actions as flagActions } from '../../../routes/(app)/admin/feature-flags/+page.server';
import { actions as userActions } from '../../../routes/(app)/admin/users/[id]/+page.server';

function wipe(): void {
	db.exec(
		'DELETE FROM events; DELETE FROM user_feature_flags; DELETE FROM feature_flags; DELETE FROM sessions; DELETE FROM users;'
	);
}

beforeEach(() => {
	wipe();
	// The 2nd+ user (a member) would otherwise need an invite code.
	setSetting('registration_mode', 'open');
	// admin/users/[id]'s setOverride action is gated on assertTeamMode() (cairn-7xlf,
	// 2ee5f09) — it 404s in solo mode (the default) before ever touching the
	// override read/write path. This suite exercises that action directly, so it
	// needs team mode; the gate itself is covered by that route's own
	// page.server.test.ts.
	setSetting('instance_mode', 'team');
});

const PASSWORD = 'correct horse battery';
let seq = 0;
async function makeAdmin() {
	const u = await registerUser({ email: `admin${seq++}@x.com`, password: PASSWORD, displayName: 'Admin' });
	setUserAdmin(u.id, true);
	return { id: u.id, email: u.email, displayName: u.displayName, isAdmin: true };
}
function makeMember() {
	return registerUser({ email: `member${seq++}@x.com`, password: PASSWORD, displayName: 'Member' });
}

/** Minimal RequestEvent for invoking a form action. Returned loosely typed so it
 *  satisfies each action's specific RouteParams without a per-call cast. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function actionEvent(
	admin: { id: number; email: string; displayName: string; isAdmin: boolean },
	form: Record<string, string>,
	params: Record<string, string> = {}
): any {
	const body = new FormData();
	for (const [k, v] of Object.entries(form)) body.set(k, v);
	return {
		request: new Request('http://localhost/admin', { method: 'POST', body }),
		locals: { user: admin, flags: {} },
		params
	};
}

interface EventRow {
	type: string;
	level: string;
	message: string;
	detail: string | null;
	user_id: number | null;
}
function lastEvent(): EventRow {
	return db
		.prepare('SELECT type, level, message, detail, user_id FROM events ORDER BY id DESC LIMIT 1')
		.get() as unknown as EventRow;
}

/** Count only feature-flag audit events (a 2nd-user signup fires an unrelated
 *  admin_new_signup event, so a bare events count would be noisy). */
function featureFlagEventCount(): number {
	return (
		db
			.prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'admin_feature_flag%'")
			.get() as { n: number }
	).n;
}

describe('admin feature-flag audit trail (events table)', () => {
	it('a global toggle records an admin_feature_flag event with from/to and actor', async () => {
		const admin = await makeAdmin();
		const res = await flagActions.toggle(actionEvent(admin, { key: 'send', enabled: 'false' }));
		expect(res).toEqual({ ok: true });

		const ev = lastEvent();
		expect(ev.type).toBe('admin_feature_flag');
		expect(ev.level).toBe('warn'); // disabling is the consequential direction
		expect(ev.user_id).toBeNull(); // instance-wide admin audit entry
		expect(ev.message).toContain(admin.email);
		expect(ev.message).toMatch(/disabled/);
		const detail = JSON.parse(ev.detail!);
		expect(detail).toMatchObject({
			adminId: admin.id,
			flag: 'send',
			scope: 'global',
			from: 'default(on)', // no prior row → was inheriting the registry default
			to: 'off'
		});
	});

	it('enabling records level info and from reflects the prior row', async () => {
		const admin = await makeAdmin();
		setGlobalFlag('send', false, admin.id); // prior explicit off
		await flagActions.toggle(actionEvent(admin, { key: 'send', enabled: 'true' }));
		const ev = lastEvent();
		expect(ev.level).toBe('info');
		expect(JSON.parse(ev.detail!)).toMatchObject({ from: 'off', to: 'on' });
	});

	it('an unknown flag key is rejected and records nothing', async () => {
		const admin = await makeAdmin();
		const res = await flagActions.toggle(actionEvent(admin, { key: 'nope', enabled: 'false' }));
		expect((res as { status?: number }).status).toBe(400);
		expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
	});

	it('a per-user override records an admin_feature_flag_override event with target + from/to', async () => {
		const admin = await makeAdmin();
		const member = await makeMember();
		const res = await userActions.setOverride(
			actionEvent(admin, { key: 'multisig_create', state: 'off' }, { id: String(member.id) })
		);
		expect(res).toEqual({ ok: true });

		const ev = lastEvent();
		expect(ev.type).toBe('admin_feature_flag_override');
		expect(ev.level).toBe('warn'); // force-off is consequential
		expect(ev.message).toContain(admin.email);
		expect(ev.message).toContain(member.email);
		expect(JSON.parse(ev.detail!)).toMatchObject({
			adminId: admin.id,
			flag: 'multisig_create',
			targetUserId: member.id,
			from: 'inherit', // no prior override
			to: 'off'
		});
	});

	it('clearing an override back to inherit records from the prior forced value', async () => {
		const admin = await makeAdmin();
		const member = await makeMember();
		// First force it on, then clear to inherit.
		await userActions.setOverride(
			actionEvent(admin, { key: 'send', state: 'on' }, { id: String(member.id) })
		);
		await userActions.setOverride(
			actionEvent(admin, { key: 'send', state: 'inherit' }, { id: String(member.id) })
		);
		const ev = lastEvent();
		expect(JSON.parse(ev.detail!)).toMatchObject({ from: 'on', to: 'inherit' });
		expect(ev.level).toBe('info');
	});
});

describe('requireFeature blocked-attempt logging', () => {
	it('403s through the DB-fallback path when a user is blocked (warn line asserted in guardLog.test.ts)', async () => {
		const member = await makeMember();
		setGlobalFlag('send', false, member.id);
		// No flags on the event → the guard reads the DB and sees the off row.
		const evt = {
			locals: { user: { id: member.id, email: member.email, isAdmin: false } },
			request: new Request('http://localhost/api/wallets/1/psbt', { method: 'POST' }),
			url: new URL('http://localhost/api/wallets/1/psbt')
		} as unknown as RequestEvent;
		let status: number | undefined;
		try {
			requireFeature(evt, 'send');
		} catch (e) {
			status = (e as { status?: number }).status;
		}
		expect(status).toBe(403);
	});
});

describe('admin API — global toggle + per-user override lifecycle', () => {
	it('toggling a global flag off writes an explicit row and returns ok', async () => {
		const admin = await makeAdmin();
		const res = await flagActions.toggle(actionEvent(admin, { key: 'explorer', enabled: 'false' }));
		expect(res).toEqual({ ok: true });
		const row = db.prepare('SELECT enabled FROM feature_flags WHERE key = ?').get('explorer');
		expect(row).toEqual({ enabled: 0 });
	});

	it('setting then removing a per-user override adds and deletes exactly its row, response ok each time', async () => {
		const admin = await makeAdmin();
		const member = await makeMember();

		// Force on.
		const on = await userActions.setOverride(
			actionEvent(admin, { key: 'send', state: 'on' }, { id: String(member.id) })
		);
		expect(on).toEqual({ ok: true });
		expect(getUserOverrides(member.id).get('send')).toBe(true);

		// Remove (inherit).
		const cleared = await userActions.setOverride(
			actionEvent(admin, { key: 'send', state: 'inherit' }, { id: String(member.id) })
		);
		expect(cleared).toEqual({ ok: true });
		expect(getUserOverrides(member.id).has('send')).toBe(false);
		expect(
			db.prepare('SELECT COUNT(*) AS n FROM user_feature_flags WHERE user_id = ?').get(member.id)
		).toEqual({ n: 0 });
	});
});

describe('admin API — edge cases', () => {
	it('an invalid override state is rejected (400) and records nothing', async () => {
		const admin = await makeAdmin();
		const member = await makeMember();
		const res = await userActions.setOverride(
			actionEvent(admin, { key: 'send', state: 'sideways' }, { id: String(member.id) })
		);
		expect((res as { status?: number }).status).toBe(400);
		// No feature-flag audit event (a member signup event may exist, so filter by type).
		expect(featureFlagEventCount()).toBe(0);
		expect(db.prepare('SELECT COUNT(*) AS n FROM user_feature_flags').get()).toEqual({ n: 0 });
	});

	it('an override for a non-existent user returns 404 and writes no row or event', async () => {
		const admin = await makeAdmin();
		const res = await userActions.setOverride(
			actionEvent(admin, { key: 'send', state: 'off' }, { id: '999999' })
		);
		expect((res as { status?: number }).status).toBe(404);
		expect(db.prepare('SELECT COUNT(*) AS n FROM user_feature_flags').get()).toEqual({ n: 0 });
		expect(featureFlagEventCount()).toBe(0);
	});

	it('an unknown flag key on a per-user override is rejected (400)', async () => {
		const admin = await makeAdmin();
		const member = await makeMember();
		const res = await userActions.setOverride(
			actionEvent(admin, { key: 'not_a_flag', state: 'off' }, { id: String(member.id) })
		);
		expect((res as { status?: number }).status).toBe(400);
	});

	it('admin-panel access is governed by isAdmin, not feature flags — an admin cannot flag themselves out of it', async () => {
		const admin = await makeAdmin();
		// Force EVERY registered flag off for the admin, both globally and per-user.
		for (const def of FEATURE_FLAGS) {
			setGlobalFlag(def.key, false, admin.id);
			setUserOverride(admin.id, def.key, false, admin.id);
		}
		// No registered flag key controls admin access — so there is nothing to
		// disable that would lock an admin out of /admin.
		expect(FEATURE_FLAG_KEYS.has('admin')).toBe(false);
		// requireAdmin reads isAdmin, never the resolved flags: it still passes even
		// with every flag forced off for this admin.
		const evt = {
			locals: { user: admin, flags: resolveAllFlags(admin.id) }
		} as unknown as RequestEvent;
		expect(requireAdmin(evt).id).toBe(admin.id);
	});
});
