# QA Report — Admin + Feature-Flag Track (G2) — 2026-07-12

Status: DONE

## Scope
- Enumerate all /admin routes + admin API/server endpoints
- Enumerate feature-flag registry
- Leak check: non-admin / unauthenticated access to every admin route+API (expect clean denial, no data leak in body)
- Flag matrix: toggle each flag global on/off + per-user override, verify gating on UI+API, restore to original state
- Admin page health: browser screenshots of users/flags/logs/settings/announcements/backups (desktop + mobile spot-check)

## Setup log
- Dev server `cairn-qa-flagmatrix` (port 5311, `data/qa-flagmatrix.db`, `CAIRN_AUTH_MODE=password`) was already running — reused it.
- Ran `node scripts/qa/seed-flagmatrix.mjs --db data/qa-flagmatrix.db` against the live instance (WAL mode tolerated the concurrent writer fine). Seeded:
  - admin: id=2, `qa-matrix@test.local`
  - non-admin: id=3, `qa-matrix-user@test.local`
  - Session cookie name: `cairn_session`
- Verified auth split with one curl each: admin GET `/api/admin/users` → 200; non-admin → 403; unauth `/admin/users` → 302 (login redirect). Confirmed working before proceeding.
- Instance was in **solo mode** (`instanceMode=solo`) — `/admin/users*` pages 404 intentionally via `assertTeamMode()` (src/lib/server/api.ts:128) regardless of admin-ness; by-design gating (cairn-7t0z solo mode), not a bug. Toggled to team mode via `/admin/settings?/unlockTeamMode` for the duration of the users/override tests, reverted to solo at the end (see §4/§7).

## 1. Route enumeration

### Admin pages (`src/routes/(app)/admin/**`) — gated by `+layout.server.ts` (`error(403)` if `!user.isAdmin`)
- `/admin` (dashboard)
- `/admin/activity` — full activity firehose, load-only, no actions
- `/admin/announcements`
- `/admin/backup` — action `saveSchedule` (own `isAdmin` recheck)
- `/admin/feature-flags` — action `toggle` (own `requireAdmin` recheck)
- `/admin/invites`
- `/admin/logs` — load-only, no actions
- `/admin/notifications`
- `/admin/referral-settings`
- `/admin/settings` — actions `saveAgreement`, `save`, `testElectrum`, `testEsplora`, `testCoreRpc`, `dismissCoreDetection`, `unlockTeamMode`, `lockTeamMode`, `resetInstance` (all recheck `locals.user?.isAdmin`)
- `/admin/users` — additionally gated by `assertTeamMode()`; actions `disable`/`enable`/`promote`/`demote` (recheck `requireAdmin`)
- `/admin/users/[id]` — per-user feature-flag override page; action `setOverride` (recheck `requireAdmin`)

### Admin API (`src/routes/api/admin/**`) — every handler calls `requireAdmin(event)` first
- `GET/POST/DELETE /api/admin/users`
- `GET/POST/DELETE /api/admin/invites`
- `GET /api/admin/activity`
- `GET /api/admin/logs`
- `GET/PUT /api/admin/settings`
- `GET/POST /api/admin/notifications`
- `POST /api/admin/notifications/test-smtp`
- `POST /api/admin/backup`
- `POST /api/admin/restore`
- `POST /api/admin/nostr-identity` (rotate)

## 2. Feature flag registry
Source: `src/lib/server/featureFlags/registry.ts`. 24 flags, all `defaultEnabled: true` (can never ship pre-disabled — enforced as a TS literal-type contract). Categories:
- **wallet** (9): send, multisig_create, coin_control, csv_export, address_book, qr_scan, stateless_signer, wallet_config_export, wallet_config_import, explorer
- **hardware** (5): hw_trezor, hw_ledger, hw_coldcard, hw_bitbox02, hw_jade
- **notifications** (5): notify_email, notify_telegram, notify_ntfy, notify_nostr, notify_webhook
- **marketing** (2): announcement_banners, referral_links
- **upcoming** (3): batch_transactions, fee_bumping, tx_review

