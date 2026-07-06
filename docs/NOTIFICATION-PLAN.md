# Cairn Notification System — Implementation Plan

Status: **planning document**, not yet built. Written for parallel execution: 10
independent subagents, each owning one section below. This doc is the contract
between them — if you're building unit N, you should be able to read your
section plus "Shared Contracts" and start coding without asking anyone a
question. Cross-unit assumptions are the #1 risk in parallel work, so the
contracts section is deliberately over-specified. Don't deviate from it without
updating this file for everyone else.

## 0. What already exists (read this before building anything)

Cairn already has a user-facing **activity feed** — do not build a parallel
system next to it. Extend it.

- **`events` table** (`src/lib/server/db.ts`): `id, user_id (nullable = instance-wide), type, level ('info'|'success'|'warn'|'error'), message, detail (JSON text), created_at`. Pruned to the newest 500 rows per user (and per the instance-wide bucket).
- **`src/lib/server/activity.ts`**: `recordActivity({ type, message, level?, userId?, detail? })` — best-effort (catches its own errors, logs, never throws), inserts into `events`, prunes. `listActivity(userId, limit)` reads a user's feed (their rows + instance-wide rows, newest first). This is the existing **in-app channel's write path** — Unit 1 extends it, does not replace it.
- **`src/lib/server/logger.ts`**: `logger` (base pino instance) and `childLogger(tag)`. Structured JSON to stdout + a rotating local file the admin log viewer reads. **Never use `console.*`** anywhere in this feature — every module below gets its own `childLogger('notify:<channel>')`.
- **`src/lib/server/settings.ts`**: instance-wide config lives in a flat `settings` key-value table (`getSetting(key)`, `setSetting(key, value)`, and a typed `getInstanceSettings()`/`getPublicInstanceSettings()` pair that assembles/redacts a typed object from the raw rows). New instance-wide notification config (SMTP host, Telegram bot token, etc.) follows this **exact same pattern** — do not create a new settings table.
- **`src/lib/server/api.ts`**: `requireUser(event)` (401 if not logged in), `requireAdmin(event)` (403 if not admin), `readJson<T>(event)` (400 on malformed body). Every new API route uses these.
- **SSE precedent** (`src/routes/api/events/+server.ts` + `src/lib/liveBlocks.ts`): the existing pattern for pushing live data to the browser without polling — a `ReadableStream` that subscribes to a server-side `EventEmitter`, forwards events as `event: <name>\ndata: <json>\n\n`, sends a heartbeat comment every 25s, and cleans up listeners on both `cancel()` and the request's abort signal. The in-app bell (Unit 2) reuses this exact shape for a live unread-count push instead of polling.
- **`ElectrumClient`** (`src/lib/server/electrum/client.ts`) extends `EventEmitter`. It already emits `'header'` (new block tip) and `'scripthash'` (a subscribed address's status changed) — and already has `subscribeScripthash(scripthash): Promise<string | null>`. **Nothing in the codebase calls `subscribeScripthash` today** — all wallet scanning is a stateless re-scan (`scanWallet`/`scanMultisig`). Unit 8 is the first consumer of live per-address subscriptions.
- **DB migration convention**: new tables go in their own `db.exec(...)` block with a comment explaining why; new columns on existing tables go in a guarded block (`PRAGMA table_info`, check column absence, `ALTER TABLE ... ADD COLUMN`). Never edit an already-shipped `CREATE TABLE` string — see the many examples in `db.ts`. Follow this exactly; a fresh install and an upgrading install must both end up correct.
- **Design tokens** (`src/app.css`): warm charcoal (`--bg: #1a1614`), copper accent (`--accent: #e8935a`), status colors `--success`/`--warning`/`--error` (+ `-muted` variants), radii `--radius-card` (8px) / `--radius-control` (6px) / `--radius-chip` (4px). Reuse `.card`, `.card-pad`, `.btn-primary`/`.btn-secondary`/`.btn-ghost`, `.badge-*`, `.field`/`.label`/`.input`, `.form-error` — do not invent parallel classes.
- **No third-party telemetry, ever.** Cairn's own words (`src/lib/server/logger.ts` header comment): "self-hosted and privacy-first... NO third-party telemetry here and there must never be." Every outbound channel in this feature (email, Telegram, ntfy, Nostr, webhook) is **opt-in per user**, sends only to servers/bots *the user themselves configured*, and is silent by default. This is a design constraint, not a suggestion — reviewers will check for it.

---

## 1. Shared contracts (read by every unit — the load-bearing part of this doc)

### 1.1 Event types

New file: **`src/lib/server/notifyTypes.ts`** (framework-free — plain types and
constants, importable from both server code and channel plugins without
pulling in `db.ts` or anything with side effects).

```ts
// src/lib/server/notifyTypes.ts

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
```

### 1.2 Database schema (Unit 1 ships this; everyone else reads/writes these exact tables)

Add to `src/lib/server/db.ts` in a new `db.exec(...)` block, following the
existing comment-block convention. Four new tables plus one guarded
`ALTER TABLE` on `events`:

```sql
-- In-app notification read-tracking. Additive to the EXISTING `events` table
-- (see activity.ts) rather than a parallel table — an in-app notification IS
-- an event; "notification" just means "also show it in the bell, and maybe
-- fan it out to external channels". NULL = unread. Guarded/idempotent like
-- every other migration in this file.
--   ALTER TABLE events ADD COLUMN read_at TEXT;
--   CREATE INDEX IF NOT EXISTS idx_events_user_unread ON events(user_id, read_at);

-- Per-user, per-event-type channel routing. A row's ABSENCE means "use the
-- default for this event type" (see DEFAULT_PREFERENCES in notifications.ts) —
-- rows only exist once a user has touched a toggle in Settings, so most users
-- have zero or a handful of rows, not one per event type.
CREATE TABLE IF NOT EXISTS notification_preferences (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	event_type TEXT NOT NULL,
	channel    TEXT NOT NULL,   -- one of NOTIFICATION_CHANNELS
	enabled    INTEGER NOT NULL DEFAULT 1,
	-- Per-event-type tunables that don't deserve their own column (confirmation
	-- threshold count, large-tx sats threshold). JSON, small, optional.
	config     TEXT,
	UNIQUE (user_id, event_type, channel)
);
CREATE INDEX IF NOT EXISTS idx_notification_prefs_user ON notification_preferences(user_id);

-- Per-user, per-channel CONNECTION config (as opposed to the routing rules
-- above). One row per (user, channel). `secret` holds anything sensitive for
-- that channel (bot chat id is not secret, but a webhook URL or ntfy access
-- token might embed one) — always the raw value, this table is never returned
-- to the client verbatim (see getPublicChannelConfig pattern in 1.3).
CREATE TABLE IF NOT EXISTS notification_channel_config (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	channel    TEXT NOT NULL,
	config     TEXT NOT NULL,   -- JSON blob, shape is per-channel (documented in each channel's section)
	verified_at TEXT,           -- last successful test() or real send; NULL = never confirmed working
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	UNIQUE (user_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_notification_channel_config_user ON notification_channel_config(user_id);

-- PGP public keys for the email channel's optional encryption. Separate table
-- (not a column on notification_channel_config) because a key is a distinct
-- lifecycle: uploaded once, fingerprint-verified, can be removed independent
-- of whether email notifications are even on.
CREATE TABLE IF NOT EXISTS user_pgp_keys (
	user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
	public_key  TEXT NOT NULL,   -- ASCII-armored public key block, as pasted/uploaded
	fingerprint TEXT NOT NULL,   -- computed at upload time, shown in Settings for the user to cross-check
	created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The outbound delivery queue for every NON-inapp channel (in-app delivery is
-- just the `events` row itself — instant, no queue needed). One row per
-- (payload, channel, user) attempt. Retry with backoff; dead after max attempts.
CREATE TABLE IF NOT EXISTS notification_queue (
	id           INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	channel      TEXT NOT NULL,
	event_type   TEXT NOT NULL,
	payload      TEXT NOT NULL,               -- JSON-serialized NotificationPayload
	status       TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'sent' | 'failed' | 'dead'
	attempts     INTEGER NOT NULL DEFAULT 0,
	last_error   TEXT,
	next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	sent_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_notification_queue_pending
	ON notification_queue(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_notification_queue_user ON notification_queue(user_id, id DESC);
```

Instance-wide admin config (SMTP host/port/user/pass/from-address, Telegram
bot token, default ntfy server, default Nostr relays) goes in the **existing**
`settings` table via `getSetting`/`setSetting`, following the exact naming
convention already used (`electrum_host`, `core_rpc_pass`, etc.):
`smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`, `smtp_from`, `smtp_tls`,
`telegram_bot_token`, `ntfy_default_server`, `nostr_default_relays` (JSON
array, stored as text). Extend `InstanceSettings` in `src/lib/types.ts` and
`getInstanceSettings()`/`getPublicInstanceSettings()` in `settings.ts` the same
way `coreRpcPass` is handled today (`getPublicInstanceSettings` must redact
`smtp_pass` and `telegram_bot_token` to a boolean `hasSmtpPass`/`hasTelegramBotToken`
— copy the existing `hasCoreRpcPass` pattern exactly; this is a place a past
version of this codebase got wrong once already, see the closed bug about the
Core RPC password round-tripping to the client in plaintext — do not repeat it).

### 1.3 Core dispatcher (Unit 1 builds this file; everyone else calls into it or is called from it)

New file: **`src/lib/server/notifications.ts`**

```ts
// src/lib/server/notifications.ts
import { db } from './db';
import { recordActivity } from './activity';
import { childLogger } from './logger';
import type { NotificationPayload, NotificationChannelId } from './notifyTypes';

const log = childLogger('notify');

/**
 * Fire a notification. Best-effort and synchronous-feeling but never blocks
 * the caller on network I/O: writes the in-app event immediately (same
 * guarantee as recordActivity — never throws), then enqueues external-channel
 * deliveries for the queue worker to pick up. Mirrors recordActivity's
 * "this must never break the operation that triggered it" contract.
 */
export function notify(payload: NotificationPayload): void {
	try {
		// 1. In-app is always-on and instant — it IS the activity feed.
		recordActivity({
			type: payload.type,
			message: payload.title + (payload.body ? ` — ${payload.body}` : ''),
			level: payload.level,
			userId: payload.userId,
			detail: payload.detail ?? null
		});

		// 2. Resolve which users + external channels apply, then enqueue.
		for (const { userId, channel } of resolveRecipients(payload)) {
			db.prepare(
				`INSERT INTO notification_queue (user_id, channel, event_type, payload)
				 VALUES (?, ?, ?, ?)`
			).run(userId, channel, payload.type, JSON.stringify(payload));
		}
	} catch (e) {
		log.error({ err: e, type: payload.type }, 'notify() failed');
	}
}

/**
 * Expand a payload into concrete (userId, channel) delivery targets:
 *  - payload.userId set: that one user, times each of their enabled
 *    non-inapp channels for this event type (per notification_preferences,
 *    falling back to DEFAULT_PREFERENCES when the user has no row yet).
 *  - payload.userId null (admin/instance event): every admin user, same
 *    per-channel expansion.
 * Exported for the queue worker's dry-run tooling and for tests — not part of
 * the public API surface other units should call directly.
 */
export function resolveRecipients(
	payload: NotificationPayload
): { userId: number; channel: NotificationChannelId }[] {
	/* ... implementation detail, Unit 1's to fill in ... */
	return [];
}

/** Fallback routing when a user has never touched Settings > Notifications.
 *  Conservative: security events on by default (email if configured, always
 *  in-app), everything else opt-in. Exported so the Settings UI (Unit 9) can
 *  show "(default)" next to untouched toggles instead of guessing. */
export const DEFAULT_PREFERENCES: Record<string, NotificationChannelId[]> = {
	tx_received: ['inapp'],
	tx_confirmed: ['inapp'],
	tx_large: ['inapp'],
	key_health_due: ['inapp'],
	backup_missing: ['inapp'],
	backup_stale: ['inapp'],
	sign_session_waiting: ['inapp'],
	admin_new_signup: ['inapp'],
	admin_invite_used: ['inapp'],
	admin_server_health: ['inapp'],
	security_failed_login: ['inapp'],
	security_new_passkey: ['inapp']
};
```

**Channel plugin registry** — also in `notifications.ts`, a plain object built
from static imports of each channel module (no dynamic plugin discovery; there
are exactly 6 channels and they're all known at build time):

```ts
import emailChannel from './channels/email';
import telegramChannel from './channels/telegram';
import ntfyChannel from './channels/ntfy';
import nostrChannel from './channels/nostr';
import webhookChannel from './channels/webhook';

export const CHANNELS: Record<Exclude<NotificationChannelId, 'inapp'>, NotificationChannelPlugin> = {
	email: emailChannel,
	telegram: telegramChannel,
	ntfy: ntfyChannel,
	nostr: nostrChannel,
	webhook: webhookChannel
};
```

**This registry object is the one place Units 3-7 need to be added to.** Each
channel unit's PR/commit adds exactly one import + one registry entry here;
everything else about their channel is self-contained in their own file. This
is the only line of contention between the 5 channel units — call it out in
review, it's a 2-line diff each and trivially mergeable in any order.

### 1.4 Queue worker (Unit 1 builds this too — it's part of the core service, not a separate unit)

New file: **`src/lib/server/notificationQueue.ts`**, started once from
`src/hooks.server.ts` next to the existing `bootstrapAdminFromEnv()` call:

```ts
// in hooks.server.ts, alongside the existing bootstrap call
import { startNotificationQueueWorker } from '$lib/server/notificationQueue';
startNotificationQueueWorker();
```

Worker shape: a `setInterval` (every 5s; `.unref()` it like the SSE
heartbeat does, so it never keeps the process alive on its own), each tick:

1. `SELECT * FROM notification_queue WHERE status = 'pending' AND next_attempt_at <= now ORDER BY id ASC LIMIT 20`
2. Group by channel, respect a per-channel rate limit (simple in-memory token
   bucket, e.g. Telegram's Bot API hard-caps ~30 msg/sec — cap at a fraction
   of that; the other channels are far looser, but rate-limit all of them
   uniformly at ~5/sec per channel to be a good citizen of whatever server the
   user pointed us at).
3. For each row: look up the channel plugin from `CHANNELS`, call
   `plugin.send(row.user_id, JSON.parse(row.payload))`.
4. On `{ok: true}`: `UPDATE ... SET status='sent', sent_at=now`.
5. On `{ok: false, retryable: false}`: `UPDATE ... SET status='failed', last_error=...`
   — no retry, this needs the user to fix their config.
6. On `{ok: false, retryable: true}`: increment `attempts`; if
   `attempts >= 5`, `status='dead'`; else `next_attempt_at = now + backoff(attempts)`
   with exponential backoff (30s, 2m, 10m, 30m, 2h) and stay `pending`.
7. Every outcome gets a `childLogger('notify:queue')` line — this is exactly
   the kind of delivery failure an operator needs visible in the log viewer.

No secrets in `notification_queue.payload` — it's a serialized
`NotificationPayload`, which by contract (1.1) never carries them. Channel
credentials are looked up fresh from `notification_channel_config` inside
`plugin.send()`, not embedded in the queued payload.

---

## 2. Channels

Each channel is one file: `src/lib/server/channels/<name>.ts`, default-exports
a `NotificationChannelPlugin` (1.1), and is fully self-contained — it may
import from `db.ts`, `notifyTypes.ts`, `logger.ts`, and `settings.ts`, but
never from another channel or from `notifications.ts` (that would create a
cycle back into the registry). Each channel also gets a
`src/lib/server/channels/<name>.test.ts` covering at minimum: config
validation, a successful send (mocked transport), a retryable failure, and a
non-retryable failure.

### 2.1 In-app (baseline — Unit 2)

Not a queue consumer; it's the direct `recordActivity()` write `notify()`
already does (1.3). Unit 2's job is entirely UI + one small API surface:

- **Bell icon + unread count**: add to the sidebar in
  `src/routes/(app)/+layout.svelte` (next to the existing user chip at the
  bottom, or in the header — match the existing nav's spacing/icon size, see
  `Icon.svelte` usage elsewhere in that file). Badge count = unread `events`
  rows for the current user (`user_id = ? OR user_id IS NULL` AND
  `read_at IS NULL`).
- **New API route** `src/routes/api/notifications/+server.ts`:
  `GET` → list (reuse `listActivity` from `activity.ts`, extend its return
  type with `readAt: string | null`), `PATCH` body `{ ids: number[] }` or
  `{ all: true }` → sets `read_at = now` for the caller's own events
  (`WHERE id IN (...) AND (user_id = ? OR user_id IS NULL)` — an
  instance-wide event marked read by one user should NOT appear read for
  everyone else, so "read" is actually **per-user**, which the `events` table
  as designed cannot represent for `user_id IS NULL` rows with a single
  `read_at` column. **Resolve this**: add a small
  `notification_read_receipts (user_id, event_id, read_at)` table instead of
  reusing `events.read_at` directly for instance-wide rows, OR simplify the
  product requirement to "instance-wide events are always shown as read after
  the first user who's seen the list views it" (acceptable, matches how the
  existing `/activity` page already treats instance-wide events as just
  another row with no per-user state). **Decision for Unit 2 to make and
  document in its own commit message**: the second option is simpler and
  consistent with existing `/activity` behavior — recommended default absent
  a strong reason to build the receipts table.
- **Live push** (optional but recommended, matches the existing SSE
  precedent): extend `src/routes/api/events/+server.ts`'s stream with a
  second event type (`event: notification`) fired whenever `notify()` inserts
  a row for the connected user, OR — simpler, avoids coupling the block-tip
  SSE endpoint to notifications — add a **new** endpoint
  `src/routes/api/notifications/stream/+server.ts` following the exact same
  `ReadableStream` + heartbeat + cleanup-on-abort shape as
  `src/routes/api/events/+server.ts`, subscribed to an in-process
  `EventEmitter` that `recordActivity`/`notify` emits on. New file:
  `src/lib/server/notifyBus.ts` exporting a single
  `export const notifyBus = new EventEmitter()` that `notify()` (1.3) calls
  `notifyBus.emit('event', { userId, ...})` on after the DB insert, and this
  new stream endpoint subscribes to. If this feels like scope creep for Unit
  2, polling the count every 30s from the client is an acceptable v1 fallback
  — note which one you built in the commit message so Unit 9 (Settings UI)
  knows whether to wire a live badge or a polled one.
- **Notification panel**: a dropdown/panel triggered by the bell (new
  component `src/lib/components/NotificationPanel.svelte`), listing recent
  events with the same level-based icon/color treatment `/activity` already
  uses (reuse that page's row-rendering approach rather than inventing new
  markup), each row linking to `payload.link` when present, a "Mark all
  read" action, and a link to the full `/activity` page for history beyond
  what fits in the panel.
- **Testing**: manually create a few `notify()` calls in a scratch script or
  via existing triggers (e.g. sign in with a wrong password a few times to
  fire a security event once Unit 8 wires it up); confirm the badge count and
  panel update.

### 2.2 Email (SMTP + optional PGP) — Unit 3

**Packages**: `nodemailer` (SMTP client — the standard, well-maintained
choice; avoid anything requiring a native addon, matching this project's
existing "no native deps beyond what's already unavoidable" posture) and
`openpgp` (openpgp.js, pure JS, for the optional encryption layer). Add both
to `package.json` dependencies.

**User config** (Settings → Notifications → Email), stored in
`notification_channel_config` with `channel = 'email'`,
`config = JSON.stringify({ address: string })` — defaults to the user's
account email (`users.email`) but let them override it (some people want
notifications at a different address than their login email). PGP key upload
is its own table (1.2, `user_pgp_keys`), not part of this JSON blob.

**Admin config** (Admin → Settings → Notifications), stored in the shared
`settings` table per 1.2: `smtp_host`, `smtp_port` (default 587),
`smtp_user`, `smtp_pass`, `smtp_from` (the From: address), `smtp_tls`
(`'starttls' | 'tls' | 'none'`). One SMTP relay for the whole instance — this
is infrastructure, not a per-user thing, exactly like the existing Electrum/
Esplora instance-wide config.

**Protocol**: nodemailer `createTransport({ host, port, secure, auth })`,
`sendMail({ from, to, subject: payload.title, text: payload.body, html?, headers })`.
If the user has a `user_pgp_keys` row, encrypt the body via `openpgp.encrypt()`
with their public key before handing it to nodemailer, and send as
`Content-Type: application/pgp-encrypted` per RFC 3156 (or, simpler v1: just
PGP-encrypt the plaintext body inline and note in the email itself that it's
PGP-armored — full RFC 3156 MIME structure is a nice-to-have, not a blocker
for v1). Never encrypt the subject line (PGP/MIME doesn't support that
without leaking metadata anyway; keep subjects generic, e.g. "Cairn
notification" when a PGP key is on file, so subject-line snooping on the mail
server doesn't leak "Large payment received").

**Error handling**: SMTP auth failures / bad host → `retryable: false` (config
problem, needs the admin to fix instance settings — surface in both the
per-send `last_error` AND a `admin_server_health`-type notification back to
admins, careful not to create an infinite loop if email itself is broken —
route that specific meta-alert through a different channel or just the log).
Connection timeouts / 4xx-that-look-transient → `retryable: true`.

**Testing**: `test(userId)` sends a real email via the configured SMTP relay
with a canned "Test notification from Cairn" body to the user's configured
address. Settings UI shows the `ChannelSendResult` inline. For local dev
without a real SMTP server, document (in this channel's own file header
comment) that `smtp_host=localhost, smtp_port=1025` works with a local
Mailhog/maildev container as a manual testing aid — not a project dependency,
just a documented convenience.

### 2.3 Telegram (Bot API) — Unit 4

**Packages**: none required — Telegram's Bot API is plain HTTPS + JSON;
use the platform `fetch`, same as `src/routes/api/price/+server.ts` already
does for its external call. Do not add a Telegram SDK dependency for this.

**User config**: `notification_channel_config` channel `'telegram'`,
`config = JSON.stringify({ chatId: string })`. Getting a `chatId` is a
manual, documented step for the user (message their own bot, or a helper bot,
to learn their numeric chat id, OR — nicer UX — Cairn's Settings page shows a
deep link `https://t.me/<bot_username>?start=<one-time-code>` the user taps,
and a small polling/webhook receiver captures the resulting `chatId` and
associates it via the one-time code). **v1 scope decision**: ship the manual
chat-id-paste version first (simplest, zero extra surface area); the
`/start` deep-link flow is a good v1.1 follow-up, note it as such rather than
building it now.

**Admin config**: `settings` key `telegram_bot_token` (the bot's API token
from @BotFather — one bot for the whole instance, users each just supply
their own chat id).

**Protocol**: `POST https://api.telegram.org/bot<token>/sendMessage` with
JSON body `{ chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }`.
Escape `payload.title`/`payload.body` for Telegram's HTML subset (escape
`<`, `>`, `&`; Telegram supports a small tag allowlist — keep formatting to
`<b>`/plain text, don't get fancy). If `payload.link` is set, append it as
plain text (Telegram auto-links URLs) rather than trying to build an inline
keyboard — simpler and enough for v1.

**Error handling**: Telegram returns `{ ok: false, error_code, description }`
on failure. `error_code === 401` (bad bot token) or `403` (user blocked the
bot / never started a chat with it) → `retryable: false`. `429` (rate
limited) → `retryable: true`, and respect the `retry_after` field in the
response body if present (feed it into the queue's `next_attempt_at`
directly rather than the generic backoff schedule). 5xx → `retryable: true`.

**Testing**: `test(userId)` sends "✅ Cairn is connected to Telegram." to the
stored chat id. A `403` on test is the single most common real-world failure
(user hasn't pressed Start on the bot yet) — surface that specific case with
a friendly message in the UI ("Message your bot first, then try again"), not
a raw API error dump.

### 2.4 ntfy (self-hosted push) — Unit 5

**Packages**: none — plain HTTP POST via `fetch`, same posture as Telegram.

**User config**: `notification_channel_config` channel `'ntfy'`,
`config = JSON.stringify({ server: string, topic: string, accessToken?: string })`.
`server` defaults to the admin's configured default (`settings` key
`ntfy_default_server`, singular — one URL, not a list, per §1.2)
but the user can override to point at any ntfy server including
`https://ntfy.sh` itself. `topic` is a user-chosen string (ntfy topics are
just URL path segments — no registration step, which is ntfy's whole
appeal). `accessToken` is optional, for a topic protected with ntfy's
access-control feature.

**Admin config**: `settings` key `ntfy_default_server` (e.g.
`https://ntfy.sh` or the operator's own self-hosted ntfy instance) —
purely a UI convenience default, never mandatory since ntfy is inherently
decentralized/self-hostable per-user.

**Protocol**: `POST <server>/<topic>` with a plain-text body (the simplest
ntfy publish form) or JSON body for richer control — use the JSON form:
`POST <server>` with body
`{ topic, title: payload.title, message: payload.body, priority, tags, click: payload.link }`.
Map `payload.level` to ntfy's `priority` (1-5): `error` → 5 (max), `warn` →
4, `info`/`success` → 3 (default). Set header
`Authorization: Bearer <accessToken>` when present.

**Error handling**: non-2xx with no body or a 4xx → `retryable: false` for
`401`/`403` (bad token/topic ACL), `retryable: true` for everything else
(the user's own self-hosted ntfy instance being briefly unreachable is exactly
the transient case retries exist for).

**Testing**: `test(userId)` publishes "Cairn test notification" to the
configured topic/server; a 200 means it worked (ntfy doesn't require the
subscriber to be online to accept a publish, so "sent successfully" is the
right signal here, not "delivered to a device").

### 2.5 Nostr (encrypted DMs, NIP-04/NIP-44) — Unit 6

**Packages**: `nostr-tools` (the standard, widely-used JS Nostr toolkit —
covers event signing, NIP-04 and NIP-44 encryption helpers, and a simple
relay pool/publish helper). Avoid rolling your own crypto for this; use the
library's `nip44`/`nip04` modules directly.

**User config**: `notification_channel_config` channel `'nostr'`,
`config = JSON.stringify({ recipientPubkey: string, relays?: string[] })`.
`recipientPubkey` is the user's own npub/hex pubkey (they receive the DM —
Cairn is the sender). `relays` optional per-user override; falls back to the
instance default.

**A private key for Cairn to sign/send FROM is required** — this is the one
channel needing a service-side identity. Store it instance-wide (not
per-user): `settings` key `nostr_sender_privkey` (hex, generated
automatically on first use if absent — `nostr-tools`' `generateSecretKey()`
— and never shown/exported in the UI beyond a "regenerate identity" danger-
zone action, exactly like the account-recovery secrets are handled: this key
never needs to leave the server, and there is no legitimate reason to export
it). `nostr_default_relays`: instance-wide JSON array of relay URLs (a
sensible built-in default list of 2-3 well-known public relays, overridable).

**Protocol**: build a `kind: 4` (NIP-04) or `kind: 14`-wrapped (NIP-44,
preferred — NIP-04 is legacy/deprecated in the spec but far more widely
supported by wallets today; **ship NIP-44 with a NIP-04 fallback if the
recipient's client support is unknown**, or simplest for v1: just implement
NIP-44 only and document NIP-04 as a fast-follow if real-world testing shows
recipients aren't seeing DMs) encrypted direct message from the instance's
Nostr identity to `recipientPubkey`, containing `payload.title` +
`payload.body` (+ link as plain text), then publish it to each configured
relay via a plain WebSocket (`nostr-tools`' relay pool handles this).

**Error handling**: a relay refusing/erroring is per-relay — treat the whole
send as `ok: true` if AT LEAST ONE relay accepted the event (Nostr's whole
model is redundant publish-to-many; failing because one of three relays was
down would be wrong). Only `ok: false` when EVERY configured relay rejected
or was unreachable, `retryable: true` in that case (relays flapping is
common and transient).

**Testing**: `test(userId)` sends a real encrypted DM with a canned message;
since there's no server-side way to confirm the recipient actually saw it
(that's the point of Nostr), success here means "published to at least one
relay," and the UI copy should say exactly that rather than implying
delivery confirmation.

### 2.6 Webhook (generic HTTP POST) — Unit 7

**Packages**: none — plain `fetch`.

**User config**: `notification_channel_config` channel `'webhook'`,
`config = JSON.stringify({ url: string, secret?: string })`. `secret`
optional, used for HMAC request signing (see below) so the receiving
endpoint can verify the POST really came from this Cairn instance.

**Admin config**: none needed — fully user-configured, no instance-wide
default makes sense for an arbitrary receiving URL.

**Protocol**: `POST <url>` with JSON body:

```json
{
	"type": "tx_received",
	"level": "info",
	"title": "Payment received",
	"body": "0.015 BTC received to Savings",
	"detail": { "amountSats": 1500000, "walletId": 3 },
	"link": "/wallets/3",
	"timestamp": "2026-07-05T12:00:00.000Z"
}
```

If `secret` is set, add header `X-Cairn-Signature: sha256=<hex hmac>` where
the HMAC is computed over the raw JSON body bytes with `secret` as the key
(`node:crypto` `createHmac('sha256', secret)`) — document this exact scheme
in the channel's file header so a user's receiving endpoint can implement
verification without guessing (this is the same pattern GitHub/Stripe
webhooks use; don't invent a new one). **Server-Side Request Forgery
guard**: since `url` is user-supplied and this runs server-side, validate it
at save time (Settings UI, Unit 9) and again at send time — reject
non-http(s) schemes, and reject resolution to a private/loopback/link-local
IP range (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16,
::1, fc00::/7) **unless** an explicit admin-only escape hatch is enabled
(instance setting `webhook_allow_private_targets`, off by default) for
self-hosters who legitimately want to hit another service on their own LAN.
This is the one channel with real SSRF risk and needs this check called out
explicitly in review.

**Error handling**: any non-2xx response → `retryable: true` up to the
standard 5 attempts (webhook receivers are often flaky personal scripts;
give them the benefit of the doubt), except the SSRF-guard rejection itself,
which is `retryable: false` (no amount of retrying fixes a URL pointed at
`127.0.0.1`).

**Testing**: `test(userId)` POSTs the same JSON shape with
`"type": "test"` and a canned title/body; report the HTTP status code back
to the UI verbatim so the user can debug their own receiving endpoint.

---

## 3. Event hooks — where each trigger actually fires

Unit 8's job: call `notify()` (1.3) from these exact locations. Each hook is
a small, additive change to existing code — none of these require
refactoring the systems they hook into.

| Event | Hook point | Notes |
|---|---|---|
| `tx_received` | **New**: a per-wallet-address Electrum subscription. `subscribeScripthash()` already exists on `ElectrumClient` (`src/lib/server/electrum/client.ts`) but nothing calls it today. Build a small new module `src/lib/server/addressWatcher.ts` that, on startup and whenever a wallet/multisig is created, calls `subscribeScripthash` for every address in that wallet's current gap-limit window (reuse `walletScan.ts`'s address-derivation helpers) and listens for the `'scripthash'` event; on a status change, re-fetch that address's history via the existing Esplora client and diff against the last-known txid set (persist "last known txids per address" — reuse `balance_snapshots`' pattern of a small tracking table, or simplest: a `notified_txids (wallet_kind, wallet_id, txid)` table so a restart doesn't re-notify for old transactions already seen before this feature existed). This is the single largest piece of net-new plumbing in the whole plan — budget real time for it. |
| `tx_confirmed` | Same `addressWatcher.ts`, driven off the existing block-tip `'header'` event on `ElectrumClient` (already used by the SSE dashboard) rather than a new subscription: on every new block, re-check confirmation counts for any watched, not-yet-fully-confirmed txid against the user's configured thresholds (1/3/6, from `notification_preferences.config` for this event type, default `[1, 6]`). |
| `tx_large` | Same code path as `tx_received`/`tx_confirmed` — at the point a tx's value is known, compare `amountSats` against `notification_preferences.config.thresholdSats` for this user (default: none configured = never fires; this is opt-in only, per the task description "user-configurable threshold" with no sensible universal default). |
| `key_health_due` | `src/routes/(app)/wallets/multisig/_components/KeyHealthRow.svelte` / the underlying `last_verified_at` check already exists (`db.ts` — the Casa-style periodic verification). Add a lightweight daily check (a `setInterval` in the same style as the notification queue worker, or piggyback on the existing queue worker's tick if cheap) that scans `multisig_keys` for `last_verified_at IS NULL OR last_verified_at < now - 180 days` and fires one `notify()` per stale key, throttled to at most one nudge per key per 30 days (track `last_notified_at` — add this column to `multisig_keys`, guarded ALTER TABLE per convention). |
| `backup_missing` / `backup_stale` | Checked directly: `src/lib/server/backup.ts` (the whole-instance encrypted backup feature — `buildBackup`/`encryptBackup`/`decryptBackup`/`restoreBackup`) currently tracks **no timestamp of when a backup was last taken** — there is nothing to hook yet. This event requires adding that tracking as part of this unit's work: a `settings` key `last_instance_backup_at`, set whenever the existing Admin "Download backup" action actually completes (find that action — likely `src/routes/(app)/admin/**` wherever `buildBackup`/`encryptBackup` are currently called from a form action or API route — and add one `setSetting('last_instance_backup_at', now)` call there). `backup_missing` fires once if this key has never been set N days after instance creation (pick N=7); `backup_stale` fires on a rolling ~90-day cycle after the last recorded backup, per the task description. This is also separately planned in more depth under open beads cairn-m4e/cairn-lun6/cairn-iyj/cairn-dcp (mandatory backup UX, persistent staleness banner, restore entry point) — if that work lands first, coordinate rather than duplicate the timestamp tracking; if this unit lands first, the minimal version above is the seed the other work can build on. |
| `sign_session_waiting` | `src/lib/server/multisigTransactions.ts` (or wherever a multisig tx transitions to `status = 'awaiting_signature'`) — fire once on that transition, then a follow-up reminder if it's still `awaiting_signature` after e.g. 24h (same throttle pattern as key health). |
| `admin_new_signup` | `src/lib/server/auth.ts` — wherever `registerUser`/the register-verify flow inserts a new `users` row. `userId: null` (admin broadcast). |
| `admin_invite_used` | Wherever an invite's `used_count` increments (`src/lib/server/admin.ts` or `auth.ts`, whichever owns invite redemption). `userId: null`. |
| `admin_server_health` | `src/lib/server/electrum/client.ts`'s `'disconnect'`/reconnect-loop path, and/or `src/routes/api/health/+server.ts`'s existing DB-health check — fire when a reconnect loop exceeds N attempts, or the health endpoint would return 503. Debounce hard (this must not spam — one notification per outage, not one per retry). `userId: null`. |
| `security_failed_login` | `src/lib/server/rateLimit.ts` / `src/routes/api/auth/login/**` — fire when an account crosses a threshold of failed attempts within the existing rate-limit window (reuse the limiter's own counters rather than adding a second counting mechanism). Scope to the affected `userId` if the email matched a real account, else skip (no account to notify). |
| `security_new_passkey` | `src/lib/server/webauthn.ts` — wherever a new `user_credentials` row is inserted (both normal "add a passkey in Settings" and the account-recovery register-verify flow). Scope to that `userId` — this is a "was this you?" alert, valuable specifically because it should fire even via channels that don't require being logged in to see (email, Telegram) in case the passkey was added by an attacker with a stolen recovery phrase. |

---

## 4. Settings UI — Unit 9

New route: **`src/routes/(app)/settings/notifications/+page.svelte`** +
`+page.server.ts`, linked from the existing `src/routes/(app)/settings/+page.svelte`
(add a card/link there, matching how Profile/Password/Appearance are already
laid out as sections on that page — either fold this in as a new section on
the same page, or a sub-page linked from it; given the amount of UI here
(event×channel matrix + per-channel config forms), a **separate page** linked
from Settings is the better call, consistent with how Admin's sub-areas are
each their own route rather than one giant page).

**Layout**:

1. **Channel connections** section: one card per channel (Email, Telegram,
   ntfy, Nostr, Webhook — in-app has no config, it's just always on), each
   showing: configured/not-configured state, the relevant input fields (from
   each channel's "user config" shape in section 2), a "Test" button calling
   a new API route `POST /api/notifications/channels/[channel]/test` (which
   calls that channel's `plugin.test(userId)` and returns the
   `ChannelSendResult` for inline display — reuse the exact
   inline-success/error pattern already used by Admin Settings' "Test
   connection" for Electrum/Esplora, including learning from the bug that
   was found and fixed there: **do not set pending/loading state inside a
   button's own `onclick` handler** — set it inside `use:enhance`'s callback,
   or in this case (likely a plain `fetch` from a Svelte component rather
   than a form action, since this isn't a full-page form submission) inside
   the async function itself, which is safe; the bug was specific to
   `formaction`+`onclick` both trying to control submission).
2. **PGP key** sub-section under Email: paste/upload an ASCII-armored public
   key, show the computed fingerprint back for the user to verify against
   their own keyring, a "Remove" action.
3. **Event preferences** section: a matrix (event type rows × channel
   columns, checkboxes) OR — likely better UX given 12 event types × 6
   channels is a lot of checkboxes — grouped by category (Wallet activity /
   Security / Admin, admin-only rows hidden entirely for non-admin users)
   with a per-event-type expandable row showing per-channel toggles. Each
   event type row also shows its tunable config where relevant (large-tx
   threshold as a sats/BTC input, confirmation-count checkboxes for 1/3/6).
   Persist via `notification_preferences` (1.2) — a form action or a set of
   small `PATCH` calls to a new `src/routes/api/notifications/preferences/+server.ts`.
4. Empty/loading/error states throughout, per the project's standing
   checklist — a fresh account with nothing configured should read as "here's
   what you can turn on," not a wall of red "not configured" warnings.
5. Educational tooltips (reuse `Term.svelte`) on: what a webhook is, what
   ntfy is, what NIP-04/NIP-44 means, what PGP does here specifically ("this
   encrypts just the notification email body — it has nothing to do with
   your Bitcoin keys, which never leave your hardware wallet" — same
   disambiguation discipline the recovery-phrase feature already uses for
   "this is not your seed phrase").

---

## 5. Admin UI — Unit 10

New route: **`src/routes/(app)/admin/notifications/+page.svelte`** +
`+page.server.ts`, linked from the admin nav alongside Users/Invites/Settings
(`src/routes/(app)/admin/+layout.svelte`'s tab list).

**Layout**:

1. **SMTP configuration**: host/port/user/pass/from/TLS mode, a "Test
   connection" button (send a real test email to the admin's own address),
   following the exact existing Electrum/Esplora test-connection UI pattern
   in `src/routes/(app)/admin/settings/+page.svelte` (including its
   `hasSmtpPass`-style redaction — never echo the stored password back into
   the form, same fix already applied to `coreRpcPass`).
2. **Telegram bot token**: one instance-wide token field, redacted the same
   way, plus a short "how to get a bot token" pointer (BotFather) as
   educational copy, not a live link out unless the project's existing
   convention allows outbound doc links elsewhere (check `README.md`'s
   existing external links for precedent — it does link out to
   mempool.space docs etc., so this is fine).
3. **ntfy default server** / **Nostr default relays**: simple text
   input / textarea (one relay URL per line), instance-wide defaults only —
   these channels are otherwise fully user-self-configured.
4. **Webhook SSRF escape hatch**: the `webhook_allow_private_targets` toggle
   from section 2.6, defaulted off, with explicit warning copy about what
   turning it on means.
5. **Delivery health**: a small dashboard reading `notification_queue` —
   counts by status, most recent `failed`/`dead` rows with their
   `last_error`, so an admin can spot "Telegram has been failing for
   everyone for 2 hours" without grepping logs. This is the admin-facing
   payoff for the queue's structured status tracking — don't skip it, it's
   small to build and the single most useful piece of this page operationally.
6. Same admin-gating discipline as every other admin page: `requireAdmin` on
   every API route this page calls, `+layout.server.ts`'s existing
   `isAdmin` check covers the page itself for free (it's under `/admin`).

---

## 6. Subagent assignment summary

| # | Unit | Key files | Depends on (contract only, not code) |
|---|------|-----------|---------------------------------------|
| 1 | Core service, types, schema, queue worker | `notifyTypes.ts`, `notifications.ts`, `notificationQueue.ts`, `db.ts` migration, `hooks.server.ts` (one new line) | Nothing — this ships the contract everyone else reads |
| 2 | In-app channel (bell, panel, read state) | `+layout.svelte` (bell), `NotificationPanel.svelte`, `api/notifications/+server.ts`, optional `api/notifications/stream/+server.ts` + `notifyBus.ts` | §1.1, §1.2 (`events.read_at`) |
| 3 | Email + PGP | `channels/email.ts`, `user_pgp_keys` reads | §1.1 (plugin interface), §1.2 (`notification_channel_config`, `user_pgp_keys`, `settings` SMTP keys) |
| 4 | Telegram | `channels/telegram.ts` | §1.1, §1.2 (`settings.telegram_bot_token`) |
| 5 | ntfy | `channels/ntfy.ts` | §1.1, §1.2 |
| 6 | Nostr | `channels/nostr.ts` | §1.1, §1.2 (`settings.nostr_sender_privkey`, `nostr_default_relays`) |
| 7 | Webhook | `channels/webhook.ts` | §1.1, §1.2, the SSRF guard is this unit's own responsibility |
| 8 | Event hooks | `addressWatcher.ts` (new), small diffs across `auth.ts`, `webauthn.ts`, `electrum/client.ts` callers, `multisigTransactions.ts`, `rateLimit.ts` call sites | §1.1 (`notify()` signature only) — does NOT need any channel built to land, since `notify()` degrades gracefully with zero channels configured (in-app only) |
| 9 | Settings UI | `settings/notifications/+page.svelte` + server, `api/notifications/preferences/+server.ts`, `api/notifications/channels/[channel]/test/+server.ts` | §1.1, §1.2, and the `isConfigured`/`test` methods existing on each channel plugin (can stub against the interface before Units 3-7 land — TypeScript will hold the contract) |
| 10 | Admin UI | `admin/notifications/+page.svelte` + server | §1.2 (`settings` keys), reads `notification_queue` directly for the health dashboard |

**Build order note**: Units 2-10 can all start immediately by coding against
this document's contracts (§1.1-1.4) without waiting on Unit 1's actual PR to
merge — that's the entire point of over-specifying the interfaces up front.
The one real sequencing constraint: Unit 1's DB migration must land before
anyone's code can be *run* against a real database, so target Unit 1 for the
earliest merge even if others finish coding sooner. Units 9 and 10 will hit
TypeScript errors against a not-yet-real `CHANNELS` registry until Units 3-7
land — expected and fine; stub with `as unknown as NotificationChannelPlugin`
casts locally if needed to keep iterating on UI before every channel exists,
and remove the cast once the real registry compiles.
