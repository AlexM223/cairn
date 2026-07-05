// src/lib/server/notifyTypes.ts
//
// Framework-free types and constants for the notification system — plain types
// and arrays, importable from both server code and channel plugins without
// pulling in db.ts, logger.ts, or anything with side effects. This module is
// the shared vocabulary (§1.1 of docs/NOTIFICATION-PLAN.md); it must stay
// import-free of anything stateful so a channel plugin can depend on it freely.

/** Every event this feature can raise. Keep this list and the DB CHECK-free
 *  `type` column in sync by convention (SQLite has no enum type — this array
 *  IS the source of truth; the queue/preferences tables just store the string). */
export const NOTIFICATION_EVENT_TYPES = [
	'tx_received', // inbound tx first seen for a watched address
	'tx_confirmed', // a tx crossed a confirmation threshold (1/3/6, configurable)
	'tx_large', // an inbound OR outbound tx exceeded the user's configured sats threshold
	'key_health_due', // a multisig key hasn't been verified in ~180 days (mirrors existing key_health nudge)
	'backup_missing', // wallet/multisig created with no descriptor/Caravan backup ever downloaded
	'backup_stale', // an instance backup exists but is older than the reminder interval
	'sign_session_waiting', // a multisig transaction is awaiting_signature and has sat for a while
	'admin_new_signup', // a new user account was created
	'admin_invite_used', // an invite code was redeemed
	'admin_server_health', // node connection down, Electrum reconnect looping, disk space, etc.
	'security_failed_login', // N failed login attempts against one account (ties into rateLimit.ts)
	'security_new_passkey' // a new passkey (or recovery credential) was added to an account
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

/** UI tone — same vocabulary as ActivityLevel in activity.ts, deliberately. */
export type NotificationLevel = 'info' | 'success' | 'warn' | 'error';

export const NOTIFICATION_CHANNELS = [
	'inapp',
	'email',
	'telegram',
	'ntfy',
	'nostr',
	'webhook'
] as const;
export type NotificationChannelId = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * The one payload shape every channel plugin and the dispatcher agree on.
 * `userId: null` means an instance-wide/admin-broadcast event (fans out to
 * every admin's enabled channels — see notify() in notifications.ts).
 */
export interface NotificationPayload {
	type: NotificationEventType;
	userId: number | null;
	level: NotificationLevel;
	/** Short, e.g. "Payment received" — used as email subject / push title. */
	title: string;
	/** One or two sentences, plain language, no jargon without explanation
	 *  (matches Term.svelte's tooltip copy elsewhere in the app). */
	body: string;
	/** Structured, NON-SECRET fields for channels that want to template
	 *  further (amount, txid, height, deviceName, ...). Never a PSBT, xprv,
	 *  session token, password, or recovery phrase/code — same rule as
	 *  activity.ts's `detail`. */
	detail?: Record<string, unknown>;
	/** Relative in-app path to deep-link to, e.g. "/wallets/3" or "/admin/users". */
	link?: string;
}

/** What a channel plugin returns after attempting a send. */
export interface ChannelSendResult {
	ok: boolean;
	/** Present when ok=false; shown in the admin/user "last error" UI. */
	error?: string;
	/** false = don't retry (bad config, 4xx from the provider) — mark 'failed' and stop.
	 *  true = transient (network timeout, 5xx) — eligible for the queue's retry/backoff. */
	retryable?: boolean;
}

/**
 * Every channel module (Units 3-7) exports exactly this shape as its default
 * export. The dispatcher (Unit 1) and the settings/admin UIs (Units 9-10)
 * program against this interface only — never a channel's internals.
 */
export interface NotificationChannelPlugin {
	id: NotificationChannelId;
	/** Human name for UI, e.g. "Email", "Telegram". */
	label: string;
	/** Send one notification to one user. Reads the user's own config for this
	 *  channel from the DB internally (see each channel's table below) —
	 *  callers never pass credentials in. */
	send(userId: number, payload: NotificationPayload): Promise<ChannelSendResult>;
	/** "Send test notification" button in Settings — a canned payload, same
	 *  send path as the real thing, so a green result means it truly works. */
	test(userId: number): Promise<ChannelSendResult>;
	/** Does this user have enough config saved to attempt a send right now?
	 *  Pure DB read, no network call — used to grey out the channel toggle in
	 *  Settings before the user has filled anything in. */
	isConfigured(userId: number): boolean;
}