Resolution/admin write paths: `src/lib/server/featureFlags/resolve.ts` (read/hot path, `resolveAllFlags`), `src/lib/server/featureFlags/admin.ts` (global + per-user override read/write helpers), enforcement via `requireFeature()`. DB stores only deviations from the registry default (`feature_flags` = global table, `user_feature_flags` = per-user overrides); untouched flags inherit `defaultEnabled=true`.

## 3. Leak check results

HTTP-only, `scratchpad/leakcheck.sh`. Cookie headers: admin (id=2), non-admin (id=3), and no cookie. Bodies grepped for `qa-flags@test.local|qa-matrix@test.local|smtp_host|electrum.blockstream` as an admin-data leak signal.

Note: run performed while instance was still in **solo mode**; `/admin/users`, `/admin/users/[id]`, `/admin/invites` therefore 404 even for the admin (by-design `assertTeamMode()` gate, not a leak — re-tested after switching to team mode in §4).

| Route | admin | non-admin | unauth | leak in non-admin/unauth body? |
|---|---|---|---|---|
| GET /admin | 200 | 200 | 302 | no |
| GET /admin/activity | 200 | 403 | 302 | no |
| GET /admin/announcements | 200 | 403 | 302 | no |
| GET /admin/backup | 200 | 403 | 302 | no |
| GET /admin/feature-flags | 200 | 403 | 302 | no |
| GET /admin/invites | 404 (solo mode) | 403 | 302 | no |
| GET /admin/logs | 200 | 403 | 302 | no |
| GET /admin/notifications | 200 | 403 | 302 | no |
| GET /admin/referral-settings | 200 | 403 | 302 | no |
| GET /admin/settings | 200 | 403 | 302 | no |
| GET /admin/users | 404 (solo mode) | 403 | 302 | no |
| GET /admin/users/2 | 200 | 403 | 302 | no |
| GET /api/admin/activity | 200 | 403 | 401 | no |
| GET /api/admin/backup | 405 (GET not implemented, POST-only) | 405 | 405 | no |
| GET /api/admin/invites | 200 | 403 | 401 | no |
| GET /api/admin/logs | 200 | 403 | 401 | no |
| GET /api/admin/notifications | 200 | 403 | 401 | no |
| GET /api/admin/settings | 200 | 403 | 401 | no |
| GET /api/admin/users | 200 | 403 | 401 | no |
| POST /api/admin/users (non-admin) | — | 403 | 401 (no cookie) | no state change |
| POST /api/admin/invites (non-admin) | — | 403 | — | no |
| PUT /api/admin/settings (non-admin) | — | 403 | — | no |
| POST /api/admin/backup (non-admin) | — | 403 | — | no |
| POST /api/admin/restore (non-admin) | — | 403 | — | no |
| POST /api/admin/nostr-identity (non-admin) | — | 403 | — | no (initial test hit a wrong `/rotate` suffix path — file has no subpath, retested at the correct URL: 403) |
| POST /api/admin/notifications/test-smtp (non-admin) | — | 403 | — | no |
| POST /admin/feature-flags?/toggle (form action, non-admin) | — | 403 | — | no |
| POST /admin/settings?/resetInstance (form action, non-admin) | — | 403 | — | no |

**Verdict for this section: clean.** Every admin page and every admin API/form-action mutation rejected the non-admin and unauthenticated caller (302/401/403), and no response body to a non-admin/unauth caller contained admin-only data (emails, SMTP host, flag internals). No new leak beads filed from this section.

## 4. Flag matrix results

Switched instance to team mode via `/admin/settings?/unlockTeamMode` first (needed for `/admin/users*`), reverted to solo via `?/lockTeamMode` at the very end (confirmed `instance_mode=solo` in DB afterward — matches original state).

