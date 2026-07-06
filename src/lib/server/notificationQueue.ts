// src/lib/server/notificationQueue.ts
//
// The outbound notification delivery worker (§1.4 of docs/NOTIFICATION-PLAN.md).
// A single background loop (setInterval, unref'd) that drains
// notification_queue: pulls due 'pending' rows, rate-limits per channel, calls
// the channel plugin's send(), and updates each row's status per the send
// result. In-app delivery is NOT here — that's the direct recordActivity() write
// notify() does; this worker only handles external channels.
//
// Started once from hooks.server.ts. Idempotent to call: a second call is a
// no-op while the first loop is still running.

import { db } from './db';
import { childLogger } from './logger';
import { CHANNELS } from './notifications';
import type {
	ChannelSendResult,
	NotificationChannelId,
	NotificationPayload
} from './notifyTypes';

const log = childLogger('notify:queue');

/** How often the worker wakes to drain the queue. */
const TICK_MS = 5_000;
/** Max rows pulled per tick (also the FIFO batch size). */
const BATCH_LIMIT = 20;
/** Give up after this many attempts — the row goes 'dead'. */
const MAX_ATTEMPTS = 5;

/**
 * Retry backoff by attempt number (1-indexed): after the Nth failed attempt,
 * wait backoff[N-1] before the next try. Five entries mirror MAX_ATTEMPTS; the
 * fifth failure trips MAX_ATTEMPTS and marks the row dead before this is used.
 */
const BACKOFF_MS = [
	30_000, // 30s
	120_000, // 2m
	600_000, // 10m
	1_800_000, // 30m
	7_200_000 // 2h
];

function backoffMs(attempts: number): number {
	const idx = Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1;
	return BACKOFF_MS[idx];
}

/** Per-channel token bucket: ~5 sends/sec/channel, so we're a good citizen of
 *  whatever server the user pointed us at (Telegram caps ~30/sec; the rest are
 *  looser, but we rate-limit them uniformly). Refills continuously up to the
 *  bucket size. In-memory only — resets on restart, which is fine. */
const RATE_PER_SEC = 5;
const BUCKET_SIZE = 5;

interface Bucket {
	tokens: number;
	last: number; // ms timestamp of last refill
}
const buckets = new Map<NotificationChannelId, Bucket>();

/** Try to consume one token for `channel`. Returns true if a send is allowed
 *  right now, false if the channel is rate-limited this tick (the row is left
 *  pending and retried next tick). */
function takeToken(channel: NotificationChannelId, now: number): boolean {
	let b = buckets.get(channel);
	if (!b) {
		b = { tokens: BUCKET_SIZE, last: now };
		buckets.set(channel, b);
	}
	const elapsedSec = (now - b.last) / 1000;
	if (elapsedSec > 0) {
		b.tokens = Math.min(BUCKET_SIZE, b.tokens + elapsedSec * RATE_PER_SEC);
		b.last = now;
	}
	if (b.tokens >= 1) {
		b.tokens -= 1;
		return true;
	}
	return false;
}

interface QueueRow {
	id: number;
	user_id: number;
	channel: string;
	event_type: string;
	payload: string;
	attempts: number;
}

// Prepared statements are created lazily on first tick so that importing this
// module has no side effects (matches the rest of the server graph).
let selectDue: ReturnType<typeof db.prepare> | null = null;
let markSent: ReturnType<typeof db.prepare> | null = null;
let markFailed: ReturnType<typeof db.prepare> | null = null;
let markDead: ReturnType<typeof db.prepare> | null = null;
let markRetry: ReturnType<typeof db.prepare> | null = null;

function prepareStatements(): void {
	if (selectDue) return;
	selectDue = db.prepare(
		`SELECT id, user_id, channel, event_type, payload, attempts
		   FROM notification_queue
		  WHERE status = 'pending'
		    AND next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		  ORDER BY id ASC
		  LIMIT ?`
	);
	markSent = db.prepare(
		`UPDATE notification_queue
		    SET status = 'sent',
		        sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		        last_error = NULL
		  WHERE id = ?`
	);
	markFailed = db.prepare(
		`UPDATE notification_queue
		    SET status = 'failed', last_error = ?
		  WHERE id = ?`
	);
	markDead = db.prepare(
		`UPDATE notification_queue
		    SET status = 'dead', attempts = ?, last_error = ?
		  WHERE id = ?`
	);
	// Stays 'pending'; attempts incremented, next_attempt_at pushed out by backoff.
	markRetry = db.prepare(
		`UPDATE notification_queue
		    SET attempts = ?, last_error = ?, next_attempt_at = ?
		  WHERE id = ?`
	);
}

