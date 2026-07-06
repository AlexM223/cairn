// Announcement/banner system tests (cairn-2cue): the server module's listing
// rules (active/expired/dismissed/non-dismissible/order), the dismiss API
// route's auth + semantics, and the admin page actions' validation + audit
// trail. See announcements.ts for the chosen non-dismissible semantics: a
// dismiss against a non-dismissible announcement is REFUSED (no row), and
// non-dismissible listing ignores any stale dismissal rows.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setUserAdmin } from './admin';
import { setSetting } from './settings';
import {
	createAnnouncement,
	updateAnnouncement,
	deleteAnnouncement,
	setAnnouncementActive,
	getAnnouncement,
	listAnnouncements,
	listActiveAnnouncementsFor,
	dismissAnnouncement,
	AnnouncementValidationError,
	type AnnouncementInput
} from './announcements';
import { POST as dismissPOST } from '../../routes/api/announcements/[id]/dismiss/+server';
import {
	actions as adminActions,
	load as adminLoad
} from '../../routes/(app)/admin/announcements/+page.server';

function wipe(): void {
	db.exec(
		'DELETE FROM announcement_dismissals; DELETE FROM announcements; DELETE FROM events; ' +
			'DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

const PASSWORD = 'correct horse battery';
let seq = 0;

beforeEach(() => {
	wipe();
	seq = 0;
	setSetting('registration_mode', 'open');
});

function makeUser() {
	return registerUser({ email: `user${seq++}@x.com`, password: PASSWORD, displayName: 'User' });
}

function makeAdmin() {
	const u = registerUser({ email: `admin${seq++}@x.com`, password: PASSWORD, displayName: 'Admin' });
	setUserAdmin(u.id, true);
	return { id: u.id, email: u.email, displayName: u.displayName, isAdmin: true };
}

/** Shorthand: a valid announcement with overridable fields. */
function make(overrides: Partial<AnnouncementInput> = {}) {
	return createAnnouncement({
		type: 'info',
		title: 'Scheduled maintenance',
		body: 'Cairn will be briefly unavailable on Sunday.',
		...overrides
	});
}

const FUTURE = new Date(Date.now() + 86400_000).toISOString(); // +1 day
const PAST = '2000-01-01T00:00:00.000Z';

function dismissalCount(): number {
	return (db.prepare('SELECT COUNT(*) AS n FROM announcement_dismissals').get() as { n: number }).n;
}

describe('announcements — admin CRUD + validation', () => {
	it('create round-trips through list with normalized fields and defaults', () => {
		const a = make({ linkUrl: 'https://example.com/status', linkText: '  Status page  ' });
		expect(a).toMatchObject({
			type: 'info',
			title: 'Scheduled maintenance',
			linkUrl: 'https://example.com/status',
			linkText: 'Status page',
			dismissible: true,
			active: true,
			expiresAt: null,
			displayOrder: 0
		});
		expect(listAnnouncements().map((x) => x.id)).toEqual([a.id]);
	});

	it('rejects an unknown type', () => {
		expect(() => make({ type: 'shouting' as never })).toThrow(AnnouncementValidationError);
	});

	it('rejects non-http(s) links but accepts https and site-relative paths', () => {
		// eslint-disable-next-line no-script-url
		expect(() => make({ linkUrl: 'javascript:alert(1)' })).toThrow(AnnouncementValidationError);
		expect(() => make({ linkUrl: 'ftp://example.com/x' })).toThrow(AnnouncementValidationError);
		expect(() => make({ linkUrl: 'not a url' })).toThrow(AnnouncementValidationError);
		expect(make({ linkUrl: 'https://example.com' }).linkUrl).toBe('https://example.com');
		expect(make({ linkUrl: '/settings' }).linkUrl).toBe('/settings');
	});

	it('rejects an empty title/body and normalizes expiry to ISO UTC', () => {
		expect(() => make({ title: '   ' })).toThrow(AnnouncementValidationError);
		expect(() => make({ body: '' })).toThrow(AnnouncementValidationError);
		expect(() => make({ expiresAt: 'someday' })).toThrow(AnnouncementValidationError);
		const a = make({ expiresAt: '2099-06-01T12:00:00.000Z' });
		expect(a.expiresAt).toBe('2099-06-01T12:00:00.000Z');
	});

	it('link text without a link is dropped', () => {
		expect(make({ linkText: 'Click me' }).linkText).toBeNull();
	});

	it('update edits in place and returns null for a missing id', () => {
		const a = make();
		const updated = updateAnnouncement(a.id, {
			type: 'urgent',
			title: 'Maintenance NOW',
			body: 'We are on it.',
			dismissible: false,
			active: true
		});
		expect(updated).toMatchObject({ id: a.id, type: 'urgent', dismissible: false });
		expect(updateAnnouncement(999999, { type: 'info', title: 'x', body: 'y' })).toBeNull();
	});

	it('delete removes the row and cascades its dismissal rows', () => {
		const user = makeUser();
		const a = make();
		dismissAnnouncement(user.id, a.id);
		expect(dismissalCount()).toBe(1);

		expect(deleteAnnouncement(a.id)).toBe(true);
		expect(getAnnouncement(a.id)).toBeNull();
		expect(dismissalCount()).toBe(0);
		expect(deleteAnnouncement(a.id)).toBe(false); // already gone
	});
});

describe('listActiveAnnouncementsFor — what a user actually sees', () => {
	it('an expired announcement is never listed; a future expiry still is', () => {
		const user = makeUser();
		make({ title: 'Old news', expiresAt: PAST });
		const current = make({ title: 'Current', expiresAt: FUTURE });
		expect(listActiveAnnouncementsFor(user.id).map((a) => a.id)).toEqual([current.id]);
	});

	it('an inactive announcement is never listed', () => {
		const user = makeUser();
		const a = make();
		setAnnouncementActive(a.id, false);
		expect(listActiveAnnouncementsFor(user.id)).toHaveLength(0);
		setAnnouncementActive(a.id, true);
		expect(listActiveAnnouncementsFor(user.id)).toHaveLength(1);
	});

	it('sorts by display_order, then id for ties', () => {
		const user = makeUser();
		const last = make({ title: 'Last', displayOrder: 5 });
		const firstA = make({ title: 'First A', displayOrder: 1 });
		const firstB = make({ title: 'First B (same order, later id)', displayOrder: 1 });
		expect(listActiveAnnouncementsFor(user.id).map((a) => a.id)).toEqual([
			firstA.id,
			firstB.id,
			last.id
		]);
	});

	it("a dismissal is per-user — A's dismissal doesn't affect B", () => {
		const alice = makeUser();
		const bob = makeUser();
		const a = make();

		expect(dismissAnnouncement(alice.id, a.id)).toBe('dismissed');
		expect(listActiveAnnouncementsFor(alice.id)).toHaveLength(0);
		expect(listActiveAnnouncementsFor(bob.id)).toHaveLength(1);
	});

	it('dismiss upsert is idempotent — repeat dismissals keep a single row', () => {
		const user = makeUser();
		const a = make();
		expect(dismissAnnouncement(user.id, a.id)).toBe('dismissed');
		expect(dismissAnnouncement(user.id, a.id)).toBe('dismissed');
		expect(dismissalCount()).toBe(1);
	});

	it('a NON-dismissible announcement ignores stale dismissal rows entirely', () => {
		const user = makeUser();
		const a = make(); // dismissible at first
		dismissAnnouncement(user.id, a.id);
		expect(listActiveAnnouncementsFor(user.id)).toHaveLength(0);

		// Admin escalates: now non-dismissible. The old dismissal row must not
		// hide it.
		updateAnnouncement(a.id, {
			type: 'urgent',
			title: a.title,
			body: a.body,
			dismissible: false
		});
		expect(listActiveAnnouncementsFor(user.id).map((x) => x.id)).toEqual([a.id]);
	});

	it('dismissAnnouncement refuses non-dismissible (no row) and reports unknown ids', () => {
		const user = makeUser();
		const a = make({ dismissible: false });
		expect(dismissAnnouncement(user.id, a.id)).toBe('not_dismissible');
		expect(dismissalCount()).toBe(0);
		expect(dismissAnnouncement(user.id, 999999)).toBe('not_found');
	});
});

// --------------------------------------------------------------- API route

type MaybeUser = { id: number; email: string; displayName: string; isAdmin?: boolean } | null;

/** Minimal RequestEvent for the dismiss route. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dismissEvent(user: MaybeUser, id: string): any {
	return {
		locals: { user, flags: {} },
		params: { id },
		request: new Request(`http://localhost/api/announcements/${id}/dismiss`, { method: 'POST' }),
		url: new URL(`http://localhost/api/announcements/${id}/dismiss`)
	};
}

/** SvelteKit's error() THROWS an HttpError — translate to a status. */
async function callDismiss(user: MaybeUser, id: string): Promise<number> {
	try {
		const res = (await dismissPOST(dismissEvent(user, id))) as Response;
		return res.status;
	} catch (e) {
		const status = (e as { status?: number }).status;
		if (typeof status === 'number') return status;
		throw e;
	}
}

describe('POST /api/announcements/[id]/dismiss', () => {
	it('401s when not signed in', async () => {
		const a = make();
		expect(await callDismiss(null, String(a.id))).toBe(401);
		expect(dismissalCount()).toBe(0);
	});

	it('404s an unknown or non-numeric id', async () => {
		const user = makeUser();
		expect(await callDismiss(user, '999999')).toBe(404);
		expect(await callDismiss(user, 'abc')).toBe(404);
	});

	it("409s a non-dismissible announcement — the missing ✕ isn't the boundary", async () => {
		const user = makeUser();
		const a = make({ dismissible: false });
		expect(await callDismiss(user, String(a.id))).toBe(409);
		expect(dismissalCount()).toBe(0);
		// Still visible for the user who tried.
		expect(listActiveAnnouncementsFor(user.id)).toHaveLength(1);
	});

	it('200s and hides a dismissible announcement for that user only', async () => {
		const alice = makeUser();
		const bob = makeUser();
		const a = make();
		expect(await callDismiss(alice, String(a.id))).toBe(200);
		expect(listActiveAnnouncementsFor(alice.id)).toHaveLength(0);
		expect(listActiveAnnouncementsFor(bob.id)).toHaveLength(1);
	});
});

// ---------------------------------------------------------- admin actions

/** Minimal RequestEvent for invoking a form action (audit.test.ts pattern). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function actionEvent(
	user: { id: number; email: string; displayName: string; isAdmin: boolean },
	form: Record<string, string>,
	flags: Record<string, boolean> = {}
): any {
	const body = new FormData();
	for (const [k, v] of Object.entries(form)) body.set(k, v);
	return {
		request: new Request('http://localhost/admin/announcements', { method: 'POST', body }),
		locals: { user, flags },
		params: {}
	};
}

const VALID_FORM = {
	type: 'warning',
	title: 'Fee spike',
	body: 'Network fees are unusually high right now.',
	linkUrl: '',
	linkText: '',
	dismissible: 'on',
	active: 'on',
	expiresAt: '',
	displayOrder: '0'
};

function lastEvent(): { type: string; level: string; message: string } {
	return db
		.prepare('SELECT type, level, message FROM events ORDER BY id DESC LIMIT 1')
		.get() as { type: string; level: string; message: string };
}

describe('/admin/announcements actions', () => {
	it('create inserts the row and records an admin_announcement audit event', async () => {
		const admin = makeAdmin();
		const res = await adminActions.create(actionEvent(admin, VALID_FORM));
		expect(res).toEqual({ ok: true });

		const all = listAnnouncements();
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ type: 'warning', title: 'Fee spike', dismissible: true });

		const ev = lastEvent();
		expect(ev.type).toBe('admin_announcement');
		expect(ev.message).toContain(admin.email);
		expect(ev.message).toContain('created');
	});

	it('create rejects bad input with a friendly 400 and writes nothing', async () => {
		const admin = makeAdmin();
		const res = await adminActions.create(actionEvent(admin, { ...VALID_FORM, title: '  ' }));
		expect((res as { status?: number }).status).toBe(400);
		expect(listAnnouncements()).toHaveLength(0);
		expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
	});

	it('update edits the row; unchecked checkboxes mean off', async () => {
		const admin = makeAdmin();
		const a = make();
		// dismissible/active omitted = the admin unchecked both.
		const res = await adminActions.update(
			actionEvent(admin, {
				id: String(a.id),
				type: 'urgent',
				title: 'Now urgent',
				body: a.body,
				linkUrl: '',
				linkText: '',
				expiresAt: '',
				displayOrder: '3'
			})
		);
		expect(res).toEqual({ ok: true });
		expect(getAnnouncement(a.id)).toMatchObject({
			type: 'urgent',
			title: 'Now urgent',
			dismissible: false,
			active: false,
			displayOrder: 3
		});
	});

	it('toggleActive flips active and audits the consequential direction at warn', async () => {
		const admin = makeAdmin();
		const a = make();
		const res = await adminActions.toggleActive(
			actionEvent(admin, { id: String(a.id), active: 'false' })
		);
		expect(res).toEqual({ ok: true });
		expect(getAnnouncement(a.id)!.active).toBe(false);
		expect(lastEvent()).toMatchObject({ type: 'admin_announcement', level: 'warn' });
	});

	it('delete removes the row; a missing id 404s', async () => {
		const admin = makeAdmin();
		const a = make();
		expect(await adminActions.delete(actionEvent(admin, { id: String(a.id) }))).toEqual({
			ok: true
		});
		expect(getAnnouncement(a.id)).toBeNull();
		const res = await adminActions.delete(actionEvent(admin, { id: String(a.id) }));
		expect((res as { status?: number }).status).toBe(404);
	});

	it('all mutations refuse when the announcement_banners flag is off', async () => {
		const admin = makeAdmin();
		const off = { announcement_banners: false };
		const res = await adminActions.create(actionEvent(admin, VALID_FORM, off));
		expect((res as { status?: number }).status).toBe(400);
		expect(listAnnouncements()).toHaveLength(0);
	});

	it('load reports enabled=false and no rows when the flag is off', async () => {
		make();
		// The load's return type unions with void; it always returns data here.
		type AdminLoadData = Exclude<Awaited<ReturnType<typeof adminLoad>>, void>;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const off = (await adminLoad({
			locals: { flags: { announcement_banners: false } }
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any)) as AdminLoadData;
		expect(off).toEqual({ enabled: false, announcements: [] });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const on = (await adminLoad({ locals: { flags: {} } } as any)) as AdminLoadData;
		expect(on.enabled).toBe(true);
		expect(on.announcements).toHaveLength(1);
	});
});