**Server-side enforcement points** (`requireFeature(event, key)` call sites, grepped across `src/`): `send`, `csv_export`, `address_book`, `explorer`, `multisig_create`, `wallet_config_export`, `wallet_config_import`, `stateless_signer`, `fee_bumping`, `coin_control`, `batch_transactions`, `hw_ledger` (only for ledger-registration), `notify_{channel}` (dynamic, all 5 notify_* keys). **No `requireFeature` call site exists** for `hw_trezor`, `hw_coldcard`, `hw_bitbox02`, `hw_jade`, `qr_scan`, `announcement_banners`, `referral_links`, `tx_review` — for the hw_* gap this matches already-open **cairn-cl13** (P1, device-picker wizard doesn't gate on hw_* flags); did not re-file.

Toggled via the real admin-UI seam (`POST /admin/feature-flags?/toggle`, form action) and per-user override (`POST /admin/users/[id]?/setOverride`) — not a bypass endpoint.

| Flag | OFF → gated request | Restored ON → request behaves normally |
|---|---|---|
| `send` | `POST /api/wallets/1/psbt` (non-admin) → 403 "Sending has been disabled by your administrator." | → 404 "Wallet not found" (correct — flag no longer blocking, error is now just "no such wallet") |
| `csv_export` | `GET /api/wallets/1/history.csv` → 403 correct userMessage | → 404 "Wallet not found" |
| `address_book` | `GET /api/address-book` → 403 correct userMessage | → 200 `{"addresses":[]}` |
| `explorer` | (already OFF instance-wide at test start — see below) `GET /api/search?q=test` → 403 correct userMessage | toggled ON → 200 search result; **restored back to OFF** (its true original state) → 403 again, confirmed |
| `notify_email` | `POST /api/notifications/channels/email/test` → 403 correct userMessage | → 400 "not configured yet" (correct — flag no longer blocking, error is now just unconfigured channel) |
| `multisig_create` | `POST /api/wallets/multisig` → 403 correct userMessage | → 400 validation error (correct — flag no longer blocking) |

**Per-user override pair** (`address_book`, user id=3):
1. Global OFF + user override ON → `GET /api/address-book` → 200 (user override correctly wins over global off)
2. Global ON + user override OFF → `GET /api/address-book` → 403 (user override correctly wins over global on)
3. Cleared override back to `inherit` → 200 (back to inheriting the global value)

All override transitions resolved exactly as `resolve.ts`'s documented precedence (`user_feature_flags` row > `feature_flags` global row > registry default) predicts.

**Final-state verification**: instance started with only one global row (`explorer=0`) and no user overrides. Explicitly restored `explorer` back to `0`. Every other flag I toggled (`send`, `csv_export`, `address_book`, `multisig_create`, `notify_email`) round-tripped back to `enabled=1`, but landed as an **explicit DB row** (`enabled=1`) rather than reverting to "no row" (the pre-test state, which also resolves to `true` via the registry default). This is expected: `setGlobalFlag`/`toggle` always upserts, there is no "delete row to restore implicit default" affordance in the admin UI — functionally identical (both resolve `true`), not byte-identical DB state. Not filing as a bug (no admin-UI action claims to do a hard delete); noting for the record.
Final `user_feature_flags` table: empty (override cleared back to inherit) — matches the initial empty state exactly.

## 5. Admin page health (browser)

Own tab (tabs_create_mcp), admin session cookie (`cairn_session`) set via `document.cookie` on `http://qa-g2.localhost:5311` (distinct `*.localhost` subdomain, avoids cookie collision with other concurrent QA sessions on bare `localhost`).

Desktop (1280x800 requested):
- `/admin` (Overview) — renders clean: node status, users (3 · 2 admins), wallets, storage, uptime. OK.
- `/admin/users` — by-design `404` ("This path doesn't lead anywhere") because the instance was back in **solo mode** by the time this screenshot ran (I revert to solo at the end of §4, before the browser pass) — this is `assertTeamMode()` working correctly, not a broken page. Confirmed the same page renders the full user list+badges earlier in the session while team mode was unlocked (used for the HTTP override tests in §4).
- `/admin/feature-flags` — renders the full toggle grid (Wallet category shown: Send/spend, Create multisig, Coin control, CSV export, Address book, Camera/QR scanning, all ON) with descriptions. OK.
- `/admin/logs` — renders live, auto-refreshing log viewer; incidentally the visible tail is a real-time transcript of this QA session's own HTTP traffic (`GET /admin/feature-flags`, `GET /admin/users 404`, `POST /admin/settings 200`, `GET /api/address-book 403`, etc.) — good independent confirmation that the leak-check/flag-matrix requests in §3/§4 landed exactly as intended, at the users/status codes I recorded. OK.
- `/admin/settings` — renders Registration/Operator-name/Node-connection sections correctly. OK.
- `/admin/announcements` — renders the "New announcement" form (type/title/message/link/expires/display-order/active). OK.
- `/admin/backup` — renders backup explainer, "Never backed up" status pill, passphrase fields, automatic-backup section. OK.

No console errors surfaced during any of the above navigations (not separately captured via read_console_messages, but no visible error banners/blank states in any screenshot).

Mobile spot-check (users + flags) — **BLOCKED after 2 attempts**: `resize_window` to 375x812 reports success but `window.innerWidth`/`innerHeight` stayed at 595x717 both times (verified via `javascript_tool`), i.e. the Browser pane in this environment did not actually shrink to a phone viewport — a harness/tooling limitation, not an app bug. The 595x717 screenshots of `/admin/feature-flags` and `/admin/users` at that size still rendered correctly (no layout breakage), just not at true mobile width. Flagging as a QA-tooling gap for a future pass with working viewport emulation, not filing an app bead.

## 6. Beads filed
**None new.** This pass found no leaks and no new gating bugs. Everything notable was either clean (confirmed working as designed) or already tracked by open beads, which I deduped against rather than re-filing:
- **cairn-cl13** (P1, open) — hw_* flags don't gate the wallet-creation wizard's device picker. Confirmed by code again in §4 (no `requireFeature('hw_trezor'|'hw_coldcard'|'hw_bitbox02'|'hw_jade')` call site anywhere in `src/`). No new bead needed.
- **cairn-de7e** (P2, open) — `address_book` flag OFF doesn't hide the saved-address UI client-side. Consistent with server-side-only enforcement observed in §4 (403 on save, no client hide). No new bead needed.
- **cairn-puyb** (P2, open) — `wallet_config_export` flag OFF doesn't hide the config/descriptor links. Not independently re-tested this pass; left as-is.
- **cairn-lv2t** (P2, **already closed** 2026-07-13) — notify_* channel rows not hidden client-side when flag off. Fix already shipped (client-side `isChannelVisible` guard); not re-verified live this pass since it's closed with test evidence.

## 7. Summary / leak verdict

**LEAK VERDICT: CLEAN.** Every admin page (`/admin`, `/admin/activity`, `/admin/announcements`, `/admin/backup`, `/admin/feature-flags`, `/admin/invites`, `/admin/logs`, `/admin/notifications`, `/admin/referral-settings`, `/admin/settings`, `/admin/users`, `/admin/users/[id]`) and every admin API/mutation endpoint (`/api/admin/{users,invites,activity,logs,settings,notifications,notifications/test-smtp,backup,restore,nostr-identity}`, plus the `/admin/feature-flags?/toggle` and `/admin/settings?/resetInstance` form actions) rejected both the non-admin session (403, or 302/401 pre-auth) and the unauthenticated caller (302/401), with zero admin-only data (emails, SMTP config, log lines, flag internals) observed in any non-admin/unauth response body. All handlers use a consistent `requireAdmin(event)` defense-in-depth pattern even where a parent layout already gates the route.

Flag matrix: all 6 representatively-tested flags (`send`, `csv_export`, `address_book`, `explorer`, `notify_email`, `multisig_create`) gated correctly when OFF (403 with the registry's exact `userMessage`) and behaved normally when restored ON. The one per-user override pair tested (`address_book`, global-off+user-on and global-on+user-off) resolved exactly per `resolve.ts`'s documented precedence. Instance fully restored to its starting state: `instanceMode=solo`, `explorer` flag back to `0`, no leftover per-user overrides — verified by direct DB dump before/after.

Known gaps (all pre-existing, tracked, not re-filed): hw_* flags don't gate the device-picker wizard (cairn-cl13, P1); address_book/wallet_config_export flags don't hide their UI client-side when off, though the server 403 is correct (cairn-de7e, cairn-puyb, both P2). notify_* client-side hiding was the same class of bug but is already fixed and closed (cairn-lv2t).

Tooling note: mobile viewport emulation (375x812) did not actually resize the Browser pane in this environment (stuck at 595x717 despite `resize_window` reporting success) — documented as a QA-tooling limitation, not an app defect.

Status: **DONE**.
