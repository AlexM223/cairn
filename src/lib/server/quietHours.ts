// Quiet hours: a per-user do-not-disturb window for external notification
// channels (cairn-5gpv.4). During the window, ROUTINE (info/success) sends are
// deferred by the queue worker to the window's end instead of firing; urgent
// (warn/error) security alerts still deliver when quiet_urgent_override is on.
// In-app delivery is never affected — it's a browsable list, not a push.
//
// Times are 'HH:MM' wall-clock in the user's zone (quiet_tz, an IANA name; null =
// the server's local zone). Storing a zone rather than a fixed UTC offset keeps
// the window anchored to local wall-clock across DST changes.

import { db } from './db';
import { childLogger } from './logger';
import type { NotificationLevel } from './notifyTypes';

const log = childLogger('notify:quiet');

export interface QuietHours {
	enabled: boolean;
	/** 'HH:MM' local start, or null when unset. */
	start: string | null;
	/** 'HH:MM' local end, or null when unset. */
	end: string | null;
	/** IANA tz name, or null for the server's local zone. */
	tz: string | null;
	/** When true, warn/error events still deliver during the window. */
	urgentOverride: boolean;
}

export const DEFAULT_QUIET_HOURS: QuietHours = {
	enabled: false,
	start: null,
	end: null,
	tz: null,
	urgentOverride: true
};

interface Row {
	quiet_enabled: number;
	quiet_start: string | null;
	quiet_end: string | null;
	quiet_tz: string | null;
	quiet_urgent_override: number;
}

/** The user's saved quiet-hours settings, or the defaults when none saved. */
export function getQuietHours(userId: number): QuietHours {
	try {
		const row = db
			.prepare(
				`SELECT quiet_enabled, quiet_start, quiet_end, quiet_tz, quiet_urgent_override
				   FROM user_notification_settings WHERE user_id = ?`
			)
			.get(userId) as Row | undefined;
		if (!row) return { ...DEFAULT_QUIET_HOURS };
		return {
			enabled: row.quiet_enabled === 1,
			start: row.quiet_start,
			end: row.quiet_end,
			tz: row.quiet_tz,
			urgentOverride: row.quiet_urgent_override === 1
		};
	} catch (e) {
		log.error({ err: e, userId }, 'failed to read quiet hours');
		return { ...DEFAULT_QUIET_HOURS };
	}
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Validate an 'HH:MM' string; returns minutes-of-day or null when invalid. */
export function parseHhmm(v: string | null | undefined): number | null {
	if (!v) return null;
	const m = HHMM_RE.exec(v.trim());
	if (!m) return null;
	return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** Whether an IANA time-zone name is usable on this runtime. */
export function isValidTimeZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** Persist a user's quiet-hours settings. Throws on invalid input. */
export function setQuietHours(userId: number, input: Partial<QuietHours>): QuietHours {
	const enabled = input.enabled === true;
	const start = input.start ?? null;
	const end = input.end ?? null;
	const tz = input.tz && input.tz.trim() ? input.tz.trim() : null;
	const urgentOverride = input.urgentOverride !== false;

	if (enabled) {
		if (parseHhmm(start) === null || parseHhmm(end) === null) {
			throw new Error('Enter a valid start and end time (HH:MM).');
		}
		if (start === end) {
			throw new Error('Quiet hours start and end cannot be the same time.');
		}
	}
	if (tz && !isValidTimeZone(tz)) {
		throw new Error('Unrecognized time zone.');
	}

	db.prepare(
		`INSERT INTO user_notification_settings
		   (user_id, quiet_enabled, quiet_start, quiet_end, quiet_tz, quiet_urgent_override)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		   quiet_enabled = excluded.quiet_enabled,
		   quiet_start = excluded.quiet_start,
		   quiet_end = excluded.quiet_end,
		   quiet_tz = excluded.quiet_tz,
		   quiet_urgent_override = excluded.quiet_urgent_override`
	).run(userId, enabled ? 1 : 0, start, end, tz, urgentOverride ? 1 : 0);

	return { enabled, start, end, tz, urgentOverride };
}

/** Minutes-of-day (0..1439) for `atMs` in the given zone (null = server local). */
function minutesOfDayInZone(atMs: number, tz: string | null): number {
	const date = new Date(atMs);
	if (!tz) return date.getHours() * 60 + date.getMinutes();
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		}).formatToParts(date);
		const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
		const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
		// Intl can render midnight as '24' in some environments; normalize.
		return ((hour % 24) * 60 + minute) % 1440;
	} catch {
		return date.getHours() * 60 + date.getMinutes();
	}
}

/**
 * Whether `atMs` falls inside the quiet window. Handles windows that wrap past
 * midnight (e.g. 22:00–07:00). Returns false when quiet hours are disabled or the
 * window is not fully configured.
 */
export function isWithinQuietHours(q: QuietHours, atMs: number): boolean {
	if (!q.enabled) return false;
	const startMin = parseHhmm(q.start);
	const endMin = parseHhmm(q.end);
	if (startMin === null || endMin === null || startMin === endMin) return false;

	const nowMin = minutesOfDayInZone(atMs, q.tz);
	if (startMin < endMin) {
		// Same-day window, e.g. 09:00–17:00.
		return nowMin >= startMin && nowMin < endMin;
	}
	// Wrapping window, e.g. 22:00–07:00.
	return nowMin >= startMin || nowMin < endMin;
}

/**
 * The next epoch-ms at which the quiet window ENDS, at or after `atMs`. Used to
 * reschedule a deferred row so it delivers as soon as the window closes. Assumes
 * `atMs` is inside the window (caller checks isWithinQuietHours first). Falls back
 * to atMs + 1h if the end can't be resolved, so a row can never be deferred
 * forever.
 */
export function quietWindowEnd(q: QuietHours, atMs: number): number {
	const endMin = parseHhmm(q.end);
	if (endMin === null) return atMs + 3_600_000;
	const nowMin = minutesOfDayInZone(atMs, q.tz);
	// Minutes remaining until the end-of-window boundary (may be tomorrow).
	let delta = endMin - nowMin;
	if (delta <= 0) delta += 1440;
	return atMs + delta * 60_000;
}

/**
 * Decide what the queue worker should do with a row for `userId` at level
 * `level`, right now. 'send' = deliver; 'defer' = reschedule to windowEnd.
 */
export function quietDecision(
	userId: number,
	level: NotificationLevel,
	nowMs: number
): { action: 'send' } | { action: 'defer'; until: number } {
	const q = getQuietHours(userId);
	if (!isWithinQuietHours(q, nowMs)) return { action: 'send' };
	// Urgent security alerts bypass the window when the user allows it.
	if ((level === 'warn' || level === 'error') && q.urgentOverride) return { action: 'send' };
	return { action: 'defer', until: quietWindowEnd(q, nowMs) };
}
