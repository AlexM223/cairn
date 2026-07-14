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
	| 'wallet_created'
	| 'key_reuse';

export interface ActivityEvent {
	id: number;
	type: string;
	level: ActivityLevel;
	message: string;
	detail: Record<string, unknown> | null;
	createdAt: string;
	/** 'you' for a user-scoped event, 'instance' for an instance-wide one. */
	scope: 'you' | 'instance';
	/** ISO timestamp this event was marked read, or null when still unread.
	 *  Read state is instance-wide (a single column on the row, shared across
	 *  users) — the simpler model documented in NOTIFICATION-PLAN §2.1, matching
	 *  how /activity already treats instance-wide events as stateless rows. */
	readAt: string | null;
}

interface EventRow {
	id: number;
	user_id: number | null;
	type: string;
	level: string;
	message: string;
	detail: string | null;
	created_at: string;
	read_at: string | null;
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
		scope: row.user_id === null ? 'instance' : 'you',
		readAt: row.read_at ?? null
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
 *
 * NOTE: this is the RAW feed (everything the user is allowed to see, including
 * instance-wide operational events). The user-facing /activity page and the bell
 * use {@link listUserFeed} instead — the simplified "what happened with MY
 * bitcoin" view. listActivity is kept for internal/admin-adjacent callers.
 */
export function listActivity(userId: number, limit = 100): ActivityEvent[] {
	const capped = Math.min(Math.max(1, Math.floor(limit) || 0), EVENTS_PER_BUCKET);
	const rows = db
		.prepare(
			`SELECT id, user_id, type, level, message, detail, created_at, read_at
			   FROM events
			  WHERE user_id = ? OR user_id IS NULL
			  ORDER BY id DESC
			  LIMIT ?`
		)
		.all(userId, capped) as unknown as EventRow[];
	return rows.map(mapRow);
}

// ---------------------------------------------------------------------------
// USER feed vs ADMIN log split.
//
// The USER feed is "what happened with MY bitcoin" — a clean, iPhone-notification-
// center-style view of the user's OWN relevant events in plain language. It hides
// server internals (network/block/electrum), other users' events, and admin
// broadcasts. The ADMIN log (listAllActivity) is the operational firehose: every
// event, every user, filterable.
//
// FAIL CLOSED: the user feed shows ONLY the explicitly-whitelisted types below,
// so any operational event type added later can never leak into it — a new type
// is admin-only until someone deliberately adds it here.

/** Event types that belong in a user's personal activity feed. */
export const USER_FEED_TYPES: ReadonlySet<string> = new Set([
	// Your bitcoin moving
	'tx_received',
	'tx_confirmed',
	'tx_replaced',
	'tx_large',
	'broadcast',
	// Your wallets
	'wallet_added',
	'wallet_created',
	// A key you just added to a multisig is already committed to another of
	// your wallets (cairn-1kc3.4) — the user must see this, non-blocking.
	'key_reuse',
	'backup_downloaded',
	'backup_missing',
	'backup_stale',
	// Signing
	'signing_started',
	'sign_session_waiting',
	// A shared multisig you had access to was removed because its owner deleted
	// their account (cairn-8r0l) — the cosigner must see this, non-blocking.
	'multisig_removed',
	// A cosigner with a pending (awaiting_signature, unsigned) slot deleted their
	// own account (cairn-z93o) — the owner needs to know the roster vacated.
	'cosigner_left',
	// Key health nudge
	'key_health_due',
	// Social graph (collaborative custody): a pending request the recipient must
	// act on, and confirmation your own request was accepted (cairn-1wvp).
	'contact_request',
	'contact_accepted',
	// Your own account security ("was this you?")
	'security_new_passkey',
	'security_password_changed',
	'security_new_device',
	'security_failed_login',
	'account_recovery',
	'account_recovery_codes_set',
	'account_recovery_phrase_set',
	'admin_break_glass'
]);

/** Whether an event type is shown in the simplified per-user activity feed. */
export function isUserFeedType(type: string): boolean {
	return USER_FEED_TYPES.has(type);
}

/**
 * The simplified activity feed for one user: only THEIR OWN events (never
 * instance-wide ones) and only user-relevant types (see USER_FEED_TYPES).
 * Plain-language "what happened with my bitcoin" — no server internals.
 */
export function listUserFeed(userId: number, limit = 100): ActivityEvent[] {
	const capped = Math.min(Math.max(1, Math.floor(limit) || 0), EVENTS_PER_BUCKET);
	const placeholders = [...USER_FEED_TYPES].map(() => '?').join(', ');
	const rows = db
		.prepare(
			`SELECT id, user_id, type, level, message, detail, created_at, read_at
			   FROM events
			  WHERE user_id = ? AND type IN (${placeholders})
			  ORDER BY id DESC
			  LIMIT ?`
		)
		.all(userId, ...USER_FEED_TYPES, capped) as unknown as EventRow[];
	return rows.map(mapRow);
}

/** Unread count for a user's simplified feed (own, whitelisted, unread). */
export function unreadUserFeedCount(userId: number): number {
	const placeholders = [...USER_FEED_TYPES].map(() => '?').join(', ');
	const row = db
		.prepare(
			`SELECT COUNT(*) AS n FROM events
			  WHERE user_id = ? AND read_at IS NULL AND type IN (${placeholders})`
		)
		.get(userId, ...USER_FEED_TYPES) as { n: number };
	return row.n;
}

/** Mark a user's own feed events read (all, or a specific id list). */
export function markUserFeedRead(userId: number, ids?: number[]): void {
	if (ids && ids.length === 0) return;
	const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
	if (ids && ids.length) {
		const clean = ids.map(Number).filter(Number.isInteger).slice(0, 500);
		if (!clean.length) return;
		const ph = clean.map(() => '?').join(', ');
		db.prepare(
			`UPDATE events SET read_at = ${now}
			  WHERE id IN (${ph}) AND user_id = ? AND read_at IS NULL`
		).run(...clean, userId);
	} else {
		const typePh = [...USER_FEED_TYPES].map(() => '?').join(', ');
		db.prepare(
			`UPDATE events SET read_at = ${now}
			  WHERE user_id = ? AND read_at IS NULL AND type IN (${typePh})`
		).run(userId, ...USER_FEED_TYPES);
	}
}

/** One row of the admin activity log — an event plus who it belongs to. */
export interface AdminActivityEvent extends ActivityEvent {
	/** The user this event is scoped to, or null for an instance-wide event. */
	userId: number | null;
	userEmail: string | null;
	userName: string | null;
}

export interface AdminActivityFilters {
	/** Exact event type (e.g. 'tx_received'). */
	type?: string;
	/** Exact level ('info'|'success'|'warn'|'error'). */
	level?: string;
	/** Restrict to one user's events; pass null for instance-wide only. */
	userId?: number | null;
	/** Case-insensitive substring match on the message. */
	search?: string;
	limit?: number;
	offset?: number;
	/**
	 * Include each event's raw `detail` JSON (full txids, wallet ids, ...).
	 * OFF by default (cairn-o1dp.5): the admin UI only renders the message, and
	 * the unfiltered detail stream is more cross-user visibility than any admin
	 * needs by default on a multi-admin instance. Pass true (API:
	 * ?includeDetail=true) for a genuine support/debugging session.
	 */
	includeDetail?: boolean;
}

/**
 * The full activity log for admins: EVERY event across all users and the
 * instance-wide bucket, joined to the owning user, filterable and paginated.
 * Newest first. This is the operational visibility the user feed deliberately
 * hides.
 */
export function listAllActivity(filters: AdminActivityFilters = {}): {
	events: AdminActivityEvent[];
	total: number;
} {
	const where: string[] = [];
	const params: (string | number)[] = [];
	if (filters.type) {
		where.push('e.type = ?');
		params.push(filters.type);
	}
	if (filters.level) {
		where.push('e.level = ?');
		params.push(filters.level);
	}
	if (filters.userId === null) {
		where.push('e.user_id IS NULL');
	} else if (typeof filters.userId === 'number') {
		where.push('e.user_id = ?');
		params.push(filters.userId);
	}
	if (filters.search) {
		where.push('e.message LIKE ? COLLATE NOCASE');
		params.push(`%${filters.search}%`);
	}
	const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

	const total = (
		db.prepare(`SELECT COUNT(*) AS n FROM events e ${whereSql}`).get(...params) as { n: number }
	).n;

	const limit = Math.min(Math.max(1, Math.floor(filters.limit ?? 200)), 1000);
	const offset = Math.max(0, Math.floor(filters.offset ?? 0));
	const rows = db
		.prepare(
			`SELECT e.id, e.user_id, e.type, e.level, e.message, e.detail, e.created_at, e.read_at,
			        u.email AS user_email, u.display_name AS user_name
			   FROM events e LEFT JOIN users u ON u.id = e.user_id
			   ${whereSql}
			  ORDER BY e.id DESC
			  LIMIT ? OFFSET ?`
		)
		.all(...params, limit, offset) as unknown as (EventRow & {
		user_email: string | null;
		user_name: string | null;
	})[];

	const events = rows.map((r) => ({
		...mapRow(r),
		// The raw detail payload is opt-in only — see AdminActivityFilters.
		...(filters.includeDetail ? {} : { detail: null }),
		userId: r.user_id,
		userEmail: r.user_email,
		userName: r.user_name
	}));
	return { events, total };
}

/** Distinct event types present in the log — powers the admin filter dropdown. */
export function distinctActivityTypes(): string[] {
	return (db.prepare('SELECT DISTINCT type FROM events ORDER BY type').all() as { type: string }[]).map(
		(r) => r.type
	);
}
