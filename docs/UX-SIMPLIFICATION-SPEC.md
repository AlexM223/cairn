# UX Simplification Spec — 4-Section Nav, One Settings Page, Flag-Grid Removal

**Status:** CANONICAL — this is the merged, adjudicated spec superseding the two draft passes.
**Supersedes:** `docs/UX-REDESIGN-SPEC.md` §2.7 nav decision (Home / Wallets / Activity, with
Explorer/Health/Settings/Notifications parked in the account menu) — by explicit owner directive
(Alex, 2026-07-20). Everything else in `UX-REDESIGN-SPEC.md` (screen-level content, phase 1–3
work) is unaffected.
**Visual doctrine:** `docs/DESIGN-MANIFESTO.md` is unchanged and FROZEN. Nothing here alters
color, type, motion, or disclosure-tier doctrine — only information architecture (nav, settings,
admin surface, flags).
**Inputs merged:** `ia-spec-pass-A.md` (Radical Simplicity — deletion lists, jargon table),
`ia-spec-pass-B.md` (Coherence & Safety Guardian — structure, risk register, guard conditions),
`competitor-simplicity-brief.md` (BlueWallet / Cash App / Strike study). Structure follows Pass B;
enriched with Pass A's deletion lists and jargon table and the competitor brief's applicable
rules. Where the two passes differed, the adjudicated decisions below are the ruling, encoded
verbatim from the orchestrator's brief.

---

## 0. Adjudicated decisions (verbatim ruling — overrides both passes where they differ)

1. **Nav** = dynamic `primaryNav({flags})`: Home `/`, Wallets `/wallets`, Mining `/mining` (show
   iff `flags.mining !== false`), Explorer `/explorer` (show iff `flags.explorer !== false`). Nav
   predicate must read the same resolved `locals.flags` that `requireFeature` uses. Desktop rail
   and mobile tab row identical.
2. **Activity**: removed from primary nav; Home shows a "Recent activity" block with "See all →"
   to the kept `/activity`; account menu keeps an Activity link.
3. **Gear icon** → `/settings` from top bar (mobile) and rail bottom (desktop). Account menu:
   Notifications, Activity, Health (admin only), Settings, Terms, Sign out.
4. **Delete `/admin/feature-flags`** (redirect → `/settings`). Registry/resolve/requireFeature/
   `feature_flags`/`user_feature_flags` all stay. `mining` and `explorer` become plain labeled
   toggles in `/settings` admin groups, writing the same global `feature_flags` rows. Other 23
   flags: code-only defaults (ON), no UI, still API/DB-settable. Remove the per-user flag-override
   grid from `/admin/users/[id]`; existing `user_feature_flags` rows remain honored. **Never
   silently re-enable a stored OFF deviation.**
5. **Explorer fresh-install default flips to ON** (adjust the explorer default migration for fresh
   installs only; existing installs' stored rows untouched). Mining fresh-install default stays
   OFF. Recorded as an adjudicated decision **pending Alex review**, reversible via the new
   toggle.
6. **`/settings`** single page, groups in order — personal (all users): Account, Display
   preferences, Security, Advanced (collapsed), Danger zone (collapsed); admin-only appended
   (visible only to admins, `requireAdmin` on every action, zero admin data in non-admin page
   payload): Node connection (moved wholesale from `/admin/settings` incl. Umbrel assisted-connect
   verbatim; never remove password auth), Mining (ON/OFF toggle + "Pool operator settings ›" link
   to `/admin/mining`), Explorer (ON/OFF toggle), Instance (registration mode, team features
   toggle, rows linking to Notification delivery/Announcements/Referrals/Backup/Logs, Factory
   reset last: red, typed-confirm, collapsed). `/admin/settings` → redirect stub mapping anchors.
7. **Health**: `/admin` route stays, every user-facing string says "Health" (titles too — fix
   "— Admin —" title patterns); monitoring-only hub; admin tab strip removed; remaining admin
   subpages kept (activity, users, invites, mining, notifications, announcements, referrals, logs,
   backup) reached from Health rows + Settings rows.
8. **Mining nav/route visibility** driven by instance flag ONLY; per-user mining pref stays inside
   the dashboard.
9. **First-run**: dismissible admin-only "Set up your Heartwood" card on Home (node connection
   status, enable mining, invite crew when team mode). No card for non-admins.
10. **Jargon**: merged rename table from both passes; real term survives one tap down via `<Term>`
    gloss; expander labels only "Details"/"Advanced"/"How does this work?". Sats-first stays
    (competitor fiat-first rule **REJECTED**).
11. Every moved/deleted route gets a redirect; notification deep links must resolve;
    `/explorer/tx/[txid]` stays ungated forever.
12. `MANUAL.md` + `qa:route-crawl` expected-route set updated **in the same release**; route-crawl
    is release-blocking.

---

## 1. The one-sentence model

**Two homes for everything that isn't a wallet.** Home answers "how am I doing" (balance, recent
activity, health). The gear (`/settings`) answers "how does my Heartwood work" (every knob, one
page). Nav carries only the places you *go to do a thing*: Home, Wallets, Mining, Explorer.
Monitoring (Health) and configuration (Settings) are not nav destinations — they hang off Home and
the gear, exactly where a newcomer looks.

