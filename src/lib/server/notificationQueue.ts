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
import { quietDecision } from './quietHours';
import type {
	ChannelSendResult,
	NotificationChannelId,
	NotificationLevel,
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
let markDeferred: ReturnType<typeof db.prepare> | null = null;

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
	// Quiet-hours deferral: stays 'pending', attempts UNCHANGED (a deferral is not
	// a failed attempt) — only next_attempt_at moves to the window's end.
	markDeferred = db.prepare(
		`UPDATE notification_queue SET next_attempt_at = ? WHERE id = ?`
	);
}

/** Priority rank for intra-tick ordering: urgent (warn/error) ahead of routine. */
function levelRank(level: NotificationLevel): number {
	if (level === 'error') return 3;
	if (level === 'warn') return 2;
	return 0; // info / success
}

/** The level carried by a queue row's payload, defaulting to 'info' if the JSON
 *  can't be read (processRow will mark such a row failed for corrupt payload). */
function rowLevel(row: QueueRow): NotificationLevel {
	try {
		const level = (JSON.parse(row.payload) as NotificationPayload).level;
		return level === 'error' || level === 'warn' || level === 'success' ? level : 'info';
	} catch {
		return 'info';
	}
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

	applySendResult(row, result);
}

/** Update one queue row's status from a send result: sent / failed(non-retryable)
 *  / retry-with-backoff / dead. Extracted so the batch (digest) path can apply the
 *  same outcome to each coalesced row without duplicating the state machine. */
function applySendResult(row: QueueRow, result: ChannelSendResult): void {
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

/** Event types whose bursts are worth collapsing into a single digest send
 *  (cairn-5gpv.3): a block that confirms N of a user's UTXOs, or one Electrum
 *  callback touching N watched addresses, otherwise fires N separate external
 *  messages back-to-back. Non-batchable types (security alerts, admin events) are
 *  low-volume and each carries distinct, individually-actionable context. */
const BATCHABLE_EVENT_TYPES = new Set<string>(['tx_received', 'tx_confirmed']);

/** Collapse several same-type payloads into one digest NotificationPayload. The
 *  channel plugins send a single payload, so a digest is just a summary payload —
 *  no plugin changes needed. */
function buildDigest(eventType: string, payloads: NotificationPayload[]): NotificationPayload {
	const n = payloads.length;
	const userId = payloads[0].userId;
	// Carry the most-severe level in the group.
	const level = payloads.reduce<NotificationLevel>(
		(acc, p) => (levelRank(p.level) > levelRank(acc) ? p.level : acc),
		payloads[0].level
	);
	// Deep-link to the common target if every row shares it, else the activity feed
	// (the digest spans multiple wallets/txs, so no single tx page fits).
	const firstLink = payloads[0].link;
	const link = firstLink && payloads.every((p) => p.link === firstLink) ? firstLink : '/activity';

	let title: string;
	let body: string;
	if (eventType === 'tx_confirmed') {
		title = `${n} transactions confirmed`;
		body = `${n} transactions in your wallets just reached enough confirmations.`;
	} else if (eventType === 'tx_received') {
		title = `${n} payments received`;
		body = `${n} inbound payments were detected across your wallets.`;
	} else {
		title = `${n} notifications`;
		body = `You have ${n} new notifications.`;
	}

	return {
		type: eventType as NotificationPayload['type'],
		userId,
		level,
		title,
		body,
		detail: { coalesced: true, count: n },
		link
	};
}

/** Send one digest for a coalesced group and apply the outcome to every row in
 *  it: on success every row is marked sent; on failure each row runs through the
 *  normal retry/dead state machine (so a transient error re-coalesces next tick). */
async function processBatch(
	userId: number,
	channel: Exclude<NotificationChannelId, 'inapp'>,
	eventType: string,
	items: { row: QueueRow; payload: NotificationPayload }[]
): Promise<void> {
	const plugin = CHANNELS[channel];
	const digest = buildDigest(
		eventType,
		items.map((i) => i.payload)
	);

	let result: ChannelSendResult;
	try {
		result = await plugin.send(userId, digest);
	} catch (e) {
		result = { ok: false, error: e instanceof Error ? e.message : String(e), retryable: true };
		log.error({ err: e, channel, userId, type: eventType }, 'digest plugin.send() threw');
	}

	if (result.ok) {
		for (const { row } of items) markSent!.run(row.id);
		log.info({ channel, userId, type: eventType, count: items.length }, 'notification digest sent');
		return;
	}
	// Apply the same outcome to each coalesced row through the normal state machine.
	for (const { row } of items) applySendResult(row, result);
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

		// Priority-aware ordering (cairn-5gpv.4): process warn/error rows ahead of
		// routine info/success within this tick so an urgent alert queued behind a
		// burst of routine rows doesn't wait its FIFO turn. Ties keep FIFO (id ASC).
		const ordered = rows
			.map((row) => ({ row, level: rowLevel(row) }))
			.sort((a, b) => levelRank(b.level) - levelRank(a.level) || a.row.id - b.row.id);

		// Resolve quiet-hours deferrals up front and parse each survivor's payload
		// once (reused for both the individual and digest paths).
		const active: { row: QueueRow; payload: NotificationPayload | null }[] = [];
		for (const { row, level } of ordered) {
			// Quiet hours (cairn-5gpv.4): defer a routine send to the window's end
			// rather than firing a 3am push. Urgent alerts bypass per the user's
			// override. In-app is unaffected — it was delivered inline by notify().
			const decision = quietDecision(row.user_id, level, now);
			if (decision.action === 'defer') {
				markDeferred!.run(new Date(decision.until).toISOString(), row.id);
				continue;
			}
			let payload: NotificationPayload | null;
			try {
				payload = JSON.parse(row.payload) as NotificationPayload;
			} catch {
				payload = null; // processRow will mark it failed on the individual path
			}
			active.push({ row, payload });
		}

		// Coalesce same (user, channel, event_type) bursts of a batchable type into
		// one digest (cairn-5gpv.3). Webhook is excluded — automation consumers want
		// one JSON object per event, not a summary. A group of one is not a burst and
		// falls through to the normal individual send.
		const groups = new Map<string, { row: QueueRow; payload: NotificationPayload }[]>();
		for (const { row, payload } of active) {
			if (!payload) continue;
			if (!BATCHABLE_EVENT_TYPES.has(row.event_type) || row.channel === 'webhook') continue;
			const key = `${row.user_id}|${row.channel}|${row.event_type}`;
			const arr = groups.get(key) ?? [];
			arr.push({ row, payload });
			groups.set(key, arr);
		}
		const coalescedIds = new Set<number>();
		for (const items of groups.values()) {
			if (items.length >= 2) for (const it of items) coalescedIds.add(it.row.id);
		}

		// Individual sends first, in priority order (urgent ahead of routine).
		for (const { row } of active) {
			if (coalescedIds.has(row.id)) continue;
			const channel = row.channel as NotificationChannelId;
			if (!takeToken(channel, now)) continue; // rate-limited; leave pending
			await processRow(row);
		}

		// Then one digest per coalesced group.
		for (const items of groups.values()) {
			if (items.length < 2) continue;
			const first = items[0].row;
			const channel = first.channel as Exclude<NotificationChannelId, 'inapp'>;
			if (!takeToken(channel, now)) continue; // rate-limited; whole group waits
			await processBatch(first.user_id, channel, first.event_type, items);
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
