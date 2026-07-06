import { json, requireUser } from '$lib/server/api';
import { dismissBackupReminder } from '$lib/server/backups';
import type { RequestHandler } from './$types';

/**
 * POST /api/backup-reminder/dismiss — silence the 90-day "download fresh
 * backups" reminder for this user. Server-side (not localStorage) so the
 * dismissal persists across browsers and devices; it lapses after 90 days, at
 * which point the reminder can surface again if backups are still stale.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	dismissBackupReminder(user.id);
	return json({ ok: true });
};
