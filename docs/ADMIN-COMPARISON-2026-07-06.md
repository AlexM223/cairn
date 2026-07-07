# Cairn vs. Gitea/Nextcloud — Admin & Platform UX Comparison — 2026-07-06

Scope: **not Bitcoin features.** This is the platform layer every self-hosted
multi-user app needs — first-run setup, users/roles, admin dashboard, logging,
backup, notifications, email, updates, branding, settings, API, mobile, error
handling. Cairn is v0.1.4. Gitea and Nextcloud were chosen as reference points
because they're mature, widely-deployed, multi-user Umbrel-store apps that
users will implicitly benchmark Cairn against.

Method: one pass read the actual Cairn code (routes, `src/lib/server/*`) for
each category; a second pass researched Gitea's and Nextcloud's documented
behavior for the same categories. Findings below are cross-checked against
`.beads/issues.jsonl` so we don't re-flag things already fixed or already
tracked.

---

## Summary table

| # | Category | Cairn | Gitea | Nextcloud | Verdict |
|---|----------|-------|-------|-----------|---------|
| 1 | First-run setup | Env-var bootstrap admin, no forced reset yet | Web install wizard | Web wizard + reliable Docker auto-admin env vars | **Behind** — tracked (cairn-49xi.2) |
| 2 | Registration | open/invite/closed, admin-configurable | Open by default, config-file toggle | Closed by default, needs an app to open | **On par** |
| 3 | Roles & permissions | admin/user + owner/cosigner/viewer per multisig + per-user feature flags | org/team/unit permissions (git-resource-centric) | groups + subadmins + delegation + per-share ACLs | **On par**, different shape |
| 4 | Admin dashboard | Stats, users, invites, settings, activity, logs, backup — 9 tabs | Cron tasks, live monitor (mem/goroutines/queues) | Prescriptive security/setup warnings + serverinfo | **On par** |
| 5 | Activity/audit logging | Per-user feed + admin cross-user view, auto-pruned, structured pino logs | No audit log in Community (Enterprise-only) | Free `admin_audit` app, IP/login/file-event logging | **Ahead of Gitea CE, behind Nextcloud** in formal audit-log framing |
| 6 | Backup & restore | One-click encrypted instance backup + additive restore, per-wallet export | `gitea dump` (backup only, no restore command) | Fully manual (copy folders + DB dump), no restore command either | **Ahead** — only one of the three has actual restore automation |
| 7 | Notifications | 5 channels (email/ntfy/webhook/telegram/nostr) + in-app, per-user per-event routing, quiet hours | Email + in-app only, coarse controls, no push | Real push (iOS/Android), per-app granularity, digest cadence | **Behind Nextcloud** on digest/batching; **ahead of Gitea** on channel breadth |
| 8 | SMTP/email | Instance SMTP + per-user override, both encrypted | Instance-only, no per-user | Instance-only, no per-user | **Ahead** — per-user override is genuinely unusual |
| 9 | Updates | No update check, no in-app notice | In-app update-checker notice only | Full in-app updater (non-Docker installs only) | **Behind** |
| 10 | Branding | Fixed app identity (own logo/theme), operator name only shown on legal terms | `APP_NAME` + file-based logo/CSS | Full UI-driven Theming app (name/logo/colors/legal links) | **Behind** on admin-configurable branding |
| 11 | Instance settings | Registration mode, instance mode, connection config, notification defaults — live UI | Mostly `app.ini` + restart | Mostly live UI | **On par** (Cairn already favors live UI) |
| 12 | API access | Session-cookie only, no tokens, ~90 ad-hoc routes, 6 response-shape conventions | Scoped PATs + OAuth2 + Swagger docs | App passwords (unscoped) + OCS/WebDAV + OAuth2 (unscoped) | **Behind both** |
| 13 | Mobile responsiveness | Responsive CSS, dark mode, no PWA, no app | No official app, no PWA, community apps only | First-party iOS/Android apps, no PWA | **Behind Nextcloud**, on par with Gitea |
| 14 | Error handling | Structured JSON errors + pino logging, no unified toast component | Flash messages + structured API errors | Toast API + proactive admin warnings + in-browser log viewer | **Behind** on UI consistency |

---

## Detail by category

### 1. First-run setup
Cairn's `bootstrapAdminFromEnv()` (`auth.ts:272-288`) creates the first admin
from `CAIRN_ADMIN_PASSWORD`/`CAIRN_ADMIN_EMAIL` at boot. Gitea and Nextcloud
both have a browser-based install wizard; Nextcloud additionally has a
reliably-documented Docker path (`NEXTCLOUD_ADMIN_USER`/`_PASSWORD` env vars).
Cairn's gap — no forced password/email reset after bootstrap — is already
scoped and tracked as **cairn-49xi.2** (part of the Umbrel auto-admin epic).
Nothing new to file here.