Canonical facts this spec is built on (verified in code, Pass B):
- `requireFeature()` (`src/lib/server/api.ts:99`) reads `event.locals.flags?.[key]` →
  `resolveAllFlags(userId)` (`resolve.ts`) → registry default → global row → per-user row.
- Nav visibility today keys off the same resolved flags
  (`src/lib/nav.ts:36-37`: `flags.explorer !== false`, `flags.mining !== false`). This equivalence
  (nav-visible ⇔ route-reachable) is a load-bearing invariant — every move preserves it.
- Mining has two independent gates: the instance `mining` feature flag (gates the route + nav) and
  per-user `setUserMiningEnabled` (the user's own opt-in to run a miner; in-page state, not a nav
  gate).
- Notification/health deep-link targets in code: `/admin/users`, `/admin/users/[id]`,
  `/admin/invites`, `/admin/backup`, `/admin/settings`, `/settings`, `/wallets/[id]`,
  `/wallets/multisig/[id]` (`auth.ts`, `backup.ts`, `backupHealth.ts`, `users/+page.server.ts`,
  `api/admin/*`). None may 404 after this overhaul.
- `mining`/`explorer` currently default OFF on fresh installs
  (`miningDefaultMigration.ts` / `explorerDefaultMigration.ts`); all other 23 flags default ON.

---

## 2. Navigation

### 2.1 Primary nav becomes dynamic (2–4 items)

Replace the static `PRIMARY_NAV` in `src/lib/nav.ts` with a builder:

```ts
export function primaryNav(opts: { flags?: FeatureFlags | null }): NavItem[] {
  const flags = opts.flags ?? {};
  return [
    { href: '/', label: 'Home', icon: 'dashboard' },
    { href: '/wallets', label: 'Wallets', icon: 'wallet' },
    ...(flags.mining !== false ? [{ href: '/mining', label: 'Mining', icon: 'pickaxe' }] : []),
    ...(flags.explorer !== false ? [{ href: '/explorer', label: 'Explorer', icon: 'blocks' }] : [])
  ];
}
```

- Same list on desktop rail and mobile tab row.
- Fresh install (mining OFF, explorer ON per §6 below) → **Home / Wallets / Explorer**. Not a dead
  end — see §7 discovery.
- **`flags.mining !== false` / `flags.explorer !== false` MUST be the exact predicate
  `requireFeature` resolves to** — this keeps nav-visible ⇔ route-reachable (regression risk #1,
  see §9 R2/R5). Do not gate Mining nav on the per-user `setUserMiningEnabled` pref — that would
  hide the tab from a user who hasn't started a miner yet, breaking discovery of their own
  dashboard.
- **Active item is the only accent-colored nav element** (manifesto §2/§5) — unchanged.
- Worst case (both instance flags off) nav is Home + Wallets. That is fine and calm; first-run
  (§7) guarantees an admin can still find Mining/Explorer via Settings.

### 2.2 Activity leaves primary nav (Decision 2)

Activity is **not deleted** — its nav slot is reallocated to Mining/Explorer.
- **Home owns "Recent activity"** inline: last ~6 events, section header carries a single
  **"See all →"** link to `/activity` (full history, filters, CSV export).
- `/activity` route **stays** (deep-link + full history surface).
- Wallet-detail pages keep their own per-wallet activity link to `/activity?wallet=…`.
- Account menu keeps a secondary **Activity** link so it's reachable without scrolling Home.

Net: reachability preserved via two paths (Home + menu); one nav slot freed for the owner's
4-section model.

### 2.3 Gear icon + account menu (Decision 3)

- Gear icon in the top bar (mobile top-right) and rail bottom (desktop) → `/settings`, always
  present on every page.
- Account menu, in order: **Notifications**, **Activity**, **Health** (admin only, → `/admin`),
  **Settings** (→ `/settings`), **Terms**, **Sign out**. Delete its old Explorer/Mining entries —
  those are now nav items. Update `accountMenuLinks()` accordingly; update `src/lib/nav.test.ts`.

### 2.4 Mining nav visibility rule (Decision 8)

| Condition | Mining tab shown? | Route `/mining` |
|---|---|---|
| Instance `mining` flag resolved ON | Yes | reachable (`requireFeature` passes) |
| Instance `mining` flag resolved OFF (fresh default, or admin off) | No | 403 via `requireFeature` |
| Per-user `setUserMiningEnabled` true/false | **irrelevant to nav** | in-page dashboard state only |

Discovery path when OFF: Settings → **Mining** group (admin flips the instance toggle) → tab
appears immediately on next flag resolution. Explorer identical via its toggle. A non-admin on an
instance where the admin left mining off correctly sees nothing in nav — that is the operator's
product decision, not a discoverability bug.

