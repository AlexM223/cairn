// User-facing activity feed service.
//
// This is NOT the server error log (that's logger.ts + the admin log viewer).
// These are friendly, human-readable events a user should know about: network
// connectivity, new blocks, scans finishing, broadcasts, signing sessions,
// electrum switches. Stored in the `events` table (see db.ts) and surfaced on
// /activity. Adapted from Bastion's audit_log pattern, minus anything sensitive.

import { db } from './db';
import { childLogger } from './logger';

const log = childLogger('activity');

/** UI tone for an event row. */
export type ActivityLevel = 'info' | 'success' | 'warn' | 'error';

/** Known event kinds. Free strings are allowed, but keep new kinds here. */
export type ActivityType =
	| 'network_up'
	| 'network_down'
	| 'new_block'
	| 'scan_complete'
	| 'broadcast'
	| 'signing_started'
	| 'electrum_switched'
	| 'wallet_added'
	| 'wallet_created';

export interface ActivityEvent {
	id: number;
	type: string;
	level: ActivityLevel;
	message: string;
	detail: Record<string, unknown> | null;
	createdAt: string;
	/** 'you' for a user-scoped event, 'instance' for an instance-wide one. */
	scope: 'you' | 'instance';
}

interface EventRow {
	id: number;
	user_id: number | null;
	type: string;
	level: string;
	message: string;
	detail: string | null;
	created_at: string;
}

/** Retained rows per user (and per the instance-wide NULL bucket). */
export const EVENTS_PER_BUCKET = 500;

function mapRow(row: EventRow): ActivityEvent {
	let detail: Record<string, unknown> | null = null;
	if (row.detail) {
		try {
			detail = JSON.parse(row.detail) as Record<string, unknown>;
		} catch {
			detail = null;
		}
	}
	return {
		id: row.id,
		type: row.type,
		level: (row.level as ActivityLevel) ?? 'info',
		message: row.message,
		detail,
		createdAt: row.created_at,
		scope: row.user_id === null ? 'instance' : 'you'
	};
}

/**
 * Record an activity event. `userId` omitted/null makes it instance-wide (shown
 * to every user); otherwise it's scoped to that user. Best-effort: a failure is
 * logged but never thrown, so activity tracking can never break the operation
 * that triggered it. `detail` must contain no secrets (no PSBTs, keys, tokens).
 */
export function recordActivity(input: {
	type: ActivityType | string;
	message: string;
	level?: ActivityLevel;
	userId?: number | null;
	detail?: Record<string, unknown> | null;
}): void {
	try {
		const userId = input.userId ?? null;
		const detail = input.detail == null ? null : JSON.stringify(input.detail);
		db.prepare(
			'INSERT INTO events (user_id, type, level, message, detail) VALUES (?, ?, ?, ?, ?)'
		).run(userId, input.type, input.level ?? 'info', input.message, detail);
		prune(userId);
	} catch (e) {
		log.error({ err: e, type: input.type }, 'failed to record activity event');
	}
}

/** Trim the just-inserted bucket back down to EVENTS_PER_BUCKET newest rows. */
function prune(userId: number | null): void {
	if (userId === null) {
		db.prepare(
			`DELETE FROM events
			  WHERE user_id IS NULL
			    AND id NOT IN (SELECT id FROM events WHERE user_id IS NULL ORDER BY id DESC LIMIT ?)`
		).run(EVENTS_PER_BUCKET);
	} else {
		db.prepare(
			`DELETE FROM events
			  WHERE user_id = ?
			    AND id NOT IN (SELECT id FROM events WHERE user_id = ? ORDER BY id DESC LIMIT ?)`
		).run(userId, userId, EVENTS_PER_BUCKET);
	}
}

/**
 * The activity feed for one user: their own events plus instance-wide ones,
 * newest first. `limit` is clamped to [1, EVENTS_PER_BUCKET].
 */
export function listActivity(userId: number, limit = 100): ActivityEvent[] {
	const capped = Math.min(Math.max(1, Math.floor(limit) || 0), EVENTS_PER_BUCKET);
	const rows = db
		.prepare(
			`SELECT id, user_id, type, level, message, detail, created_at
			   FROM events
			  WHERE user_id = ? OR user_id IS NULL
			  ORDER BY id DESC
			  LIMIT ?`
		)
		.all(userId, capped) as unknown as EventRow[];
	return rows.map(mapRow);
}