### 2. Registration
Cairn's three-mode registration (open/invite/closed) with atomic invite
redemption is comparable to or better than either reference app — Gitea
defaults open and Nextcloud defaults closed-and-needs-a-plugin. No gap.

### 3. Roles & permissions
Cairn's model (instance admin + per-multisig owner/cosigner/viewer + per-user
feature flags) is a reasonable, if different, granularity from Gitea's
team/unit model or Nextcloud's groups+delegation+ACL model. Structurally on
par. Two Cairn-specific rough edges already known and out of scope here: a
cosigner can edit shared labels despite the role name implying read-only
signing, and `getViewableMultisig` is used in a couplace where
`getSignableMultisig` would be tighter — both are DATA-AUDIT findings, not new.

### 4. Admin dashboard
Cairn's admin section (9 tabs: overview, activity, users, invites, settings,
feature-flags, notifications, logs, backup) is comparably comprehensive.
Gitea's live monitor (memory/goroutines/queue depth) and Nextcloud's
proactive "security & setup warnings" banner are both things Cairn lacks — a
warnings banner (stale node connection, no backup taken, notification queue
backlogged) would be a cheap, high-visibility win, but this is closer to
polish than a functional gap.

### 5. Activity / audit logging
Cairn already does more than Gitea Community here (which has *no* structured
audit log at all — it's Enterprise-only) and roughly matches what Nextcloud's
free `admin_audit` app provides: per-event admin visibility, IP-aware login
logging, structured pino logs. The framing differs though — Nextcloud
explicitly separates "Activity" (user-facing, user-disable-able, not a real
audit trail) from "admin_audit" (compliance-grade, always-on). Cairn's
`/admin/activity` conflates both roles into one feed. This is a naming/scoping
nuance, not a missing capability — no bead needed.

### 6. Backup & restore
This is a category where **Cairn is ahead of both references**. Neither Gitea
nor Nextcloud ships a "click restore and it works" flow — Gitea has no
restore command at all (manual file placement + DB import + hook
regeneration); Nextcloud's process is entirely manual (copy folders, drop/
recreate DB, restore dump). Cairn's one-click encrypted instance backup with
additive, non-destructive restore (skips existing accounts, downgrades
imported admins) is more polished than either. The real gap versus "mature
ops tooling" is that Cairn's backup is manual-trigger only — no schedule.
Worth a bead (below).

### 7. Notifications
Cairn's channel breadth (email/ntfy/webhook/telegram/nostr/in-app) beats
Gitea's email-only model, and its per-user-per-event-type routing + quiet
hours is more granular than Gitea offers. It falls short of Nextcloud on one
specific axis: Nextcloud lets users pick digest cadence (ASAP/hourly/daily/
weekly + separate summary email) — Cairn fires every event immediately with
no batching. This was flagged by the notification-content audit already
(**cairn-5gpv.3**, closed — "no batching/digest for burst events"). Re-reading
that bead: it covered *burst* dedup within a single delivery, not
user-configurable digest cadence as a first-class preference. That's a real,
still-open gap worth a bead if the user wants Nextcloud-level control — but
it's genuinely a "nice to have," not a "feels unfinished" gap, so it's not
included in the filed list below unless requested.

### 8. SMTP / email
Cairn's per-user SMTP override (`PER-USER-SMTP-PLAN.md`) is something neither
reference app supports at all — both are instance-admin-only, full stop.
Genuinely ahead here.

### 9. Update mechanism
Cairn has **zero** update-awareness: no version check, no "a new release is
available" notice anywhere in the admin UI. Gitea at least ships an in-app
update-checker cron job that surfaces a notice (even though the actual update
is still external). Nextcloud goes further with a real in-app updater for
non-container installs. For Cairn's actual deployment target (Umbrel/Start9,
container-based), the *update itself* will always be external — an image
pull — matching what both references fall back to for Docker anyway. But the
one-line "you're on v0.1.4, latest is v0.1.6" admin-dashboard notice costs
little and is something both references have that Cairn doesn't. Worth a
bead.

### 10. Branding
Cairn already has a fixed, polished app identity (its own logo/favicon/theme
— cairn-a77.6 and cairn-it6, both closed) which is the right call for a
single-purpose product, unlike Nextcloud/Gitea which are white-labeled by
many different operators and need admin-configurable branding as a core
feature. The one real gap: the admin-settable "operator name" only ever
surfaces on the legal-terms page (`disclosures.ts`) — it doesn't appear
anywhere in the actual app chrome (header, page title, emails). A
self-hosting operator who sets their instance's display name currently sees
it nowhere except a page most users read once. Low-effort, worth a bead.

