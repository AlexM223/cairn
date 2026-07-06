import { error } from '@sveltejs/kit';
import { json, requireUser } from '$lib/server/api';
import { dismissAnnouncement } from '$lib/server/announcements';
import type { RequestHandler } from './$types';

/**
 * POST /api/announcements/:id/dismiss — hide an announcement banner for THIS
 * user, permanently (server-side row, so it stays hidden across browsers and
 * devices). Mirrors /api/backup-reminder/dismiss.
 *
 * A non-dismissible announcement can't be dismissed here either — the missing
 * ✕ button in the UI is a courtesy; the 409 is the real boundary. 404 for ids
 * that don't exist (including non-numeric ones).
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = Number(event.params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Announcement not found');

	const result = dismissAnnouncement(user.id, id);
	if (result === 'not_found') error(404, 'Announcement not found');
	if (result === 'not_dismissible') error(409, "This announcement can't be dismissed");
	return json({ ok: true });
};