---

## 3. Feature-flag teardown

### 3.1 What dies, what stays

**Delete the grid UI, keep the engine.** `registry.ts`, `resolve.ts`, `requireFeature()`, the
`feature_flags` and `user_feature_flags` tables, and `resolveAllFlags()` are all untouched. What
dies is *toggle UI*, not *resolution*. Because resolution is unchanged, any operator who
previously turned a flag OFF via the grid keeps it OFF after upgrade — no silent re-enable.

Delete `/admin/feature-flags/+page.svelte` and `+page.server.ts` outright — the single worst
"creator got lost" surface (25-row grid with no organizing structure). Route becomes a redirect
stub (see §5).

Delete the **per-user feature-flag override grid** in `/admin/users/[id]` (`overrideCountsByFlag()`
/ `overrideCount` display goes with it). Keep the `user_feature_flags` table + `resolve.ts`
per-user branch: existing override rows are still honored (no stranding); re-introducing granular
per-user control later is a code/DB task, not a data migration.

### 3.2 Flag disposition table (all 25)

| # | Flag key | New disposition | Where / label |
|---|---|---|---|
| 1 | `explorer` | **Plain admin toggle** | Settings → Explorer, "Block explorer" ON/OFF. Also drives Explorer nav item + route gate (except `tx/[txid]`, always ungated). New fresh-install default = ON (§6). |
| 2 | `mining` | **Plain admin toggle** | Settings → Mining, "Mining" ON/OFF. Drives Mining nav item + route gate. Default OFF. |
| 3 | `send` | Code-only, default ON, no UI | `requireFeature` stays; read-only-wallet mode reachable via API/DB only. |
| 4 | `multisig_create` | Code-only, default ON, no UI | same |
| 5 | `coin_control` | Code-only, default ON, no UI | same |
| 6 | `csv_export` | Code-only, default ON, no UI | same |
| 7 | `address_book` | Code-only, default ON, no UI | same |
| 8 | `qr_scan` | Code-only, default ON, no UI | same |
| 9 | `stateless_signer` | Code-only, default ON, no UI | same |
| 10 | `wallet_config_export` | Code-only, default ON, no UI | same |
| 11 | `wallet_config_import` | Code-only, default ON, no UI | same |
| 12 | `hw_trezor` | Code-only, default ON, no UI | same |
| 13 | `hw_ledger` | Code-only, default ON, no UI | same |
| 14 | `hw_coldcard` | Code-only, default ON, no UI | same |
| 15 | `hw_bitbox02` | Code-only, default ON, no UI | same |
| 16 | `hw_jade` | Code-only, default ON, no UI | same |
| 17 | `notify_email` | Code-only, default ON, no UI | Channel *availability* is code-only ON; user still chooses channels per-event at `/settings/notifications` (a separate, surviving mechanism). |
| 18 | `notify_telegram` | Code-only, default ON, no UI | same |
| 19 | `notify_ntfy` | Code-only, default ON, no UI | same |
| 20 | `notify_nostr` | Code-only, default ON, no UI | same |
| 21 | `notify_webhook` | Code-only, default ON, no UI | same |
| 22 | `announcement_banners` | Code-only, default ON, no UI | Capability reached via `/admin/announcements` (linked from Settings → Instance). Kill-switch flag is API/DB only. |
| 23 | `referral_links` | Code-only, default ON, no UI | Reached via `/admin/referral-settings` (Settings → Instance). Flag API/DB only. |
| 24 | `batch_transactions` | Code-only, default ON, no UI | unbuilt; no surface either way. |
| 25 | `fee_bumping` | Code-only, default ON, no UI | Governs "Speed up a transaction" UX; ships default-on, no admin toggle. |
| 26 | `tx_review` | Code-only, default ON, no UI | unbuilt. |

(Numbered 1–26 because the registry has 25 distinct flags plus `tx_review`; both source passes
carried this off-by-one in the same place — preserved here for traceability against the registry,
not a count of "25 flags + 1 extra.")

Only `explorer` and `mining` earn a UI control — they change what the *product is* for every user,
so an operator legitimately decides them. The other 23 are developer/restriction knobs a
non-technical self-hoster never touches; forcing a 25-row grid on them was the exact "creator got
lost" failure. They remain *settable* (requireFeature + DB deviation + API token endpoint) so no
capability is lost — they are just no longer a screen.

Both surviving toggles are admin-only, instance-wide, and **must** route through
`setGlobalFlag(key, enabled, adminId)` (`src/lib/server/featureFlags/admin.ts`) so the write is
identical to today's grid — this is what keeps `requireFeature`, nav visibility, and the stratum
listener in lockstep. Each toggle records the same `admin_feature_flag` activity event (audit
trail) the grid action did; reuse that action body, do not fork it.

### 3.3 Data safety

