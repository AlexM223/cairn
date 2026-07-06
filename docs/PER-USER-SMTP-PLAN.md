# Per-user SMTP for email notifications — scoping doc

Status: **planning document**, not yet built. Companion to
`docs/NOTIFICATION-PLAN.md` (the original notification system design) — read
that first if you haven't; this doc only covers the delta.

## 0. Problem and current state

Today (`src/lib/server/channels/email.ts`) there is exactly one SMTP relay for
the whole instance, configured by the admin (`/admin/notifications`, `settings`
table keys `smtp_host`/`smtp_port`/`smtp_user`/`smtp_pass`/`smtp_from`/`smtp_tls`).
Every user's email notifications go out through it. A user can only override
the *destination address* (`notification_channel_config` row, `channel='email'`,
`config.address`), not the relay itself.

This means: no admin SMTP configured → **no user** gets email, even if they'd
happily supply their own Gmail/Fastmail/etc. credentials. We want each user to
optionally bring their own SMTP, with the admin's instance SMTP as a fallback.

## 1. Design

**Priority per send, resolved per-recipient at send time:**
1. The recipient user's own SMTP config (if they've saved one), else
2. the admin's instance-wide SMTP config (if configured), else
3. email is unavailable for that user — `ChannelSendResult` comes back
   `{ ok: false, retryable: false }` with a clear message. Other channels
   (ntfy, Telegram, webhook, in-app) are untouched and keep working.

