# Cairn Data Audit — 2026-07-06

Full inventory of every column in `src/lib/server/db.ts` (36 tables), how it's used in
practice (routes/services that read or write it, not just the schema comment), who can
see it, how long it's kept, and what that means for a self-custody Bitcoin tool whose
entire pitch is "we don't hold your keys, don't trust us more than you have to."

Method: read the full schema, then traced every table through the code that reads/writes
it — ownership checks, client-facing responses, admin routes, log calls, and any
delete/prune/expiry logic. File:line citations are given wherever a claim depends on them.

---

## 1. Identity & auth

### `users`
- **Stores**: email (unique, case-insensitive), scrypt password hash (nullable — passkey-only accounts), display name, `is_admin`, `disabled`, `created_at`, `last_login`.
- **Needed?** Essential — this is the account.
- **Visibility**: self (`getSessionUser`, `auth.ts:58-89`, → `locals.user` on every page). Admins see every user's email/display_name/is_admin/disabled/created_at/**last_login**/wallet_count via `listUsers()` (`admin.ts:7-36`, `/admin/users`). No user-to-user leakage found.
- **Retention**: forever; only removed via admin `deleteUser`/`resetInstance` (`admin.ts:75-109`).
- **Sensitive**: email (PII), password_hash (hashed, never logged — confirmed at `auth.ts:135-138,162,176`).
- **Privacy note**: `last_login` is a behavioral-tracking field visible to every admin on a multi-admin instance, not just "the operator."

### `sessions`
- **Stores**: token_hash, user_id, created_at, expires_at, and (added later) `user_agent`, `ip_address` (raw, for new-device detection).
- **Needed?** Essential for auth; the raw IP/UA capture is needed for the `security_new_device` notification.
- **Visibility**: never returned to the browser (only the opaque, unhashed token goes in an httpOnly cookie — `auth.ts:110-123`). No UI (user- or admin-facing) ever lists sessions/devices — confirmed no route reads these columns for display.
- **Retention gap**: expired sessions are deleted lazily, one at a time, only when that exact token is next presented (`auth.ts:79-82`). **No background sweep exists.** An abandoned session (never reused after expiry) — including its raw IP and user-agent — sits in the table indefinitely.
- **Sensitive**: raw IP address, raw user-agent string, token_hash.