Any existing install that had previously flipped a flag OFF via the grid now has no UI to flip it
back for the 23 code-only flags. Ship a one-time boot reconcile that **logs** (does not auto-clear)
any non-default flag deviation, plus document the API-token path to set flags. Do **not** silently
reset deviations — that could re-enable a feature an operator deliberately disabled.

---

## 4. The one Settings page

**`/settings` is the one settings page.** Gear → `/settings`, always. It renders personal groups
for everyone; admin-config groups are appended only for `user.isAdmin` (in solo mode the sole user
is admin, so they see everything — which is the point). Keep the existing hairline-row / expander
grammar already in `settings/+page.svelte`. Extend its `+page.server.ts` load to include instance
config **only when `user.isAdmin`** (node connection state, flag states, registration, backup
recency), and gate every instance form action with `requireAdmin`.

### 4.1 Group order (adjudicated, Decision 6)

Personal groups render for all users; admin groups render only for admins and are appended after
the personal groups.

| # | Group | Visibility | Rows |
|---|---|---|---|
| 1 | **Account** | all | Profile (avatar/name/email) · Password (Umbrel password mode — **never removed**) · Notifications (→ `/settings/notifications`) |
| 2 | **Display preferences** | all | Units (BTC/sats) · Show USD estimate · Primary display (BTC-sats / Fiat, sats-first default — manifesto §3 MUST) · Theme |
| 3 | **Security** | all | Recovery · Passkeys · Devices & sessions (→ `/settings/devices`) · API tokens (→ `/settings/tokens`) · Contacts (team mode only, → `/settings/contacts`) |
| 4 | **Advanced** (collapsed) | all | Anything not promoted above — download my data, about this app. Expander label "Advanced" only. |
| 5 | **Danger zone** (collapsed, red) | all | Delete my account (typed confirm) only. Factory reset does **not** live here — see group 9. |
| 6 | **Node connection** | admin only | Moved verbatim from `/admin/settings`: Chain source (Public servers / Your own node radio) · Your node address (Electrum host/port, Advanced expander + Test connection, `?/testElectrum`) · Bitcoin Core / node RPC (address/username/password + Test connection, `?/testCore`; Umbrel auto-connect provenance banner preserved) · Privacy (route through Tor, Advanced) · Performance (simultaneous connections, Advanced, glossed). Anchor `#node-connection`. |
| 7 | **Mining** | admin only | Instance Mining toggle (ON/OFF, writes `mining` flag via `setGlobalFlag`). When ON: "Pool operator settings ›" link to `/admin/mining`. |
| 8 | **Explorer** | admin only | Block explorer toggle (ON/OFF, writes `explorer` flag via `setGlobalFlag`). |
| 9 | **Instance** (collapsed) | admin only | Registration mode + operator name · Team features toggle (unlock/hide) · User agreement editor · rows linking to: Notification delivery/SMTP (→ `/admin/notifications`) · Announcements (→ `/admin/announcements`, team) · Referrals (→ `/admin/referral-settings`) · Backup (→ `/admin/backup`) · Logs (→ `/admin/logs`) · Users & invites (→ `/admin/users`, team mode only) · Instance health (→ `/admin`). **Factory reset** (typed RESET confirm, red) is the last row of this group, anchor `#factory-reset`. |

Ordering rationale: personal groups (1–5) come first per directive item 6's literal order
(Account, Display preferences, Security, Advanced, Danger zone), then admin groups append
(Node connection, Mining, Explorer, Instance) as specified. Factory reset is instance-scoped
destruction (wipes all users, sessions, wallets, invites on the instance), not personal-scoped
destruction (deleting your own account) — putting it in group 5's Danger zone next to
delete-my-account would blur that distinction and put an instance-wide irreversible action one
tap away from a personal one for admins who are also regular users. It is instead the final row
of group 9 (Instance, admin-only), keeping it red / typed-confirm / collapsed as directed while
scoping it correctly. Anchors:
`#account #display #security #advanced #danger #node-connection #mining #explorer #instance
#factory-reset`.

Visibility by role:
- **Non-admin, team mode:** sees groups 1–5 only (account delete, no factory reset).
- **Solo mode:** the single user is admin → sees all groups; team-only rows (Contacts, Users &
  invites, Announcements) stay hidden via the existing `instanceMode` gate.

### 4.2 Server-side gating (mandatory)

- `/settings/+page.server.ts` load: gather admin-group data (chain settings, agreement, instance
  mode, chain health, flag states) **only inside `if (locals.user?.isAdmin)`**. Never ship admin
  config to a non-admin's payload.
- Every migrated admin action (`save`, `testElectrum`, `testCoreRpc`, `switchCoreRpcToManual`,
  `dismissCoreDetection`, `saveAgreement`, `lockTeamMode`, `unlockTeamMode`, `resetInstance`, the
  two flag-toggle actions) **must** call `requireAdmin(event)` first. Personal actions (`profile`,
  `password`, `deleteAccount`) keep `requireUser`. Verify no two actions share a name after the
  merge.