**Important simplification found while reading the code:** the queue
(`notificationQueue.ts`) already calls `plugin.send(row.user_id, payload)` —
every queued row is per-recipient already, including admin-broadcast events
(`notify()` fans a `userId: null` payload out to each admin's own queue row
before it ever reaches the queue table; see `resolveRecipients()` in
`notifications.ts`). So there is **no separate "system email" send path** to
build — "admin/system emails" in the feature request just means: an admin who
hasn't configured their own SMTP still gets `admin_new_signup`/`admin_invite_used`/
`admin_server_health` emails via the instance fallback, which falls straight out
of the uniform per-recipient priority rule above. **The queue itself needs zero
changes.** The resolution logic belongs entirely inside the email channel
plugin (`readSmtpConfig`), which is where the existing plugin-abstraction
boundary already puts it ("the dispatcher and UI program against this
interface only — never a channel's internals" — NOTIFICATION-PLAN.md §1.1).

**Schema:** no new table, no new columns. `notification_channel_config.config`
for `channel='email'` is already a schemaless JSON blob (currently
`{ address?: string }`). Extend it additively:

```ts
interface EmailChannelConfig {
	address?: string;
	smtp?: {
		host: string;
		port: number;
		user: string | null;
		from: string;
		tls: 'starttls' | 'tls' | 'none';
		passEnc: string | null; // encrypted envelope — see §2 — never plaintext
	};
}
```

Old rows (`{ address }` only, no `smtp` key) keep parsing and behaving exactly
as today — `smtp` absent means "no personal SMTP, fall back to instance." This
is why there's no destructive migration: the existing column already tolerates
new optional keys. The only genuinely new piece of state is the **instance
secret key** (§2), which needs first-boot generation.

## 2. Encryption at rest

New module: **`src/lib/server/secretKey.ts`**.

- On first use, generate 32 random bytes (`crypto.randomBytes(32)`) and persist
  them to a file **next to the DB, not inside it**:
  `path.join(path.dirname(DB_PATH), 'instance.key')` (mode `0600`). Deliberately
  outside the `settings` table / DB file: a leaked/exported `cairn.db` (backup,
  support screenshare, replicated copy) does not carry the key needed to decrypt
  SMTP passwords, whereas storing the key in the same DB would make encryption
  theatre against that exact threat.
- `getInstanceKey(): Buffer` — reads the file, generating+writing it once if
  absent (guard with an existence check, same idempotent-first-run pattern as
  the rest of the app's startup code, e.g. `auth.ts`'s admin bootstrap).
- `encryptSecret(plaintext: string): string` / `decryptSecret(envelope: string): string`
  — AES-256-GCM, key = HKDF-SHA256(instanceKey, salt=none, info=`'cairn:notification-smtp-pass'`)
  so this encryption's key is domain-separated from any future use of the same
  instance key. Envelope is a small JSON object, base64 fields, versioned like
  `backup.ts`'s envelope (`{ v: 1, iv, tag, data }`) so the format can evolve.
  No passphrase/KDF needed here (unlike `backup.ts`) — the instance key is
  already high-entropy, not human-derived.
- Docker/Umbrel note: the key file must live under the same persistent volume
  as `data/cairn.db` (check `CAIRN_DB`'s directory, not `process.cwd()`) or a
  container restart on ephemeral storage would silently orphan every saved
  password. Flag this explicitly in the bead — it's the one easy way to get
  this wrong.

**Scope note, not in this pass:** `ntfy.accessToken` and `webhook.secret` are
today stored *plaintext* in the same `notification_channel_config.config`
column, redacted only on the way out to the browser (see
`redactForClient()` in `src/routes/api/notifications/channels/[channel]/+server.ts`).
This change does not retrofit those — SMTP passwords are a materially bigger
target (real mailbox credentials, often reused) and the user asked for
encryption specifically here. Worth a follow-up bead later to bring ntfy/webhook
up to the same bar using the same `secretKey.ts` primitive, but keeping this
pass scoped to email only.

## 3. Email channel refactor (`src/lib/server/channels/email.ts`)

- `readSmtpConfig()` → `readSmtpConfig(userId: number)`. Reads the user's own
  `EmailChannelConfig.smtp` first (decrypting `passEnc` via `secretKey.ts`); if
  absent, falls back to today's instance-settings read. Returns the same
  `SmtpConfig | null` shape either way — `sendMail()`/`deliver()` don't care
  which source it came from.
- `isConfigured(userId)` / `send()` / `test()` already take `userId` — just
  thread it into the new `readSmtpConfig(userId)` instead of the old no-arg
  version. No interface change to `NotificationChannelPlugin`.
- Error message when neither is configured should distinguish the two "not
  configured" cases the current code already returns for missing-instance-SMTP
  vs. missing-destination-address, e.g.: `"No SMTP configured — set up your own
  in Settings › Notifications, or ask your admin to configure instance email."`

## 4. Test-before-save endpoint

The existing generic `POST /api/notifications/channels/[channel]/test` tests
the **already-saved** config (`plugin.test(userId)` reads from DB). That's
insufficient here: the user wants to test SMTP fields *before* saving them,
so a bad password doesn't get persisted as "verified."

New route: **`POST /api/notifications/channels/email/test-smtp`**
- Body: `{ host, port, user, pass, from, tls }`. `pass` blank means "use the
  already-saved encrypted password" (same blank-means-keep convention as
  everywhere else in this file), so re-testing after a first successful save
  doesn't require re-entering the password.
- Builds a transporter directly from the candidate fields (bypassing storage
  entirely) and sends the same canned test payload `emailChannel.test()` uses.
  Add a small exported helper in `email.ts`, e.g. `sendTestWithConfig(userId,
  candidate: SmtpConfig)`, shared by both the real `test()` (reads stored
  config) and this route (reads candidate config) so the actual send/error-
  classification logic isn't duplicated.
- Never persists anything — a separate explicit "Save" action does that via
  the existing `PUT /api/notifications/channels/email`.

## 5. User settings UI (`/settings/notifications`)

Add an SMTP sub-form under the existing Email channel card: host, port,
username, password (blank = keep stored), from address, TLS mode select
(mirrors the admin SMTP form's fields/layout exactly — reuse its markup
patterns). Behavior:
- Collapsed/optional — a toggle or "Use my own SMTP" affordance, off by
  default (falls back to instance SMTP, matching today's behavior for
  everyone who does nothing).
- "Test" button calls the new `test-smtp` endpoint with the current in-form
  values (not yet saved), shows the same green/red inline result pattern the
  admin SMTP test uses.
- Copy explaining the fallback: "If you don't set this up, notifications use
  the instance's shared email server (if the admin has configured one)."
- Save goes through the extended `PUT /api/notifications/channels/email` (§6).

## 6. Channel config API (`/api/notifications/channels/[channel]`)

- `buildConfig('email', body, prev)`: accept the new `smtp` sub-object.
  Validate host/from/tls same as the admin endpoint does today. Encrypt the
  incoming `pass` via `secretKey.ts` before storing (`passEnc`); blank `pass`
  in the request keeps `prev.smtp?.passEnc` (never re-encrypt an empty
  string as "no password").
- `redactForClient('email', cfg)`: strip `smtp.passEnc` entirely, replace with
  `smtp.hasPass: boolean`, mirroring the existing ntfy/webhook redaction
  pattern exactly.
- `DELETE` already removes the whole config row per channel — fine as-is
  (removing email config removes the address override *and* personal SMTP
  together, which is the expected "disconnect this channel" semantics).

## 7. Admin SMTP UI (`/admin/notifications`)

Add explanatory copy near the existing SMTP section (no behavior change):
"This is the fallback used for any user who hasn't configured their own SMTP
in their notification settings. If a user has personal SMTP saved, their
notifications use that instead, and system/admin-broadcast emails (new
signups, invites redeemed, server health) sent to *this admin* also use this
fallback unless this admin has personal SMTP configured." Keep it short —
Cairn's "plain language, no exposed internals" convention.

## 8. Rollout / first-run

No data migration is destructive or required — existing `{ address }`-only
rows keep working unchanged (§1). The only first-run concern is generating
`instance.key` (§2) the first time any user or admin saves an SMTP password;
do it lazily in `getInstanceKey()` rather than as an explicit migration step,
same idempotent-lazy-init style the rest of the settings code uses. Bead exists
mainly to make sure this is actually tested against a fresh install *and* an
existing install with pre-existing `{ address }`-only email configs, plus the
Docker-volume gotcha from §2.

## 9. Work breakdown (see beads filed in `.beads`, prefix `cairn-`)

1. **Instance secret key + encryption helpers** — `secretKey.ts` (foundation;
   everything else depends on it)
2. **Email channel refactor** — per-user `readSmtpConfig(userId)` + priority
   fallback + shared `sendTestWithConfig` helper
3. **Channel config API: email SMTP fields** — `buildConfig`/`redactForClient`
   extension + encryption wiring
4. **Test-before-save endpoint** — new `test-smtp` route
5. **User settings UI: personal SMTP form** — `/settings/notifications`
6. **Admin SMTP UI: fallback explainer copy** — `/admin/notifications`
7. **Rollout verification** — fresh install + existing-install + Docker-volume
   check for `instance.key` placement

Dependency order: 1 → 2 → 3 → 4 → 5 (parallel with 6) → 7 last.