/** Process one queue row: call its channel plugin's send() and update status
 *  per the ChannelSendResult. Never throws — a plugin that throws is treated as
 *  a retryable failure (transient) so a coding bug in one channel can't wedge
 *  the whole queue. */
async function processRow(row: QueueRow): Promise<void> {
	const channel = row.channel as NotificationChannelId;
	const plugin = channel === 'inapp' ? undefined : CHANNELS[channel as Exclude<NotificationChannelId, 'inapp'>];

	if (!plugin) {
		// Unknown / in-app channel should never have been queued — mark failed so
		// it doesn't spin forever, and log loudly.
		markFailed!.run(`No plugin for channel '${row.channel}'`, row.id);
		log.error(
			{ id: row.id, channel: row.channel, userId: row.user_id },
			'queue row for unknown channel; marked failed'
		);
		return;
	}

	let payload: NotificationPayload;
	try {
		payload = JSON.parse(row.payload) as NotificationPayload;
	} catch (e) {
		markFailed!.run('Corrupt payload JSON', row.id);
		log.error({ err: e, id: row.id, channel: row.channel }, 'corrupt queue payload; marked failed');
		return;
	}

	let result: ChannelSendResult;
	try {
		result = await plugin.send(row.user_id, payload);
	} catch (e) {
		// A thrown error is transient by assumption — retry with backoff.
		result = { ok: false, error: e instanceof Error ? e.message : String(e), retryable: true };
		log.error({ err: e, id: row.id, channel: row.channel, userId: row.user_id }, 'plugin.send() threw');
	}

	if (result.ok) {
		markSent!.run(row.id);
		log.info(
			{ id: row.id, channel: row.channel, userId: row.user_id, type: row.event_type },
			'notification sent'
		);
		return;
	}

	const errText = result.error ?? 'unknown error';

	if (!result.retryable) {
		markFailed!.run(errText, row.id);
		log.warn(
			{ id: row.id, channel: row.channel, userId: row.user_id, type: row.event_type, error: errText },
			'notification failed (non-retryable)'
		);
		return;
	}

	// Retryable failure: this attempt counts. Dead once we hit MAX_ATTEMPTS.
	const attempts = row.attempts + 1;
	if (attempts >= MAX_ATTEMPTS) {
		markDead!.run(attempts, errText, row.id);
		log.warn(
			{ id: row.id, channel: row.channel, userId: row.user_id, type: row.event_type, attempts, error: errText },
			'notification dead (max attempts exceeded)'
		);
		return;
	}

	const nextAt = new Date(Date.now() + backoffMs(attempts)).toISOString();
	markRetry!.run(attempts, errText, nextAt, row.id);
	log.warn(
		{ id: row.id, channel: row.channel, userId: row.user_id, type: row.event_type, attempts, nextAt, error: errText },
		'notification retry scheduled'
	);
}

/** One drain pass: pull due rows and process each, honoring the per-channel
 *  rate limit. A rate-limited row is simply left pending and picked up next
 *  tick. Never throws — a failure logs and the loop lives to tick again. */
async function tick(): Promise<void> {
	try {
		prepareStatements();
		const now = Date.now();
		const rows = selectDue!.all(BATCH_LIMIT) as unknown as QueueRow[];
		if (rows.length === 0) return;

		for (const row of rows) {
			const channel = row.channel as NotificationChannelId;
			if (!takeToken(channel, now)) {
				// Rate-limited this tick; leave pending for the next pass.
				continue;
			}
			await processRow(row);
		}
	} catch (e) {
		log.error({ err: e }, 'queue tick failed');
	}
}

let started = false;
let running = false; // reentrancy guard: never overlap two ticks

/**
 * Start the notification queue worker. Idempotent — safe to call more than once
 * (subsequent calls are no-ops). The interval is unref'd so it never keeps the
 * process alive on its own (matches the SSE heartbeat's posture).
 */
export function startNotificationQueueWorker(): void {
	if (started) return;
	started = true;

	const timer = setInterval(() => {
		if (running) return; // previous tick still in flight — skip this one
		running = true;
		void tick().finally(() => {
			running = false;
		});
	}, TICK_MS);

	// Don't let this timer hold the event loop open on shutdown.
	if (typeof timer.unref === 'function') timer.unref();

	log.info({ tickMs: TICK_MS, batchLimit: BATCH_LIMIT }, 'notification queue worker started');
}

// Exported for tests.
export const _internals = { backoffMs, takeToken, buckets, BACKOFF_MS, MAX_ATTEMPTS, tick };
