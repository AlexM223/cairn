// src/lib/server/notifications.ts
//
// Core notification dispatcher (§1.3 of docs/NOTIFICATION-PLAN.md). The one
// entry point the rest of the app calls: notify(payload). In-app delivery is
// instant (it IS the activity feed); external channels are enqueued for the
// queue worker (notificationQueue.ts) to deliver with retry/backoff.

import { db } from './db';
import { isFeatureEnabled } from './featureFlags/resolve';
import { recordActivity } from './activity';
import { notifyBus } from './notifyBus';
import { childLogger } from './logger';
import {
	NOTIFICATION_CHANNELS,
	type NotificationChannelId,
	type NotificationChannelPlugin,
	type NotificationPayload
} from './notifyTypes';

import emailChannel from './channels/email';
import telegramChannel from './channels/telegram';
import ntfyChannel from './channels/ntfy';
import nostrChannel from './channels/nostr';
import webhookChannel from './channels/webhook';

const log = childLogger('notify');

/**
 * Channel plugin registry — a plain object built from static imports of each
 * channel module (no dynamic discovery; there are exactly 6 channels, all known
 * at build time). `inapp` is intentionally NOT here: it's not a queue consumer,
 * it's the direct recordActivity() write notify() does below.
 *
 * This registry is the ONE place Units 3-7 need to be added to — one import +
 * one entry each. The queue worker and the settings/admin UIs read this object;
 * they never touch a channel's internals.
 */
export const CHANNELS: Record<Exclude<NotificationChannelId, 'inapp'>, NotificationChannelPlugin> = {
	email: emailChannel,
	telegram: telegramChannel,
	ntfy: ntfyChannel,
	nostr: nostrChannel,
	webhook: webhookChannel
};

/** Fallback routing when a user has never touched Settings > Notifications.
 *  Conservative: everything in-app only by default, external channels opt-in.
 *  Exported so the Settings UI (Unit 9) can show "(default)" next to untouched
 *  toggles instead of guessing. */
export const DEFAULT_PREFERENCES: Record<string, NotificationChannelId[]> = {
	tx_received: ['inapp'],
	tx_confirmed: ['inapp'],
	tx_large: ['inapp'],
	key_health_due: ['inapp'],
	backup_missing: ['inapp'],
	backup_stale: ['inapp'],
	sign_session_waiting: ['inapp'],
	sign_session_complete: ['inapp'],
	admin_new_signup: ['inapp'],
	admin_invite_used: ['inapp'],
	admin_restore: ['inapp'],
	admin_server_health: ['inapp'],
	admin_user_disabled: ['inapp'],
	admin_settings_changed: ['inapp'],
	admin_recovery_code_minted: ['inapp'],
	security_failed_login: ['inapp'],
	security_new_passkey: ['inapp'],
	security_password_changed: ['inapp'],
	security_new_device: ['inapp']
};

/** Every non-inapp channel id — the set resolveRecipients can enqueue. */
const EXTERNAL_CHANNELS = NOTIFICATION_CHANNELS.filter(
	(c): c is Exclude<NotificationChannelId, 'inapp'> => c !== 'inapp'
);

interface PreferenceRow {
	channel: string;
	enabled: number;
}

/**
 * The external (non-inapp) channels enabled for one user + event type. Merges
 * the user's saved rows over the DEFAULT_PREFERENCES fallback: a saved row
 * (enabled 0 or 1) always wins; for a channel with no saved row, fall back to
 * whether the default list includes it. In-app is dropped here — it's delivered
 * directly by notify(), never queued.
 */
function enabledExternalChannels(
	userId: number,
	eventType: string
): Exclude<NotificationChannelId, 'inapp'>[] {
	let rows: PreferenceRow[];
	try {
		rows = db
			.prepare(
				`SELECT channel, enabled
				   FROM notification_preferences
				  WHERE user_id = ? AND event_type = ?`
			)
			.all(userId, eventType) as unknown as PreferenceRow[];
	} catch (e) {
		log.error({ err: e, userId, eventType }, 'failed to read notification preferences');
		rows = [];
	}

	const saved = new Map<string, boolean>();
	for (const row of rows) saved.set(row.channel, row.enabled === 1);

	const defaults = new Set(DEFAULT_PREFERENCES[eventType] ?? []);

	const result: Exclude<NotificationChannelId, 'inapp'>[] = [];
	for (const channel of EXTERNAL_CHANNELS) {
		const enabled = saved.has(channel) ? saved.get(channel)! : defaults.has(channel);
		// An admin-disabled channel never delivers, regardless of the user's own
		// routing preference or a still-present connection config — the same gate
		// requireFeature enforces on the config/test routes, applied to delivery.
		if (enabled && isFeatureEnabled(`notify_${channel}`, userId)) result.push(channel);
	}
	return result;
}

