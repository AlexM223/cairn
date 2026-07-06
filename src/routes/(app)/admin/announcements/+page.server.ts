// Admin → Announcements (cairn-eezt). Instance-wide banner CRUD: one editor
// card (create OR edit — the client fills it from a row) plus a list of every
// announcement, current or not. Body is plain text by design (no markdown/HTML
// renderer = no XSS surface); the optional CTA link covers links.
//
// The route lives under /admin, so the admin layout's isAdmin gate protects the
// page; every action re-checks requireAdmin for defense in depth. The
// announcement_banners feature flag disables the whole surface (registry: "Off
// = no banners render and the admin announcements page is disabled") — the page
// shows a notice card instead of the editor, and actions refuse too so a stale
// tab can't keep writing.

import { fail } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/api';
import { recordActivity } from '$lib/server/activity';
import {
	AnnouncementValidationError,
	createAnnouncement,
	deleteAnnouncement,
	getAnnouncement,
	listAnnouncements,
	setAnnouncementActive,
	updateAnnouncement,
	type AnnouncementInput,
	type AnnouncementType
} from '$lib/server/announcements';
import type { Actions, PageServerLoad } from './$types';

/** Whether the announcement_banners flag is on for this request. */
function bannersEnabled(event: RequestEvent): boolean {
	return event.locals.flags?.announcement_banners !== false;
}

export const load: PageServerLoad = async ({ locals }) => {
	const enabled = locals.flags?.announcement_banners !== false;
	return {
		enabled,
		announcements: enabled ? listAnnouncements() : []
	};
};

/** Parse the editor form into an AnnouncementInput. Field-shape problems that
 *  can't come from the real form (e.g. a non-numeric order) fail here; content
 *  rules (empty title, bad link, …) are the server module's job. */
function parseForm(form: FormData): AnnouncementInput {
	const displayOrderRaw = String(form.get('displayOrder') ?? '0').trim();
	const displayOrder = displayOrderRaw === '' ? 0 : Number(displayOrderRaw);
	return {
		type: String(form.get('type') ?? '') as AnnouncementType,
		title: String(form.get('title') ?? ''),
		body: String(form.get('body') ?? ''),
		linkUrl: String(form.get('linkUrl') ?? ''),
		linkText: String(form.get('linkText') ?? ''),
		// Checkboxes: present = on. The editor always renders both.
		dismissible: form.get('dismissible') === 'on',
		active: form.get('active') === 'on',
		expiresAt: String(form.get('expiresAt') ?? '') || null,
		displayOrder: Number.isFinite(displayOrder) ? displayOrder : NaN
	};
}

/** Audit trail in the events table (surfaced in /admin/activity), mirroring the
 *  feature-flag toggle pattern: instance-wide entry (userId null), actor in the
 *  message. Banners users SEE are worth a trace. */
function audit(adminEmail: string, adminId: number, verb: string, a: { id: number; type: string; title: string }, level: 'info' | 'warn' = 'info'): void {
	recordActivity({
		type: 'admin_announcement',
		userId: null,
		level,
		message: `${adminEmail} ${verb} announcement “${a.title}”`,
		detail: { adminId, announcementId: a.id, announcementType: a.type, action: verb }
	});
}

const DISABLED_ERROR =
	'Announcement banners are turned off for this instance. Enable them under Feature flags first.';

export const actions: Actions = {
	create: async (event) => {
		const admin = requireAdmin(event);
		if (!bannersEnabled(event)) return fail(400, { error: DISABLED_ERROR });
		const form = await event.request.formData();
		try {
			const created = createAnnouncement(parseForm(form));
			audit(admin.email, admin.id, 'created', created);
			return { ok: true };
		} catch (e) {
			if (e instanceof AnnouncementValidationError) return fail(400, { error: e.message });
			throw e;
		}
	},

	update: async (event) => {
		const admin = requireAdmin(event);
		if (!bannersEnabled(event)) return fail(400, { error: DISABLED_ERROR });
		const form = await event.request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Invalid announcement id.' });
		try {
			const updated = updateAnnouncement(id, parseForm(form));
			if (!updated) return fail(404, { error: 'That announcement no longer exists.' });
			audit(admin.email, admin.id, 'updated', updated);
			return { ok: true };
		} catch (e) {
			if (e instanceof AnnouncementValidationError) return fail(400, { error: e.message });
			throw e;
		}
	},

	toggleActive: async (event) => {
		const admin = requireAdmin(event);
		if (!bannersEnabled(event)) return fail(400, { error: DISABLED_ERROR });
		const form = await event.request.formData();
		const id = Number(form.get('id'));
		const active = form.get('active') === 'true';
		if (!Number.isInteger(id)) return fail(400, { error: 'Invalid announcement id.' });
		if (!setAnnouncementActive(id, active)) {
			return fail(404, { error: 'That announcement no longer exists.' });
		}
		const a = getAnnouncement(id)!;
		// Turning a live banner OFF is the consequential direction — mirror the
		// feature-flag audit levels.
		audit(admin.email, admin.id, active ? 'activated' : 'deactivated', a, active ? 'info' : 'warn');
		return { ok: true };
	},

	delete: async (event) => {
		const admin = requireAdmin(event);
		if (!bannersEnabled(event)) return fail(400, { error: DISABLED_ERROR });
		const form = await event.request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id)) return fail(400, { error: 'Invalid announcement id.' });
		const existing = getAnnouncement(id);
		if (!existing || !deleteAnnouncement(id)) {
			return fail(404, { error: 'That announcement no longer exists.' });
		}
		audit(admin.email, admin.id, 'deleted', existing, 'warn');
		return { ok: true };
	}
};
