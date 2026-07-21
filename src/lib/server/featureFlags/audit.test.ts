// Audit trail + engine coverage for the feature-flag system after the
// UX-simplification teardown (docs/UX-SIMPLIFICATION-SPEC.md §3, cairn-6c91u.2):
// the /admin/feature-flags grid and the per-user override GRID are gone, but the
// ENGINE (registry, resolve, requireFeature, feature_flags / user_feature_flags
// tables, setGlobalFlag / setUserOverride) is untouched. The two operator-facing
// flags — mining, explorer — are now plain toggles in the one Settings page,
// wired to the SAME setGlobalFlag() path and recording the SAME
// admin_feature_flag audit event the old grid did. This suite pins that toggle
// action's audit trail plus the still-honored per-user override engine (R7).

import { describe, it, expect, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '../db';
import { registerUser } from '../auth';
import { setUserAdmin } from '../admin';
import { setSetting } from '../settings';
import { requireFeature, requireAdmin } from '../api';
import { FEATURE_FLAGS, FEATURE_FLAG_KEYS } from './registry';
import { resolveAllFlags } from './resolve';
import {
	getGlobalFlags,
	setGlobalFlag,
	setUserOverride,
	getUserOverrides,
	clearUserOverride
} from './admin';
import { actions as settingsActions } from '../../../routes/(app)/settings/+page.server';

function wipe(): void {
	db.exec(
		'DELETE FROM events; DELETE FROM user_feature_flags; DELETE FROM feature_flags; DELETE FROM sessions; DELETE FROM users;'
	);
}

beforeEach(() => {
	wipe();
	// The 2nd+ user (a member) would otherwise need an invite code.
	setSetting('registration_mode', 'open');
	setSetting('instance_mode', 'team');
});

const PASSWORD = 'correct horse battery';
let seq = 0;
async function makeAdmin() {
	const u = await registerUser({
		email: `admin${seq++}@x.com`,
		password: PASSWORD,
		displayName: 'Admin'
	});
	setUserAdmin(u.id, true);
	return { id: u.id, email: u.email, displayName: u.displayName, isAdmin: true };
}
function makeMember() {
	return registerUser({ email: `member${seq++}@x.com`, password: PASSWORD, displayName: 'Member' });
}

/** Minimal RequestEvent for invoking a settings form action. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function actionEvent(
	user: { id: number; email: string; displayName: string; isAdmin: boolean } | undefined,
	form: Record<string, string> = {}
): any {
	const body = new FormData();
	for (const [k, v] of Object.entries(form)) body.set(k, v);
	return {
		request: new Request('http://localhost/settings', { method: 'POST', body }),
		locals: { user, flags: {} }
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

function featureFlagEventCount(): number {
	return (
		db
			.prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'admin_feature_flag%'")
			.get() as { n: number }
	).n;
}

describe('Settings mining/explorer toggle — audit trail (events table)', () => {
	it('a global toggle records an admin_feature_flag event with from/to and actor', async () => {
		const admin = await makeAdmin();
		const res = await settingsActions.toggleFlag(
			actionEvent(admin, { key: 'mining', enabled: 'false' })
		);
		expect(res).toMatchObject({ flagToggled: true, key: 'mining', enabled: false });

		const ev = lastEvent();
		expect(ev.type).toBe('admin_feature_flag');
		expect(ev.level).toBe('warn'); // disabling is the consequential direction
		expect(ev.user_id).toBeNull(); // instance-wide admin audit entry
		expect(ev.message).toContain(admin.email);
		expect(ev.message).toMatch(/disabled/);
		const detail = JSON.parse(ev.detail!);
		expect(detail).toMatchObject({
			adminId: admin.id,
			flag: 'mining',
			scope: 'global',
			from: 'default', // no prior row → was inheriting the registry default
			to: 'off'
		});
	});

	it('enabling records level info and from reflects the prior row', async () => {
		const admin = await makeAdmin();
		setGlobalFlag('mining', false, admin.id); // prior explicit off
		await settingsActions.toggleFlag(actionEvent(admin, { key: 'mining', enabled: 'true' }));
		const ev = lastEvent();
		expect(ev.level).toBe('info');
		expect(JSON.parse(ev.detail!)).toMatchObject({ from: 'off', to: 'on' });
	});

	it('toggling explorer off writes an explicit false row', async () => {
		const admin = await makeAdmin();
		const res = await settingsActions.toggleFlag(
			actionEvent(admin, { key: 'explorer', enabled: 'false' })
		);
		expect(res).toMatchObject({ flagToggled: true });
		const row = db.prepare('SELECT enabled FROM feature_flags WHERE key = ?').get('explorer');
		expect(row).toEqual({ enabled: 0 });
	});

	it('the toggle only accepts mining/explorer — any other flag key is rejected (400), records nothing', async () => {
		const admin = await makeAdmin();
		// A real registry key that is NOT operator-toggleable.
		const send = await settingsActions.toggleFlag(
			actionEvent(admin, { key: 'send', enabled: 'false' })
		);
		expect((send as { status?: number }).status).toBe(400);
		// A key that isn't in the registry at all.
		const nope = await settingsActions.toggleFlag(
			actionEvent(admin, { key: 'nope', enabled: 'false' })
		);
		expect((nope as { status?: number }).status).toBe(400);
		expect(getGlobalFlags().get('send')).toBeUndefined();
		expect(featureFlagEventCount()).toBe(0);
	});

	it('a non-admin is denied (403) and a global row is never written', async () => {
		const member = await makeMember();
		const nonAdmin = { id: member.id, email: member.email, displayName: 'Member', isAdmin: false };
		await expect(
			settingsActions.toggleFlag(actionEvent(nonAdmin, { key: 'mining', enabled: 'true' }))
		).rejects.toMatchObject({ status: 403 });
		expect(getGlobalFlags().get('mining')).toBeUndefined();
	});

	it('an anonymous caller is denied (401) and writes nothing', async () => {
		await expect(
			settingsActions.toggleFlag(actionEvent(undefined, { key: 'mining', enabled: 'true' }))
		).rejects.toMatchObject({ status: 401 });
		expect(getGlobalFlags().get('mining')).toBeUndefined();
	});
});

describe('the Settings toggle flips the resolved flag requireFeature reads (spec R2)', () => {
	it('toggling mining ON via the action makes resolveAllFlags().mining true', async () => {
		const admin = await makeAdmin();
		await settingsActions.toggleFlag(actionEvent(admin, { key: 'mining', enabled: 'true' }));
		expect(getGlobalFlags().get('mining')).toBe(true);
		expect(resolveAllFlags(admin.id).mining).toBe(true);
	});

	it('toggling explorer OFF via the action makes resolveAllFlags().explorer false', async () => {
		const admin = await makeAdmin();
		await settingsActions.toggleFlag(actionEvent(admin, { key: 'explorer', enabled: 'false' }));
		expect(resolveAllFlags(admin.id).explorer).toBe(false);
	});
});

describe('per-user override engine survives the grid removal (spec R7)', () => {
	it('a pre-existing user_feature_flags row still forces requireFeature closed', async () => {
		const member = await makeMember();
		// Simulate an override row left behind by the (now-removed) grid.
		setUserOverride(member.id, 'send', false, member.id);
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

	it('setting then clearing a per-user override adds and deletes exactly its row', async () => {
		const admin = await makeAdmin();
		const member = await makeMember();

		setUserOverride(member.id, 'send', true, admin.id);
		expect(getUserOverrides(member.id).get('send')).toBe(true);

		clearUserOverride(member.id, 'send');
		expect(getUserOverrides(member.id).has('send')).toBe(false);
		expect(
			db.prepare('SELECT COUNT(*) AS n FROM user_feature_flags WHERE user_id = ?').get(member.id)
		).toEqual({ n: 0 });
	});
});

describe('requireFeature blocked-attempt logging', () => {
	it('403s through the DB-fallback path when a user is blocked (warn line asserted in guardLog.test.ts)', async () => {
		const member = await makeMember();
		setGlobalFlag('send', false, member.id);
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

describe('admin access is governed by isAdmin, not feature flags', () => {
	it('an admin cannot flag themselves out of admin access', async () => {
		const admin = await makeAdmin();
		for (const def of FEATURE_FLAGS) {
			setGlobalFlag(def.key, false, admin.id);
			setUserOverride(admin.id, def.key, false, admin.id);
		}
		expect(FEATURE_FLAG_KEYS.has('admin')).toBe(false);
		const evt = {
			locals: { user: admin, flags: resolveAllFlags(admin.id) }
		} as unknown as RequestEvent;
		expect(requireAdmin(evt).id).toBe(admin.id);
	});
});