- `/admin/settings` becomes a redirect stub (see §5) — content is fully absorbed, not duplicated.

---

## 5. Health — admin consolidation

### 5.1 Naming (Decision 7)

The `/admin` route **stays** internally (avoids rewriting a dozen sub-route paths and their
guards) but **every user-facing string says "Health"** — nav label, `<title>`, eyebrow,
breadcrumb, and every subpage title. Fix remaining "— Admin —" `<title>` prefixes on subpages;
retitle by function ("Users", "Activity log", "Mining pool", "Notification delivery", …). There is
no "Admin" nav item or section label anywhere. Admins reach monitoring via **Health** (account
menu) and config via **Settings** (gear). URLs keep the `/admin/*` prefix purely for deep-link/
redirect stability — not renamed this pass.

### 5.2 Health's job = monitoring only

The `/admin` dashboard keeps its duty rows (Node, Backups, Storage, Users) and the status
headline. **Delete its config footer** (the "Instance settings › Feature flags · Notification
delivery · …" link strip) — that is configuration and now lives in Settings. Health is reached
from Home's health-status line and from Settings → Instance → "Instance health." It is not a nav
item and not in the avatar menu for non-admins (admin-only entry).

**Remove the admin tab strip** (`admin/+layout.svelte` `sections`/`tabs` array + `.admin-nav`).
Keep the layout shell (eyebrow breadcrumb, grove field, `hw-*` grammar) so subpages still render
consistently; the surviving admin subpages are reached contextually — from Health rows (for
monitoring) and Settings rows (for config) — not from a permanent tab row.

### 5.3 12-page disposition

| Admin page | Disposition | Reached from |
|---|---|---|
| `/admin` (Health hub) | **STAY** as Health monitoring dashboard; drop config footer; all strings say Health. | Account menu → Health |
| `/admin/activity` | **STAY** (monitoring). | Health hub; Settings → Instance → Activity log |
| `/admin/users` (team) | **STAY**; per-user flag-override grid removed. | Health hub "Users" row + Settings → Instance |
| `/admin/invites` (team) | **STAY**. | Health hub / Users |
| `/admin/mining` (operator config) | **STAY**. | Settings → Mining → "Pool operator settings ›" |
| `/admin/backup` | **STAY**. | Health hub Backups row + Settings → Instance |
| `/admin/notifications` (SMTP) | **STAY** as detail subpage. | Settings → Instance |
| `/admin/announcements` (team) | **STAY**. | Settings → Instance |
| `/admin/referral-settings` | **STAY**. | Settings → Instance |
| `/admin/logs` | **STAY** (monitoring). | Health hub + Settings → Instance |
| `/admin/settings` (node/registration/reset) | **DELETE page.** Content → Settings groups 6/9/5. | Route redirects → `/settings#node-connection` |
| `/admin/feature-flags` | **DELETE page + server.** | Route redirects → `/settings#mining` |

Net: 12 → 10 live routes; surface collapses from a 12-item tab strip + config footer down to two
clear homes (Health for monitoring, the gear for config). Only 2 pages actually delete.

---

## 6. Fresh-install flag defaults — Explorer flips ON (Decision 5, PENDING ALEX CONFIRMATION)

Today both `mining` and `explorer` default OFF on fresh installs, hiding both headline features
behind the (now-deleted) hardest page.

- **Explorer defaults ON for fresh installs.** Adjust `explorerDefaultMigration.ts` so the
  fresh-install default flips ON. Rationale: the own-node explorer is the sovereignty payoff
  (manifesto), needs zero operator config, and its tx-detail is already app-wide — nothing to set
  up, high showcase value, low newcomer risk. **Existing installs are unaffected** — the migration
  touches fresh installs only; their stored value stands.
- **Mining stays OFF** on fresh installs — it needs a stratum port + hardware setup a brand-new
  saver shouldn't meet before adding a wallet.
- This is recorded as an **adjudicated decision pending Alex review** (see §10, decision-queue
  addendum) — reversible at any time via the new Settings → Explorer toggle, so shipping it ahead
  of formal ratification carries low risk.
- **Settings → Explorer / Mining always list both toggles**, so they are re-findable via the gear
  forever regardless of default.

---

## 7. First-run & showcase discoverability (Decision 9)

**Dismissible admin-only "Set up your Heartwood" card on Home.** Non-admins never see it. Content:
- Node connection status (link into Settings → Node connection if not yet configured).
- Enable mining (one-line value prop + Enable button; flips `mining` ON via the same
  `setGlobalFlag` path as the Settings toggle, deep-links to Configure).
- Invite crew — **only shown when team mode is active/available** (per directive: "invite crew
  when team mode").

Dismiss or complete an item → card state persists (does not nag). This surfaces the showcase
features on Home, where a newcomer looks, without cluttering the calm default for everyone else.
Discovery for the admin who dismissed it, or for a non-admin, is permanent: Settings → Mining /
Explorer groups are always present and re-findable.

---

## 8. Jargon rename table (Decision 10 — merged from both passes)

Rule: rename the surface label; keep the real term reachable one tap down via a `<Term>` /
"How does this work?" gloss. Never delete the capability or the true word. Expander labels are
restricted to **"Details" / "Advanced" / "How does this work?"** — no other expander copy.
**Sats-first stays the default** (manifesto §3 MUST); the competitor brief's fiat-first framing
rule is explicitly **rejected** for Heartwood's primary balance/amount surfaces — bitcoin-first
display is the single most load-bearing rule in the design manifesto and is out of scope for this
IA pass.

| Hotspot (old) | New surface label | Term gloss keeps | Notes |
|---|---|---|---|
| Bitcoin Core RPC | **Your Bitcoin node** | "Bitcoin Core RPC" | |
| RPC URL | **Node address** | "RPC URL" | |
| RPC username / RPC password | **Node username / Node password** | — | + "How does this work?" gloss |
| Electrum (as chain backend choice) | **Chain source: Public servers / Your own node** | "Electrum" | Word "Electrum" only inside a Details gloss |
| Electrum server (host/port row) | **Your node address** | "Electrum server" | Advanced expander |
| SOCKS5 / Tor proxy | **Privacy — route through Tor** | "SOCKS5" | |
| Parallel connections / connection pool size | **Performance — simultaneous connections** | — | Advanced, glossed |
| Stratum (miner endpoint) | **Miner connection address** | "stratum" | |
| stratum port | **Miner connection port** | "stratum" | |
| ASIC / ASIC port | **Hardware miner / Hardware miner port** | — | |
| shareDifficulty | **Starting difficulty / Share difficulty** | — | Advanced |
| vardiff | **Automatic difficulty** | "vardiff" | |
| authorityPubkey (SV2) | **Server identity key / Pool identity key** | "authority pubkey / SV2" | Advanced, glossed |
| Stateless / airgapped signer | **Sign with QR codes or a file / Sign offline** | "air-gapped / stateless signer" | |
| Caravan-format (config) | **Wallet backup file** | "Caravan format" | "Caravan-compatible" one tap down |
| RBF / CPFP / fee bumping | **Speed up a transaction** | "RBF / CPFP" | |
| Coin control / UTXO | **Choose which coins to spend** | "coin control / UTXO" | Advanced |
| PSBT | **Unsigned transaction (file)** | "PSBT" | |
| xpub / extended public key | **Wallet public key** | "xpub" | Glossed |
| sat/vB | **Fee rate** | "sat/vB" | |
| descriptor | **Wallet definition** | "descriptor" | |
| multisig (first mention) | **Shared wallet** (multisig) | "multisig" | |
| mining ID | **Your mining ID** | — | Fine as-is; keep |
| Feature flags | *(term retired — grid page deleted)* | — | Engine terminology stays internal/code-only |

Consistency guard: a term glossed in one place must not appear un-glossed and authoritative in
another tier of the same flow. Audit Node-connection, Mining operator, and Send flows as the three
densest jargon zones (per Pass B).

---

## 9. Route disposition table (Decision 11 — no 404s, every deep link resolves)

| Route | Disposition |
|---|---|
| `/` | KEEP — add Recent-activity block + "See all →", health-status line → `/admin`, first-run card (admin only). |
| `/wallets`, `/wallets/**` | KEEP unchanged. |
| `/activity` | KEEP route; removed from primary nav; reached from Home + account menu. |
| `/mining`, `/mining/pool` | KEEP; gated by instance `mining` flag; nav item when ON; `requireFeature('mining')` unchanged. |
| `/explorer`, `/explorer/{address,block,difficulty,mempool}/**` | KEEP; gated by `explorer` flag; nav item when ON. Default flips ON for fresh installs (§6). |
| `/explorer/tx/[txid]` | KEEP — **stays ungated app-wide, forever.** Reached contextually from wallet activity even when `explorer` is OFF. Gate must be applied per-route, not at a parent layout, and must exempt this path explicitly. |
| `/settings` | KEEP — becomes the single settings page (§4). Anchors: `#account #display #security #advanced #danger #node-connection #mining #explorer #instance #factory-reset`. |
| `/settings/{notifications,devices,tokens,contacts}` | KEEP as detail subpages, reached from `/settings` rows; `contacts` stays team-mode gated. |
| `/admin` | KEEP as Health dashboard (monitoring); drop config footer; relabel all "Admin" strings → "Health". |
| `/admin/{activity,users,invites,mining,backup,notifications,announcements,referral-settings,logs}` | KEEP routes; remove the tab strip; reach contextually from Health hub rows / Settings rows; team-only ones stay 404-in-solo. |
| `/admin/users/[id]` | KEEP — remove the per-user flag-override grid only; page and notification deep link stay. |
| `/admin/settings` | **DELETE page** → `redirect(307, '/settings#node-connection')` (also map `#registration`→`#instance`, `#factory-reset`→`#factory-reset`). |
| `/admin/feature-flags` | **DELETE page + `+page.server.ts`** → `redirect(307, '/settings#mining')`. |
| `/health` | OPTIONAL future alias → `redirect(308, '/admin')`. Not required this pass. |

Implement redirects as tiny `+page.server.ts` `load` functions throwing `redirect(307, …)` at the
old paths, so bookmarks and in-the-wild links resolve. Internal link sources to update in the same
PR (redirects are a safety net, not the primary path): `backupHealth.ts`
(`/admin/settings`→`/settings#node-connection`), Home/Health node-error link
(`/admin/settings#node-connection`→`/settings#node-connection`), Health footer (feature-flags link
removed; settings links repointed).

---

## 10. What we delete (net removals)

- **`/admin/feature-flags`** page + `+page.server.ts` (the 25-flag grid) — the single worst
  "creator got lost" surface.
- **The per-user feature-flag override grid** UI (generated from the registry) — gone from
  `/admin/users/[id]`.
- **`/admin/settings`** as a standalone page — content absorbed into `/settings`.
- **The admin tab strip** (`admin-nav` in `admin/+layout.svelte`) — the persistent 6-tab row.
- **The Health page's config footer link-strip** (`admin/+page.svelte` `.instance .foot-links`).
- **Activity from primary nav** (route kept).
- **Explorer / Mining / Health entries in the old avatar account-menu shape** — replaced by nav
  items (Mining/Explorer), the gear (Settings), and Home's health line / admin-only Health link.
- **~20 jargon labels** on the surface (moved behind `<Term>` glosses, not deleted as capability).

**Not deleted** (explicit): `requireFeature()`, `registry.ts`, the flag-resolution engine, the
`mining_prefs` per-user mechanism, per-user notification prefs, every surviving admin route's
underlying capability, all wallet capabilities (coin control, RBF, stateless signing, Caravan
import/export) — all reachable, just renamed/relocated.

---

## 11. Risk register + guard conditions

| # | Move | Regression risk | Mitigation / guard condition |
|---|---|---|---|
| R1 | Merge admin config into `/settings` | Non-admin sees/triggers admin data or actions | Load admin data only under `if (locals.user?.isAdmin)`; every migrated action calls `requireAdmin()` first. Test: GET `/settings` as regular user has no chain/agreement/registration/flag fields in payload; POST each admin action as non-admin → 403. |
| R2 | Kill flags grid | `requireFeature` weakened / diverges from nav | registry+resolve+requireFeature untouched. Mining/Explorer toggles write via `setGlobalFlag` (same rows). Guard: extend `nav.test.ts` asserting tab-present ⇔ `flags.x !== false`; add a test that toggling the Settings mining switch flips `resolveAllFlags().mining` and thus `requireFeature('mining')`. |
| R3 | Delete `/admin/feature-flags`, redirect `/admin/settings` | Notification/health deep links 404 | No deleted route is a link target; both get 307 redirect stubs. Guard: assert every `link:`/`href:` admin path in code (users, users/[id], invites, backup, settings) resolves non-404; add these to the route-crawl expected set. |
| R4 | Move Core RPC / Umbrel assisted-connect into `/settings` | Umbrel env reconcile-on-boot provenance breaks; password auth accidentally dropped | Move the Node-connection `<section>` + its actions **verbatim** (keep `UMBREL_CORE_RPC_URL/USER` constants, `coreRpcProvisionedBy` logic, `switchCoreRpcToManual`/`dismissCoreDetection`). Password form in Account group stays — never remove password auth (Umbrel needs it). Guard: manual Umbrel smoke test (s15) of assisted-connect after the move; verify `#node-connection` anchor still lands. |
| R5 | Promote Mining/Explorer to primary nav | User sees a tab that 403s, or hidden tab strands a reachable route | Nav predicate === `requireFeature` predicate (R2). Do NOT gate Mining nav on `setUserMiningEnabled`. Guard: e2e — flag OFF ⇒ no tab AND route 403; flag ON ⇒ tab AND route 200. |
| R6 | Explorer nav hidden when flag OFF | `/explorer/tx/[txid]` (ungated app-wide tx detail) becomes unreachable | tx detail is reached contextually (wallet tx row, activity), not the Explorer tab — hiding the tab is fine. Guard: verify explorer `+layout.server` gate exempts `tx/[txid]`; add a test that `/explorer/tx/[txid]` loads with `explorer` flag OFF. |
| R7 | Remove per-user override UI | Existing per-user restrictions silently lost | Keep `user_feature_flags` table + resolve.ts per-user branch. Existing rows still honored. Guard: migration is UI-only; add a test that a pre-existing `user_feature_flags` row still forces `requireFeature` closed. |
| R8 | Remove admin tab strip + fold Activity out of primary | Admin/Activity becomes hard to find | Health hub body + breadcrumb provide admin nav; Activity on Home + account menu. Guard: reachability test — Activity and each kept admin page reachable in ≤2 taps from Home. |
| R9 | Solo-mode walls | Settings renders rows to team-only pages that 404 in solo | Gate Users/Invites/Contacts rows on `instanceMode === 'team'` (reuse `showContactsRow`, layout's team filter). Team-features toggle stays in Instance group. Guard: solo-mode test — no link to `/admin/users`, `/admin/invites`, `/settings/contacts`. |
| R10 | Consistency mandate | Node status shown authoritatively on both Health hub and Settings | Division of labor: Health = read-only **status**; Settings Node connection = **config**. Don't duplicate the same editable detail in two tiers. Guard: design review of Health vs Settings node rows. |
| R11 | Release gate | `qa:route-crawl` + MANUAL.md Part II break on deleted/redirected routes | Update MANUAL.md Part II runbook + the route-crawl expected/allowlist set in the SAME PR (deletions, redirects, new nav conditions). This is release-blocking (v0.2.41 introduced the crawl gate). Guard: crawl passes with redirect assertions. |
| R12 | Marketing/notify flags now code-only | `/admin/announcements` or referral UI unexpectedly dark | Those flags default ON and stay ON (no UI to turn off); pages remain reachable. Guard: confirm `announcement_banners`/`referral_links` resolve ON post-migration. |
| R13 | Flag-deviation orphans (data safety) | Deleting the grid strands any install that previously turned a flag OFF, with no UI to reverse for code-only flags | Do NOT auto-reset deviations (would re-enable a deliberately-disabled feature). Ship a boot-time log of non-default deviations + documented API-token path to set flags. Verify on a copy of a real Umbrel DB before shipping. |
| R14 | Explorer default flip (§6) | Existing installs' stored OFF value gets clobbered by the new fresh-install default | Migration must be scoped to fresh installs only (no existing `feature_flags` row for `explorer`); never overwrite a present row. Guard: test that an install with an existing explorer row (either value) is untouched by the migration; only a brand-new DB gets the ON default. |

---

## 12. Implementation wave plan (risk-ordered)

**W1 — Nav + gear.** `src/lib/nav.ts` dynamic `primaryNav()` builder + `accountMenuLinks()` trim +
gear icon in top bar (mobile) / rail bottom (desktop) + `nav.test.ts` updates. Activity moves to
Home "Recent activity" block + "See all →" + account menu link. Low risk, unblocks the visible
model; addresses R5, R8 groundwork.

**W2 — Settings merge, toggles, flag-grid deletion.** Add Mining/Explorer toggles to `/settings`
wired to `setGlobalFlag` (verify R2/R5 before deleting the grid). Delete `/admin/feature-flags` +
add redirect stub; remove the Health-footer feature-flags link; remove the per-user override grid
from `/admin/users/[id]` (R7). Merge `/admin/settings` → `/settings` admin groups verbatim
(heaviest single step; R1/R4) — move Node connection section, Instance section, Factory reset;
gate every load and action; add `/admin/settings` redirect stub. This is the highest-risk wave —
do not proceed to W3 until R1–R4/R7 guards pass.

**W3 — Health consolidation, first-run card, explorer default flip.** Remove the admin tab strip
(`admin/+layout.svelte`); relabel all "Admin" strings → "Health"; drop the Health config footer.
Build the dismissible admin-only "Set up your Heartwood" first-run card on Home (§7). Flip the
explorer fresh-install default (§6, R14 guard — scoped to fresh installs only). Addresses R8–R10,
R14.

**W4 — Jargon sweep.** Apply the §8 rename table across Node connection, Mining operator, and Send
flows (the three densest jargon zones) plus any remaining surfaces. Enforce expander-label
restriction ("Details"/"Advanced"/"How does this work?" only). Consistency-guard audit: no term
glossed in one place and bare in another tier of the same flow.

**W5 — MANUAL.md + route-crawl + docs.** Update `MANUAL.md` Part II runbook and the
`qa:route-crawl` expected/allowlist route set for every deletion, redirect, and new nav condition
(R11 — release-blocking). Final full route-crawl pass + browser QA (desktop + mobile 375×812) +
Umbrel s15 smoke test of the moved Node-connection assisted-connect flow (R4 guard).

---

## 13. Frozen-rail compliance check

- Sats-first default preserved (Display preferences group untouched, manifesto §3 MUST). ✓
- One accent, one primary button per screen — first-run card uses one Enable primary per row;
  Settings groups use expanders, not competing buttons. ✓
- 3-tier disclosure — Advanced/Details expanders only; jargon glossed one tap down. ✓
- No rebrand / identity change; green stays growth-only. ✓
- No capability deleted — every renamed/hidden feature stays reachable (UI, subpage, or API). ✓
- Competitor fiat-first framing rule explicitly rejected for primary balance/amount surfaces (§8). ✓