### 11. Instance settings
Cairn already favors live-UI settings over config-file+restart (registration
mode, instance mode, connection config, notification defaults all editable
from `/admin/settings` and `/admin/notifications`) — this matches Nextcloud's
philosophy more than Gitea's `app.ini`-driven one. On par or ahead; no gap.

### 12. API access
This is Cairn's clearest deficit versus both references. Gitea has scoped
Personal Access Tokens (fine-grained read/write per resource type, since
v1.23) plus OAuth2 plus auto-generated Swagger docs at `/api/swagger`.
Nextcloud has (unscoped, but real) app passwords plus a documented OCS/WebDAV
API plus OAuth2. Cairn has **only** the browser session cookie — no API
token of any kind, so there is no way for a user to script against their own
Cairn instance (pull balances into a spreadsheet, trigger a backup from cron,
build a companion CLI) without literally replaying their session cookie. On
top of that, the internal API itself has six different response-shape
conventions (`{wallet}`, `{wallets}`, `{ok:true}`, bare passthrough, `{error}`,
`{error,code}` — noted in ARCHITECTURE-REVIEW-2026-07-06.md §8), which is a
separate, already-known problem. The token gap is new and worth filing.

### 13. Mobile responsiveness
Cairn has responsive CSS and dark mode but no PWA manifest and no native
app — same position as Gitea (no official app either). Nextcloud is ahead of
both with first-party iOS/Android apps. For a **Bitcoin wallet** specifically,
"can I check my balance from my phone without opening a desktop-shaped tab"
matters more than it would for a git host — a PWA manifest (installable,
themed status bar, home-screen icon) is a cheap step toward that and is
something neither reference app has either, so it'd be a differentiator, not
just parity. Worth a bead.

### 14. Error handling / user feedback
Cairn logs structurally (pino, contextual fields) and returns structured JSON
errors, but the internal audit found no centralized toast/banner component —
forms use hand-rolled `<div class="form-error">` elements, and there's no
consistent success/error surface app-wide. Nextcloud pairs a toast API
(`OCP.Toast`) with an admin-facing in-browser log viewer and proactive
setup-warnings; Gitea has flash messages. Cairn sits behind both on UI
consistency, though ahead structurally on the logging side. Worth a bead —
this is the one most likely to make an experienced user say "this feels
unfinished," since inconsistent error UI is directly visible on every page
that has a form.

---

## Where Cairn is genuinely ahead

- **Backup/restore**: one-click, encrypted, non-destructive, additive restore
  — neither Gitea nor Nextcloud has anything this polished.
- **Per-user SMTP override**: unique among the three.
- **Notification channel breadth + per-event routing + quiet hours**: beats
  Gitea outright, competitive with Nextcloud.
- **Live-UI instance settings**: matches Nextcloud's philosophy, better than
  Gitea's config-file-and-restart model.
- **Collaborative-custody role granularity** (owner/cosigner/viewer per
  wallet) is a finer grain than either reference app's binary admin/user
  split, applied to the thing that actually matters for a shared wallet.

## Where Cairn is genuinely behind

1. No API tokens — can't script against your own instance.
2. No update-availability notice anywhere in the admin UI.
3. No scheduled/automatic backups (manual trigger only).
4. No PWA manifest — can't "install" Cairn to a phone home screen.
5. No unified toast/error-feedback UI component — ad hoc per-form styling.
6. Admin-set operator/instance name doesn't appear anywhere in the app chrome.

---

## Beads filed

All filed under epic **cairn-ivae** ("Admin/platform gaps vs. Gitea/Nextcloud,
2026-07-06 comparison audit"):

| Bead | Priority | Summary |
|------|----------|---------|
| cairn-ivae.1 | 2 | API tokens for scripting against a user's own instance |
| cairn-ivae.2 | 3 | In-app update-availability notice in admin dashboard |
| cairn-ivae.3 | 3 | Scheduled/automatic instance backups |
| cairn-ivae.4 | 3 | PWA manifest for home-screen install |
| cairn-ivae.5 | 2 | Unified toast/error-feedback component |
| cairn-ivae.6 | 4 | Surface operator/instance name in app chrome, not just legal terms |

Not filed (already tracked elsewhere, confirmed via `.beads/issues.jsonl`):
forced first-login reset (cairn-49xi.2), plaintext notification secrets
(cairn-e9mz, closed), cross-user activity detail scoping (cairn-o1dp.5,
closed), API response-shape inconsistency (already noted in
ARCHITECTURE-REVIEW-2026-07-06.md, not re-filed here to avoid duplication —
flag separately if you want it turned into a bead).
