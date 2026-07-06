// Admin → Notifications (Unit 10, §5). Loads the instance-wide notification
// config (SMTP relay, Telegram bot token, ntfy default server, Nostr default
// relays, webhook SSRF escape-hatch) with secrets redacted to presence booleans,
// plus the delivery-health snapshot read straight from notification_queue.
// Saving happens via POST /api/admin/notifications; this loader is read-only.
//
// The route lives under /admin, so the admin layout's isAdmin gate already
// protects the page; the API routes it calls each re-check requireAdmin.

import { db } from '$lib/server/db';
import { getPublicInstanceNotificationSettings } from '$lib/server/notifyConfig';
import type { PageServerLoad } from './$types';

interface StatusCountRow {
	status: string;
	n: number;
}

interface FailedRow {
	id: number;
	user_id: number;
	channel: string;
	event_type: string;
	status: string;
	attempts: number;
	last_error: string | null;
	next_attempt_at: string;
	created_at: string;
}

export const load: PageServerLoad = async () => {
	// --- Instance settings (secrets redacted) --------------------------------
	// Shared redactor (cairn-ofna) — the source of truth for which fields are
	// secret. telegramBotToken ('') is dropped below since the page only needs the
	// hasTelegramBotToken flag.
	const { telegramBotToken, ...settings } = getPublicInstanceNotificationSettings();

	// --- Delivery health -----------------------------------------------------
	// Counts by status, plus the most recent failed/dead rows with their errors.
	const countRows = db
		.prepare('SELECT status, COUNT(*) AS n FROM notification_queue GROUP BY status')
		.all() as unknown as StatusCountRow[];
	const counts: Record<string, number> = { pending: 0, sent: 0, failed: 0, dead: 0 };
	for (const r of countRows) counts[r.status] = r.n;

	const recentFailures = db
		.prepare(
			`SELECT id, user_id, channel, event_type, status, attempts, last_error, next_attempt_at, created_at
			   FROM notification_queue
			  WHERE status IN ('failed', 'dead')
			  ORDER BY id DESC
			  LIMIT 25`
		)
		.all() as unknown as FailedRow[];

	const failures = recentFailures.map((r) => ({
		id: r.id,
		userId: r.user_id,
		channel: r.channel,
		eventType: r.event_type,
		status: r.status,
		attempts: r.attempts,
		lastError: r.last_error,
		createdAt: r.created_at
	}));

	return { settings, health: { counts, failures } };
};
