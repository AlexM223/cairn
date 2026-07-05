// GET/PATCH the signed-in user's per-event-type, per-channel notification
// routing (§4.3 of docs/NOTIFICATION-PLAN.md). Rows in notification_preferences
// only exist once the user has touched a toggle — absence means "use
// DEFAULT_PREFERENCES". GET returns both the saved rows AND the defaults so the
// Settings UI can render "(default)" next to untouched toggles without guessing.

import { json, readJson, requireUser } from '$lib/server/api';
import { db } from '$lib/server/db';
import { childLogger } from '$lib/server/logger';
import { DEFAULT_PREFERENCES } from '$lib/server/notifications';
import {
	NOTIFICATION_CHANNELS,
	NOTIFICATION_EVENT_TYPES,
	type NotificationChannelId,
	type NotificationEventType
} from '$lib/server/notifyTypes';
import type { RequestHandler } from './$types';

const log = childLogger('notify:prefs-api');

const EVENT_TYPES = new Set<string>(NOTIFICATION_EVENT_TYPES);
const CHANNELS = new Set<string>(NOTIFICATION_CHANNELS);

interface PrefRow {
	event_type: string;
	channel: string;
	enabled: number;
	config: string | null;
}

/** One saved routing row, JSON-shaped for the client. */
interface PreferenceDTO {
	eventType: string;
	channel: string;
	enabled: boolean;
	config: Record<string, unknown> | null;
}

function listPreferences(userId: number): PreferenceDTO[] {
	const rows = db
		.prepare(
			`SELECT event_type, channel, enabled, config
			   FROM notification_preferences
			  WHERE user_id = ?`
		)
		.all(userId) as unknown as PrefRow[];
	return rows.map((r) => ({
		eventType: r.event_type,
		channel: r.channel,
		enabled: r.enabled === 1,
		config: parseConfig(r.config)
	}));
}

function parseConfig(raw: string | null): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const v = JSON.parse(raw);
		return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * GET /api/notifications/preferences — the caller's saved routing rows plus the
 * DEFAULT_PREFERENCES map, so the UI knows which toggles are user-set vs default.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	return json({ preferences: listPreferences(user.id), defaults: DEFAULT_PREFERENCES });
};

/**
 * PATCH /api/notifications/preferences — upsert one or more routing rows.
 * Body: { updates: { eventType, channel, enabled, config? }[] }.
 * `config` is an optional small JSON object (per-event tunables:
 * { thresholdSats } for tx_large, { confirmations: number[] } for tx_confirmed).
 * Returns the full refreshed preference list.
 */
export const PATCH: RequestHandler = async (event) => {
	const user = requireUser(event);
	const body = await readJson<{ updates?: unknown }>(event);

	if (!Array.isArray(body.updates)) {
		return json({ error: 'Body must be { updates: [...] }.' }, { status: 400 });
	}

	interface Update {
		eventType: NotificationEventType;
		channel: NotificationChannelId;
		enabled: boolean;
		config: string | null;
	}
	const clean: Update[] = [];

	for (const raw of body.updates) {
		if (!raw || typeof raw !== 'object') {
			return json({ error: 'Each update must be an object.' }, { status: 400 });
		}
		const u = raw as Record<string, unknown>;
		const eventType = String(u.eventType ?? '');
		const channel = String(u.channel ?? '');
		if (!EVENT_TYPES.has(eventType)) {
			return json({ error: `Unknown event type: ${eventType}` }, { status: 400 });
		}
		if (!CHANNELS.has(channel)) {
			return json({ error: `Unknown channel: ${channel}` }, { status: 400 });
		}
		// in-app is always on; it's never queued and has no toggle to persist.
		if (channel === 'inapp') {
			return json({ error: 'The in-app channel is always on.' }, { status: 400 });
		}
		let config: string | null = null;
		if (u.config != null) {
			if (typeof u.config !== 'object') {
				return json({ error: 'config must be an object.' }, { status: 400 });
			}
			config = JSON.stringify(u.config);
		}
		clean.push({
			eventType: eventType as NotificationEventType,
			channel: channel as NotificationChannelId,
			enabled: u.enabled !== false,
			config
		});
	}

	const upsert = db.prepare(
		`INSERT INTO notification_preferences (user_id, event_type, channel, enabled, config)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, event_type, channel)
		 DO UPDATE SET enabled = excluded.enabled, config = excluded.config`
	);

	try {
		db.exec('BEGIN');
		try {
			for (const u of clean) {
				upsert.run(user.id, u.eventType, u.channel, u.enabled ? 1 : 0, u.config);
			}
			db.exec('COMMIT');
		} catch (e) {
			db.exec('ROLLBACK');
			throw e;
		}
	} catch (e) {
		log.error({ err: e, userId: user.id }, 'failed to save notification preferences');
		return json({ error: 'Could not save preferences.' }, { status: 500 });
	}

	return json({ preferences: listPreferences(user.id), defaults: DEFAULT_PREFERENCES });
};