### `user_credentials` (WebAuthn passkeys)
- **Stores**: credential_id, public_key (COSE), counter, transports, device_type, backed_up, name, created_at, last_used_at.
- **Needed?** Essential for passkey auth.
- **Visibility**: owner only, via the settings page (`listCredentials`, `auth.ts:462-486`) — public_key/credential_id never sent to the browser. No admin view exists.
- **Retention**: fine as-is — finite, user-managed (add/rename/delete), last passkey can't be removed.
- **Sensitive**: public_key is not secret (it's a public key by definition); credential_id is a stable per-device identifier.

### `account_recovery_phrases` / `account_recovery_codes`
- **Stores**: salted scrypt hash of a 12-word login-recovery phrase (one per user, reusable) / 8 single-use codes with `used_at`.
- **Needed?** Essential — this is how a user regains Cairn *login* access after losing every passkey. Explicitly NOT bitcoin-key recovery (keys never touch the server).
- **Visibility**: owner only sees booleans/counts (`hasRecoverySetup`, `recovery.ts:232-240` → settings page) — hashes never leave the server. Always hashed before storage, confirmed at write time (`recovery.ts:75-90,152-172`).
- **Retention gap**: spent/used codes are never purged (`used_at` just gets set) — low volume, low risk, but no cleanup exists.

### `recovery_grants`
- **Stores**: token_hash, user_id, purpose (`register_passkey`), expires_at (short TTL).
- **Needed?** Essential — short-lived authorization for the one step after a successful recovery (register a new passkey); not a full session.
- **Visibility**: only the opaque token in an httpOnly cookie; token_hash never returned.
- **Retention gap**: same lazy-deletion pattern as `sessions` — an abandoned grant (user never finishes the ceremony) sits until someone happens to look it up (`recovery.ts:296-299,317`). Minor given the short TTL and low volume, but no proactive sweep exists.

### `known_devices`
- **Stores**: `sha256(user-agent)` fingerprint (confirmed UA-only, not IP — `deviceTracking.ts:41-43`), raw user_agent, first_seen, last_seen.
- **Needed?** To suppress the new-device alert for a user's very first device and recognize returning devices.
- **Visibility**: **entirely write-only in the app** — no route or page ever reads this back for the user. There is no "trusted devices" / session-management UI. It exists solely to gate an internal alert.
- **Retention gap**: rows accumulate forever, one per (user, UA-hash) pair, never expired, never user-removable.
- **Privacy note**: this is behavioral/device data tied to an account, collected and retained indefinitely, that the account owner can never see or clear themselves.

### `admin_disclosure_acceptances` / `user_agreement_acceptances`
- **Stores**: admin's one-time operator acknowledgement (no IP); per-user clickwrap acceptance of the terms, with `version`, `accepted_at`, and **best-effort client IP** (`disclosures.ts:122-128`).
- **Needed?** Legal/evidentiary record of consent — reasonable purpose.
- **Visibility**: only booleans gate UI flow; the raw IP is never displayed anywhere, to anyone (write-only).
- **Retention**: permanent by design (it's a legal record) — defensible, but there's no *documented* retention policy anywhere the user can read.

---

## 2. Wallets & keys

### `wallets` (single-sig)
- **Stores**: xpub, script_type, receive_cursor, master_fingerprint, derivation_path, device_type.
- **Needed?** Essential — this is the wallet.
- **Visibility**: owner-only (`WHERE id=? AND user_id=?` throughout `wallets.ts`). xpub/fingerprint/derivation_path are sent to the browser (needed for the signing UI / QR display). The background chain-watcher (`addressWatcher.ts:180`) reads all users' `id, user_id, name, xpub` — internal, not user-facing.
- **Retention**: forever, until user deletes the wallet (cascades `multisig_keys`, etc.; explicitly cleans up `notified_txids`/`address_labels`, which have no FK).
- **Sensitive**: xpub (deanonymizes an entire address history if leaked), fingerprint. No encryption at rest — plaintext TEXT columns.

### `multisigs` / `multisig_keys` / `ledger_multisig_registrations`
- **Stores**: threshold, script_type, receive_cursor; per-key name/category/device_type/xpub/fingerprint/path/`last_verified_at`/`last_notified_at`/`assigned_user_id`; per-device Ledger policy HMAC (not secret — needed client-side to re-sign).
- **Needed?** Essential — multisig key metadata is relational (not a config blob) so the wizard can edit keys individually.
- **Visibility**: 3-tier gate — `getMultisig` (owner), `getViewableMultisig` (owner + any accepted share, viewer or cosigner), `getSignableMultisig` (owner + cosigner-role shares) (`wallets/multisig.ts:134-181`).
  - **Finding**: `redactMultisigKeysForViewer` (`multisigShares.ts:280-289`) strips only the derivation `path` for a non-assigned key — **xpub and fingerprint are never redacted for any viewer**, by explicit design comment ("aren't secret"). A read-only `viewer` share therefore sees every cosigner's xpub/fingerprint for the whole quorum, just not their paths.
  - `ledger_multisig_registrations` is stricter — owner-only, no viewer/cosigner access at all (`multisigRegistrations.ts:67-73`), which is arguably *inconsistent*: a cosigner needs the registration to co-sign on a Ledger but currently can't fetch it through this table's routes.
- **Retention**: forever, until the multisig is deleted (cascades).
- **Sensitive**: xpub, fingerprint. No encryption at rest.

---

## 3. Transactions & money movement

### `transactions` / `multisig_transactions`
- **Stores**: status, full working PSBT (base64), txid, recipient(s)/amount/fee/fee_rate, change_index, `replaces_txid` (RBF lineage), `broadcast_started_at` (in-flight claim marker).
- **Needed?** Essential — this is the send flow's working state.
- **Visibility**: gated through wallet/multisig ownership throughout. The full PSBT (inputs, outputs, addresses, amounts, BIP32 derivation) is sent to the browser client — this is *necessary*: hardware-wallet "what you see is what you sign" signing requires the actual bytes; redacting them would force blind-signing, a known anti-pattern.
  - **Real finding — inconsistent viewer exposure on multisig_transactions**: `getMultisigTransaction` gates only on `viewableMultisig` (owner/viewer/cosigner alike), not `signableMultisig`. A pure **viewer** share (read-only, never expected to sign) can fetch the full raw PSBT via `GET /api/wallets/multisig/[id]/transactions/[txId]`, the raw `.psbt` file download, and the unfiltered transaction list — full recipient addresses and amounts on in-flight, unbroadcast drafts — even though the app's own stated intent (key-path redaction, descriptor withheld from viewers) is that viewers should see *less* than cosigners. This is a policy gap, not a full break: a viewer already legitimately sees balances/history for a shared wallet, so the incremental leak is draft-transaction detail before it's public on-chain.
  - The wallet-overview page (`(app)/wallets/multisig/[id]/+page.server.ts:116-121`) correctly projects saved transactions down to `{id, txid, status, feeRate}` before sending to the client — the leak is specifically in the transaction-detail/file/list API routes, not this page.
- **Retention**: **no purge logic anywhere.** `completed`/`superseded` rows are explicitly protected from deletion (`transactions.ts:914-918`: "deleting them would erase the record") and accumulate forever, full PSBT included. Draft/awaiting_signature rows persist indefinitely unless the user manually deletes them — no TTL.
- **Sensitive**: PSBT (embeds xpubs/fingerprints via BIP32 derivation until broadcast), recipient addresses, amounts. No encryption at rest; no plaintext logging found (verified via grep — all `log.*` calls near these tables pass only `err`/numeric IDs/txids).

### `tx_labels` / `address_labels`
- **Stores**: free-text label per (wallet, txid) or (wallet, address).
- **Needed?** Nice-to-have UX (annotate why a tx/address exists) — not essential to wallet function, but genuinely useful and low-risk.
- **Visibility**: no `user_id` column — access is enforced only by the caller checking wallet/multisig ownership first. Confirmed: for a **shared** multisig, `getAddressLabels`/`listMultisigTransactions` are called for any role that passes `getViewableMultisig` — i.e., a `viewer` share sees the *owner's* address/tx annotations on that shared wallet. This is presented as intentional ("shared annotations for this vault," `(app)/wallets/multisig/[id]/+page.server.ts:78`), not a bug, but it's worth users knowing that inviting a "viewer" collaborator shares their private notes on addresses, not just balances.
  - **Additional finding**: the multisig `address-labels` route also lets a `viewer` share **write** (PUT) labels, not just read them — broader than what a nominally read-only role implies. Worth a policy decision: should viewers be able to edit shared annotations, or only cosigners/owner?
- **Retention**: forever; explicitly cleared on wallet/multisig deletion (no FK, so done by hand in `wallets.ts`/`multisig.ts`).

### `saved_addresses` (address book)
- **Stores**: label + address per user.
- **Needed?** Nice-to-have UX convenience.
- **Visibility**: strictly `user_id`-scoped everywhere (`addressBook.ts`) — never joined against `multisig_shares`. Confirmed a shared-wallet viewer/cosigner **cannot** see the owner's personal address book (unlike `tx_labels`/`address_labels` above).
- **Retention**: forever; no cap. Low volume, user-deletable one at a time.

### `balance_snapshots`
- **Stores**: one row per (user, wallet, hourly tick) with `balance_sats`, feeding the dashboard's balance-over-time chart.
- **Needed?** Nice-to-have (a chart), not essential to spend/receive.
- **Visibility**: correctly `user_id`-scoped in every query (`portfolio.ts`).
- **Retention — unbounded.** No cap, no pruning, no TTL anywhere in the codebase. One row per wallet per hour, forever, for every wallet a user has ever owned (including deleted ones — nothing removes a wallet's historical snapshots on delete). This is the single clearest "will grow forever" table in the schema, unlike `events`, which has an explicit prune-on-insert policy.

### `wallet_scan_cache`
- **Stores**: last completed Electrum scan result (JSON) keyed by xpub/descriptor.
- **Needed?** Pure performance cache (survives restarts) — never authoritative.
- **Visibility**: no `user_id` column at all — keyed purely by cache_key (xpub/descriptor value), so it's *structurally* shared across users: two users who imported the identical xpub would share a cache row. Not a practical concern for private xpubs, but worth noting as a design quirk.
- **Retention**: correctly invalidated on wallet/multisig delete (`invalidateWalletCache`/`invalidateMultisigCache`). Fine as-is.

### `wallet_backups` (and its throttle sibling `backup_missing_notified`)
- **Stores**: per-wallet "config backup downloaded" timestamp (and, separately, a throttle marker for the "you never backed this up" nudge).
- **Needed?** Essential to the backup-nudge UX — losing a multisig's config can mean permanently losing funds, so this is tracked server-side rather than trusted to a client flag.
- **Visibility**: owner-scoped in practice; no cross-user or admin exposure found. (`isBackedUp()` itself takes no `userId`, but every call site already gates access via the wallet/multisig ownership check first, so it only ever confirms/denies a backup record exists — no content is exposed.)
- **Retention — orphan gap confirmed**: neither `deleteWallet` nor `deleteMultisig` clears `wallet_backups` or `backup_missing_notified` rows (no FK, no explicit DELETE) — unlike `address_labels`/`notified_txids`, which both follow the correct explicit-cleanup pattern on deletion. Low sensitivity (timestamps only, no PII), but it's a real data-hygiene gap, and if a wallet id is ever reused it could produce a misleading "already backed up" read for the new wallet.

---

## 4. Notifications

### `notification_preferences` / `user_notification_settings`
- **Stores**: per-user, per-event-type channel routing; quiet-hours window (start/end/timezone, urgent-override flag).
- **Needed?** Essential to the notification feature; a row's absence just means "use the default," which keeps the table small.
- **Visibility**: owner-only. No issues found.
- **Retention**: fine — bounded by (user × event_type × channel) or one row per user.

### `notification_channel_config` — **the most important finding in this audit**
- **Stores**: per-user, per-channel connection config as a JSON blob — SMTP host/user/**password**, ntfy server/**access token**, webhook URL/**HMAC secret**, Telegram chat id, Nostr relay list.
- **Needed?** Essential to deliver notifications over the user's own channels.
- **Visibility**: `redactChannelConfig()` (`notifyConfig.ts:33-59`) correctly strips secrets before any read reaches the client (`hasAccessToken`/`hasSecret`/`hasPass` booleans only) — the *read path* is solid.
- **At-rest encryption — inconsistent**:
  - Personal SMTP password: **encrypted** via `secretKey.ts` (AES-256-GCM envelope), decrypted only at send time.
  - **ntfy access token: stored in plaintext** in the JSON blob (`api/notifications/channels/[channel]/+server.ts:215-220`).
  - **Webhook HMAC secret: stored in plaintext** (same file, lines 243-246).
  - These two are exactly the kind of bearer-credential material `secretKey.ts` exists to protect, per its own header comment — they're just not routed through it.
- **Instance-wide `settings` table — same gap, worse scope**: `smtp_pass`, `core_rpc_pass`, and `telegram_bot_token` are stored in the loose `settings` KV table **in plaintext**, readable directly from a copy of `cairn.db`. Only `nostr_sender_privkey` in this same table is correctly `encryptSecret()`-wrapped. Log redaction (`logger.ts:187,192`) keeps these out of log output, but that doesn't help against direct DB/file access.

### `user_pgp_keys`
- **Stores**: ASCII-armored PGP public key + fingerprint, for optional email encryption.
- **Needed?** Opt-in privacy feature — a public key is not sensitive by definition.
- **Visibility/retention**: no issues found.

### `notification_queue`
- **Stores**: every outbound non-in-app notification attempt — payload (serialized, no secrets by design), status, attempts, last_error, timestamps.
- **Needed?** Essential for retry/backoff delivery.
- **Retention — unbounded.** No purge logic found anywhere (grepped for cleanup/retention/DELETE — nothing outside tests). The schema comment says rows go "dead after max attempts," but dead/sent rows are never actually removed — this table grows forever.

### `backup_missing_notified` / `backup_reminders`
- **Stores**: throttle markers ("already nudged this wallet/user recently") for the backup-reminder features.
- **Needed?** Essential to the throttling logic itself; trivial data, no privacy concern.

---

## 5. Collaborative custody

### `contacts`
- **Stores**: friends-only social graph (requester, target, status).
- **Needed?** Essential gate for wallet sharing — you can only share a wallet with an accepted contact.
- **Visibility**: anti-enumeration is genuinely implemented — `requestContact()` returns an identical success shape whether the target email exists or not, including a dummy timing-normalization query to close a timing side-channel (`contacts.ts:81-145`). Rate limiting is the primary defense at the route layer.
- **Retention**: forever; fine (small, relationship-defining rows the user can presumably remove — not verified here).

### `multisig_shares` / `multisig_transaction_signers`
- **Stores**: who a multisig is shared with and at what role (viewer/cosigner); a frozen per-transaction roster of who's expected to sign (denormalized JSON snapshot of assigned key IDs, `has_signed` advisory flag).
- **Needed?** Essential to collaborative custody as designed.
- **Visibility**: role gating is correctly enforced for keys (with the xpub/fingerprint caveat above) and for the multisig object itself; see the `multisig_transactions` PSBT-exposure finding above for the one real gap.
- **Retention**: rosters are deliberately frozen at transaction-creation time (later share changes don't rewrite history) — this is a considered design choice, not an oversight.

---

## 6. Instance / admin

### `invites`, `feature_flags`, `user_feature_flags`
- Low-sensitivity operational tables. `updated_by` (admin user id) on the feature-flag tables is confirmed write-only — never selected/returned by `getGlobalFlags`/`getUserOverrides`/`overrideCountsByFlag` (`featureFlags/admin.ts:20-89`). No issues found.

### `settings` (loose KV store)
- **Stores**: `registration_mode`, `connection_mode`, Electrum/Esplora/SOCKS5 config, `core_rpc_user`/**`core_rpc_pass`**, `smtp_host/port/user`/**`smtp_pass`**, **`telegram_bot_token`**, ntfy/nostr defaults, webhook policy, and the user-agreement text/version.
- **Concern**: this is a schema-less bucket mixing pure configuration (electrum URL) with credential material (`smtp_pass`, `core_rpc_pass`, `telegram_bot_token`) that should be typed and encrypted, not string values in a generic key/value table. See the encryption finding above.

### `events` (user activity feed)
- **Stores**: per-user (or NULL = instance-wide) notable happenings — type, level, human-readable message, optional JSON `detail`, `read_at`.
- **Needed?** Essential UX feature; explicitly designed to exclude secrets ("never PSBTs, keys, or tokens" per the schema comment — verified true).
- **Retention**: correctly pruned — `recordActivity()` calls `prune()` on every insert, keeping the newest `EVENTS_PER_BUCKET = 500` rows per user/bucket (`activity.ts:57,96-120`). This table is the one clean example of retention done right; contrast with `balance_snapshots`/`notification_queue` above.
- **Admin exposure — real finding**: `/admin/activity` and `GET /api/admin/activity` (`listAllActivity`, `activity.ts:276-329`) return **every user's** event stream by default (no `user_id` filter unless explicitly requested), joined to email/display_name, and the API response includes the full, untruncated `detail` JSON — e.g. full txid and multisig id for a broadcast — even though the rendered admin UI table only shows a truncated message. Any admin hitting the API directly (not just the page) sees more than the UI implies.

---

## 7. Cross-cutting findings

### Logging
`logger.ts` applies a global pino redact list (`password`, `token`, `xprv`, `mnemonic`, `psbt`, `seed`, etc.) and the codebase largely logs structured `{err, userId, walletId}` rather than whole objects. Concrete exceptions found — raw PII logged outside the redact list:
- `auth.ts:191,195-198` — logs the raw **email** on every failed/disabled login attempt.
- `recovery.ts:387` — logs the raw **email** on every break-glass admin recovery login.
- `rateLimit.ts:219` — logs the raw **client IP** on every bad invite-code attempt.

These are all readable by any admin via `/admin/logs` (confirmed admin-gated, `requireAdmin` at `admin/logs/+server.ts:11`; a structured, searchable JSON log viewer, not a raw tail). On a multi-admin instance this means every admin — not just the instance owner — sees other users' emails and IPs just from normal login traffic. **Fix**: add `email`/`ip` to the redact key list, or switch these call sites to `userId`-only.

### Admin full-instance backup (`POST /api/admin/backup`)
`buildBackup()` (`backup.ts:49-68`) exports, unfiltered across **every user**: `wallets` (including `xpub`), `multisigs`, `multisig_keys` (including `xpub`), `ledger_multisig_registrations`, `saved_addresses`, `tx_labels`. The route's own comment says "no secrets" — true for passwords/private keys — but it hands any single admin a passphrase-encrypted file containing every user's wallet xpubs and personal address-book/labels, not scoped to their own account. This is a reasonable feature for a single-operator instance (it's *the* disaster-recovery backup) but is worth calling out explicitly on a multi-user/multi-admin instance, since "admin" here effectively means "can export everyone's wallet structure."

### Terms / disclosure content vs. actual data practices
`disclosures.ts` ships two documents: a one-time operator acknowledgment, and a per-user clickwrap agreement. The user-facing agreement covers the custody/liability model well (Cairn never holds keys or funds, backups are the user's responsibility, transactions are irreversible, no liability for losses) — but **says nothing about server-side data handling**: no mention of IP address logging, the activity/events feed, the notification delivery queue, or that admins can read `/admin/logs` (which, per the finding above, can include other users' emails and IPs). This is a custody/liability disclosure, not a privacy disclosure — the two are conflated where only the former exists today.

### No self-service account deletion or data export
No route anywhere lets a user delete their own account or export their own data. Admins can `deleteUser`/`resetInstance`, but there's no user-initiated equivalent, and no "download everything Cairn has stored about me" export (the only "export" routes found are wallet-scoped: CSV transaction history and wallet-config/descriptor backups).

---

## 8. What should be REMOVED

- **`known_devices`** collects and keeps device fingerprints forever with zero user visibility or control. If kept, it needs a retention window (e.g., drop devices unseen for 12 months) and, ideally, a "your devices" page so it's not purely a hidden liability.
- **`users.last_login`** exposed to every admin is more granular behavioral tracking than a "who has an account" admin page needs; consider showing only a coarser signal (e.g., "active in last 30 days") if the goal is just spotting stale accounts.
- Nothing found that's collected but genuinely unused (no dead columns identified) — the schema is unusually disciplined about this, likely thanks to the guarded-ALTER migration pattern making every column traceable to a specific feature.

## 9. What should be ADDED

- **A retention/purge job** for tables that currently grow forever with no cap: `balance_snapshots` (hourly-per-wallet, unbounded), `notification_queue` (dead/sent rows never removed), expired `sessions`, expired `recovery_grants`. A single daily maintenance pass (mirroring the pattern `activity.ts`'s `prune()` already establishes) would close all four at once.
- **A documented data-retention section in the user agreement** — what's logged (IP on login/agreement-acceptance, activity feed), how long it's kept, and that admins can read server logs. This is a five-minute addition to `disclosures.ts` that would make the existing agreement honest about scope.
- **A "your devices" page** surfacing `known_devices`/`sessions` to the user themselves, with a revoke action — turns write-only surveillance data into an actual security feature the user can act on (a self-serve counterpart to the new-device alert that already exists).
- **A self-service "delete my account" flow** and a basic data-export endpoint (JSON dump of the user's own rows across all tables) — standard baseline for any tool holding personal data, and cheap relative to everything else in this schema given how normalized it already is.
- **Encryption for the remaining plaintext secrets**: ntfy access token, webhook HMAC secret (both in `notification_channel_config`), and instance-wide `smtp_pass`/`core_rpc_pass`/`telegram_bot_token` (in `settings`) — route all of them through the `secretKey.ts` envelope already used for personal SMTP passwords and the Nostr private key. This is the single highest-value fix in this audit: it's an existing, working primitive that simply isn't applied consistently.

## 10. What should be REORGANIZED

- **`settings`** mixes plain configuration with credential material in one untyped KV table. Splitting out a small `instance_secrets` table (or at minimum encrypting the credential-shaped values in place) would make "what's sensitive here" obvious from the schema instead of requiring a code audit to discover.
- **`multisig_transactions` viewer access** should call `getSignableMultisig`-equivalent gating (or a new tier) before returning the full PSBT for detail/list/file routes — today it uses the same `viewableMultisig` check as balance/history reads, which is looser than the redaction already applied to keys and descriptors for the same role. This is a one-line-per-route fix (swap the gate function), not a schema change.
- **`ledger_multisig_registrations`** is owner-only while `multisig_keys` grants viewers/cosigners more, which is backwards from a functional standpoint — a cosigner needs the Ledger registration to actually sign but currently can't fetch it. Align its access tier with `getSignableMultisig`.
- **`tx_labels`/`address_labels`** having no `user_id` and relying entirely on caller discipline is a latent risk (any new route that forgets to gate through wallet/multisig ownership leaks labels wallet-wide). Not broken today, but a `user_id`-based defense-in-depth check (even just an assertion) would be cheap insurance, mirroring how `saved_addresses` already does it correctly.
- **`wallet_backups`/`backup_missing_notified`** orphan on wallet/multisig deletion — add the same explicit-delete-on-teardown pattern already used for `notified_txids`/`address_labels` (`deleteWallet`/`deleteMultisig` in `wallets.ts`/`wallets/multisig.ts`). Cheap, low-risk fix.
- **Multisig `address-labels` route** grants a `viewer` share write access, not just read — decide whether that's intended for a role named "viewer," and if not, restrict the PUT to cosigner/owner.
- No table found that's over-normalized (split for no reason) or that should be merged — the split between `transactions`/`multisig_transactions` and `tx_labels`/`address_labels`/`wallet_backups`/`balance_snapshots` using a `wallet_kind` discriminator instead of two FK columns is a deliberate, sound pattern, consistently applied.

## 11. Privacy recommendations

- **Minimum data per feature**: the schema is already close to minimal — most tables map 1:1 to a specific feature with no extraneous columns. The gaps are almost entirely about *retention* and *encryption*, not over-collection.
- **What should auto-purge**: `balance_snapshots` (age out after N months, or downsample to daily after 30 days), `notification_queue` (delete `sent`/`dead` rows after e.g. 30 days), expired `sessions`/`recovery_grants` (sweep hourly), `known_devices` unseen for 12+ months.
- **What the user should be able to delete themselves**: their own account (does not exist today), individual sessions/devices (no UI exists today), notification channel configs (already possible), saved addresses/labels (already possible).
- **What a future "export my data" should include**: profile (email, display name, created_at), wallets/multisigs metadata (names, xpubs, NOT private keys — Cairn never has them), transaction history, saved addresses and labels, notification preferences, activity feed, and known devices/sessions — i.e., everything in this audit except password/recovery hashes and other users' data.
- **Does the terms page accurately describe what's collected?** No — see §7. It's a solid custody/liability disclosure but silent on data handling (IP logging, activity feed, admin log access, notification queue). Recommend adding a short "what we log and why" section rather than rewriting the existing agreement.