interface AdminRow {
	id: number;
}

/** Every enabled admin user id (is_admin = 1, not disabled). */
function adminUserIds(): number[] {
	try {
		const rows = db
			.prepare('SELECT id FROM users WHERE is_admin = 1 AND disabled = 0')
			.all() as unknown as AdminRow[];
		return rows.map((r) => r.id);
	} catch (e) {
		log.error({ err: e }, 'failed to list admin users');
		return [];
	}
}

/**
 * Expand a payload into concrete (userId, channel) delivery targets:
 *  - payload.userId set: that one user, times each of their enabled non-inapp
 *    channels for this event type (per notification_preferences, falling back
 *    to DEFAULT_PREFERENCES when the user has no row yet).
 *  - payload.userId null (admin/instance event): every admin user, same
 *    per-channel expansion.
 * A (user, channel) target is only emitted when the channel plugin reports
 * isConfigured(userId) === true — no point queueing a delivery to a channel the
 * user has enabled but not connected. Exported for the queue worker's dry-run
 * tooling and for tests — not part of the public API surface other units call.
 */
export function resolveRecipients(
	payload: NotificationPayload
): { userId: number; channel: NotificationChannelId }[] {
	const userIds = payload.userId === null ? adminUserIds() : [payload.userId];

	const targets: { userId: number; channel: NotificationChannelId }[] = [];
	for (const userId of userIds) {
		for (const channel of enabledExternalChannels(userId, payload.type)) {
			const plugin = CHANNELS[channel];
			let configured = false;
			try {
				configured = plugin.isConfigured(userId);
			} catch (e) {
				log.error({ err: e, userId, channel }, 'isConfigured() threw; skipping target');
				configured = false;
			}
			if (configured) targets.push({ userId, channel });
		}
	}
	return targets;
}

/**
 * Fire a notification. Best-effort and synchronous-feeling but never blocks the
 * caller on network I/O: writes the in-app event immediately (same guarantee as
 * recordActivity — never throws), then enqueues external-channel deliveries for
 * the queue worker to pick up. Mirrors recordActivity's "this must never break
 * the operation that triggered it" contract — it is called from financial
 * operation paths, so it wraps everything in try/catch and only logs on failure.
 */
export function notify(payload: NotificationPayload): void {
	// Each stage is independently guarded so a failure in one never suppresses the
	// others. Previously a single outer try/catch meant a DB hiccup while
	// enqueueing external channels silently dropped ALL external delivery even
	// though the in-app record had already succeeded (cairn-s0p5).

	// 1. In-app is always-on and instant — it IS the activity feed.
	try {
		recordActivity({
			type: payload.type,
			message: payload.title + (payload.body ? ` — ${payload.body}` : ''),
			level: payload.level,
			userId: payload.userId,
			detail: payload.detail ?? null
		});
	} catch (e) {
		log.error({ err: e, type: payload.type }, 'notify() in-app record failed');
	}

	// Live-push nudge for the in-app bell: the SSE stream endpoint subscribes
	// to this and forwards a "your unread count may have changed" event to the
	// connected user. Best-effort — emit failures must never break notify().
	try {
		notifyBus.emit('event', { userId: payload.userId });
	} catch (e) {
		log.error({ err: e, type: payload.type }, 'notifyBus emit failed');
	}

	// 2. Resolve which users + external channels apply, then enqueue. The
	//    queued payload is a serialized NotificationPayload and by contract
	//    carries NO secrets; channel credentials are looked up fresh inside
	//    plugin.send(), never embedded in the queue row. Each recipient is
	//    enqueued independently so one bad row can't drop the rest.
	try {
		const serialized = JSON.stringify(payload);
		const insert = db.prepare(
			`INSERT INTO notification_queue (user_id, channel, event_type, payload)
			 VALUES (?, ?, ?, ?)`
		);
		for (const { userId, channel } of resolveRecipients(payload)) {
			try {
				insert.run(userId, channel, payload.type, serialized);
			} catch (e) {
				log.error(
					{ err: e, type: payload.type, channel, recipientId: userId },
					'notify() external-channel enqueue failed for one recipient'
				);
			}
		}
	} catch (e) {
		log.error({ err: e, type: payload.type }, 'notify() external enqueue failed');
	}
}
