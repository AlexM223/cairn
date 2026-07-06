# Cairn Feature Flags — Implementation Plan

Epic: let the admin toggle features on/off instance-wide, with per-user
overrides in either direction, so an operator can run Cairn in a
restricted "read-only for most, full access for a few" posture (or the
inverse — lock a feature down for one flagged account while everyone else
keeps it). Full flag list is illustrative and expected to grow as new
features ship (batch transactions, CPFP, private mempool/tx review are
already reserved below even though unbuilt).

## 0. What already exists (read this before building anything)

No feature-gating-by-toggle exists today. What *does* exist, and what this
plan reuses or mirrors:

- **`settings` table** (`src/lib/server/db.ts:71-74`, read/write via
  `getSetting`/`setSetting` in `src/lib/server/settings.ts`) — instance-wide
  key/value config (registration mode, chain backend, SMTP host, etc). This
  is the pattern for *global* settings, but it's a flat key/value store with
  no per-row metadata and no per-user dimension — not reused directly (see
  §1.3 for why flags get their own tables instead).
- **`notification_preferences` / `notification_channel_config`**
  (`db.ts:544-567`) — the closest existing precedent for "per-user row,
  absence means inherit a default." `getEffectivePreferences()` in
  `src/lib/server/notifications.ts` overlays saved rows over
  `DEFAULT_PREFERENCES`. The flag resolution engine in §3 follows the same
  shape: a row's *absence* is meaningful, not an error.
  Two behavioral differences worth naming: (1) that system has no *global*
  layer, only per-user rows over hardcoded defaults, whereas flags add a
  hardcoded default AND a global admin-set layer AND a per-user layer; (2)
  flags need a single boolean per-user override, not per-channel routing.
- **Collaborative-custody 3-tier access** (`src/lib/server/wallets/multisig.ts`
  — `getMultisig`/`getViewableMultisig`/`getSignableMultisig`) — the
  precedent for "resolve access with a small pure function, call it at the
  top of every route that needs the gate, reject before touching data."
  `requireFeature()` in §3.3 follows this shape via a helper next to the
  existing `requireUser`/`requireAdmin` in `src/lib/server/api.ts:6-16`.
- **`event.locals.user`** (`src/hooks.server.ts:70`, populated by
  `getSessionUser()` in `src/lib/server/auth.ts:48-79`) — the per-request
  injection point. Resolved flags get attached here the same way (§3.2).
- **Admin panel shape** — `/admin/settings` and `/admin/notifications` are
  each their own route with their own `+page.server.ts` load/actions. Flags
  get the same treatment: a new `/admin/feature-flags` page, not a section
  bolted onto `/admin/settings` (that page is already a long form).
- **`/admin/users`** (`src/routes/(app)/admin/users/`) is currently a flat
  list with inline promote/demote/enable/disable actions — there is no
  per-user detail route yet. This plan adds one (`/admin/users/[id]`, §4.2)
  because a 20+ row override grid doesn't fit in a table row.

## 1. Design decisions

### 1.1 What gets flagged — a code registry, not a DB table

The list of flags lives in code as a typed array, not in the database. The
database only stores *deviations from the registry's default*. This is
what makes "add a new flag" a one-line code change with no migration:

```typescript
// src/lib/server/featureFlags/registry.ts
export interface FeatureFlagDef {
	key: string;                 // stable id, referenced in code and DB — never rename, only deprecate
	label: string;               // admin toggle-grid label
	description: string;         // admin-facing helper text (what turning this off actually does)
	category: 'wallet' | 'hardware' | 'notifications' | 'upcoming';
	userMessage: string;         // shown to the end user when the resolved value is false
	defaultEnabled: true;        // literal `true` — a flag can never ship pre-disabled (see §7)
}

export const FEATURE_FLAGS: FeatureFlagDef[] = [
	// wallet
	{ key: 'send', category: 'wallet', label: 'Send / spend',
	  description: 'Build and broadcast outgoing transactions. Off = read-only wallet.',
	  userMessage: 'Sending has been disabled by your administrator.', defaultEnabled: true },
	{ key: 'multisig_create', category: 'wallet', label: 'Create multisig wallets',
	  description: 'Off = user can still use/sign existing multisig wallets shared with them, but cannot create new ones (single-sig only).',
	  userMessage: 'Creating multisig wallets has been disabled by your administrator.', defaultEnabled: true },
	{ key: 'coin_control', category: 'wallet', label: 'Coin control',
	  description: 'Manual UTXO selection in the send flow.',
	  userMessage: 'Coin control has been disabled by your administrator.', defaultEnabled: true },
	{ key: 'csv_export', category: 'wallet', label: 'CSV export',
	  description: 'Transaction history export.',
	  userMessage: 'CSV export has been disabled by your administrator.', defaultEnabled: true },
	{ key: 'address_book', category: 'wallet', label: 'Address book',
	  description: 'Saved recipient contacts.',
	  userMessage: 'The address book has been disabled by your administrator.', defaultEnabled: true },
	{ key: 'qr_scan', category: 'wallet', label: 'Camera / QR scanning',
	  description: 'Scanning addresses, PSBTs, and descriptors with the device camera.',
	  userMessage: 'Camera scanning has been disabled by your administrator.', defaultEnabled: true },
	{ key: 'stateless_signer', category: 'wallet', label: 'Stateless / airgapped signer',
	  description: 'QR- and file-based PSBT signing (device_type "qr"/"file") for users without a supported USB device.',
	  userMessage: 'Airgapped signing has been disabled by your administrator.', defaultEnabled: true },
	{ key: 'wallet_config_export', category: 'wallet', label: 'Export wallet config',
	  description: 'Download Caravan-format wallet config / backup file.',
	  userMessage: 'Exporting wallet configs has been disabled by your administrator.', defaultEnabled: true },
	{ key: 'wallet_config_import', category: 'wallet', label: 'Import wallet config',
	  description: 'Import an existing Caravan-format wallet config.',
	  userMessage: 'Importing wallet configs has been disabled by your administrator.', defaultEnabled: true },
	{ key: 'explorer', category: 'wallet', label: 'Block explorer',
	  description: 'In-app address/tx explorer view.',
	  userMessage: 'The explorer has been disabled by your administrator.', defaultEnabled: true },

	// hardware — one per driver in src/lib/hw/
	{ key: 'hw_trezor', category: 'hardware', label: 'Trezor', description: '', userMessage: 'Trezor support has been disabled by your administrator.', defaultEnabled: true },
	{ key: 'hw_ledger', category: 'hardware', label: 'Ledger', description: '', userMessage: 'Ledger support has been disabled by your administrator.', defaultEnabled: true },
	{ key: 'hw_coldcard', category: 'hardware', label: 'Coldcard', description: '', userMessage: 'Coldcard support has been disabled by your administrator.', defaultEnabled: true },
	{ key: 'hw_bitbox02', category: 'hardware', label: 'BitBox02', description: '', userMessage: 'BitBox02 support has been disabled by your administrator.', defaultEnabled: true },
	{ key: 'hw_jade', category: 'hardware', label: 'Jade', description: '', userMessage: 'Jade support has been disabled by your administrator.', defaultEnabled: true },

	// notifications — one per NOTIFICATION_CHANNELS entry (in-app is baseline, never flagged)
	{ key: 'notify_email', category: 'notifications', label: 'Email channel', description: '', userMessage: 'Email notifications have been disabled by your administrator.', defaultEnabled: true },
	{ key: 'notify_telegram', category: 'notifications', label: 'Telegram channel', description: '', userMessage: 'Telegram notifications have been disabled by your administrator.', defaultEnabled: true },
	{ key: 'notify_ntfy', category: 'notifications', label: 'ntfy channel', description: '', userMessage: 'ntfy notifications have been disabled by your administrator.', defaultEnabled: true },
	{ key: 'notify_nostr', category: 'notifications', label: 'Nostr channel', description: '', userMessage: 'Nostr notifications have been disabled by your administrator.', defaultEnabled: true },
	{ key: 'notify_webhook', category: 'notifications', label: 'Webhook channel', description: '', userMessage: 'Webhook notifications have been disabled by your administrator.', defaultEnabled: true },

	// upcoming — features not built yet; the flag ships with the epic, not after
	{ key: 'batch_transactions', category: 'upcoming', label: 'Batch transactions', description: '', userMessage: 'Batch transactions have been disabled by your administrator.', defaultEnabled: true },
	{ key: 'fee_bumping', category: 'upcoming', label: 'RBF / CPFP fee bumping', description: 'Tracks docs/CPFP-UNCONFIRMED-PLAN.md (cairn-u9ob).', userMessage: 'Fee bumping has been disabled by your administrator.', defaultEnabled: true },
	{ key: 'tx_review', category: 'upcoming', label: 'Private mempool / tx review', description: '', userMessage: 'This feature has been disabled by your administrator.', defaultEnabled: true }
];
```

`defaultEnabled: true` is typed as the literal `true`, not `boolean` — a
flag that defaults off doesn't type-check. This makes §7 (migration safety)
a compiler guarantee instead of a code-review convention.

Adding a flag: append one object above and add the enforcement call site(s)
where it applies (§3.3). No migration, no admin-UI change — the toggle grid
and per-user override grid are both generated from this array.

### 1.2 Resolution semantics

Three states are stored per level (global, per-user); absence at either
level means "inherit":

| Global row | User row | Resolved |
|---|---|---|
| absent (→ default `true`) | absent | **true** |
| `true` | absent | **true** |
| `false` | absent | **false** |
| `true` | `false` | **false** (admin restricts this one user) |
| `false` | `true` | **true** (admin explicitly grants this one user an exception) |

**Decision: a per-user override wins in either direction, not just
"restrict."** The task brief's own example ("global OFF, user override ON
→ ON for that user") is a real requirement, not just a hypothetical: an
admin who's turned off `multisig_create` instance-wide should still be able
to grant it to one trusted power user without flipping the global switch
for everyone. The alternative — global OFF = hard off, no override
possible — was considered and rejected because it can't express that case
and would need a *second* flag concept (a "locked" bit) to claw back the
flexibility. One override table with symmetric semantics covers both
"restrict a user" and "grant an exception" without extra state.

One flag-level escape hatch is worth keeping for later, not building now:
`FeatureFlagDef.allowUserOverride` could default `true` and let a future
flag opt out of per-user overrides entirely (global-only). Nothing in the
current list needs it — skip it in Unit 1 and add it if a real flag needs
it, rather than designing for a hypothetical.

### 1.3 Storage: two dedicated tables, not the `settings` key/value store

Two new tables, modeled on the `notification_preferences` /
`notification_channel_config` split (one global-ish concept, one per-user
concept, same key naming):

```sql
CREATE TABLE IF NOT EXISTS feature_flags (
	key        TEXT PRIMARY KEY,
	enabled    INTEGER NOT NULL,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS user_feature_flags (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	key        TEXT NOT NULL,
	enabled    INTEGER NOT NULL,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_by INTEGER REFERENCES users(id),
	UNIQUE (user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_user_feature_flags_user ON user_feature_flags(user_id);
```

Why not reuse `settings` (prefix keys like `feature_flag.send`) or a JSON
column on `users`:

- **Enumerability.** The admin UI needs "list every flag that has an
  override, and for user-overrides, how many users." `SELECT key, enabled
  FROM feature_flags` and `SELECT key, COUNT(*) FROM user_feature_flags
  GROUP BY user_id` are direct queries. Doing the same against a
  `LIKE 'feature_flag.%'` scan of the generic settings table, or against a
  JSON blob per user, means parsing JSON in application code (or SQLite
  `json_each`) just to answer "does this user have any overrides" — the
  exact query the users-list badge (§4.2) needs on every page load.
- **`updated_by`/`updated_at` per flag.** Worth having for an admin action
  this consequential (silently disabling someone's ability to send); a
  JSON blob would need to carry that per-key, which is awkward in JSON and
  trivial as a column.
- Matches the codebase's existing convention of a dedicated table per
  distinct per-user concern (`notification_preferences`,
  `notification_channel_config`, `user_pgp_keys`) rather than a catch-all
  JSON bucket.

Following `db.ts`'s existing convention, both tables are created inline in
`db.ts` in a guarded `CREATE TABLE IF NOT EXISTS` block — no separate
migration files in this codebase.

## 2. Server-side: resolution engine

```typescript
// src/lib/server/featureFlags/resolve.ts
import { db } from '../db';
import { FEATURE_FLAGS, FEATURE_FLAGS_BY_KEY } from './registry';

function globalEnabled(key: string): boolean {
	const def = FEATURE_FLAGS_BY_KEY.get(key);
	if (!def) throw new Error(`Unknown feature flag: ${key}`);
	const row = db.prepare('SELECT enabled FROM feature_flags WHERE key = ?').get(key) as
		| { enabled: number }
		| undefined;
	return row ? row.enabled === 1 : def.defaultEnabled;
}

/** Resolve one flag for one user (or `null` for a logged-out/system context, which gets the global value). */
export function isFeatureEnabled(key: string, userId: number | null): boolean {
	if (userId == null) return globalEnabled(key);
	const row = db
		.prepare('SELECT enabled FROM user_feature_flags WHERE user_id = ? AND key = ?')
		.get(userId, key) as { enabled: number } | undefined;
	return row ? row.enabled === 1 : globalEnabled(key);
}

/** Resolve every registered flag for a user in one pass — this is what gets attached to event.locals. */
export function resolveAllFlags(userId: number | null): Record<string, boolean> {
	const globals = new Map(
		(db.prepare('SELECT key, enabled FROM feature_flags').all() as { key: string; enabled: number }[])
			.map((r) => [r.key, r.enabled === 1])
	);
	const overrides =
		userId == null
			? new Map<string, boolean>()
			: new Map(
					(
						db
							.prepare('SELECT key, enabled FROM user_feature_flags WHERE user_id = ?')
							.all(userId) as { key: string; enabled: number }[]
					).map((r) => [r.key, r.enabled === 1])
				);
	const out: Record<string, boolean> = {};
	for (const def of FEATURE_FLAGS) {
		out[def.key] = overrides.get(def.key) ?? globals.get(def.key) ?? def.defaultEnabled;
	}
	return out;
}
```

Deliberately synchronous, not `async` — Cairn's `node:sqlite` `DatabaseSync`
is synchronous everywhere else (`getSetting`, `getSessionUser`, etc); the
brief's `await featureEnabled(...)` sketch is illustrative, not a hard
requirement, and adding `async` here would be the one inconsistent call
site in the server codebase.

An unknown key throws rather than silently resolving `true`/`false` — a
typo'd flag key at a call site should fail loudly in dev/CI, not silently
grant or deny a feature in production.

### 2.1 Per-request attachment

`src/hooks.server.ts` resolves once per request, right after `locals.user`
is set (line ~70), and both the root layout and any route guard reuse the
same resolved object instead of re-querying:

```typescript
event.locals.user = getSessionUser(event.cookies.get(SESSION_COOKIE));
event.locals.flags = resolveAllFlags(event.locals.user?.id ?? null);
```

`src/routes/(app)/+layout.server.ts` adds `flags: locals.flags` to its
return value alongside `user`, next to the existing disclosure/recovery/backup
gates. The client reads `data.flags` (or `$page.data.flags` where `data`
isn't already threaded through) — no new store or context wrapper, matching
how `data.user.isAdmin` is read directly today (no `useAuth()`-style hook
exists in this codebase, so this doesn't invent one).

### 2.2 Server-side enforcement

A new guard next to `requireUser`/`requireAdmin` in `src/lib/server/api.ts`:

```typescript
export function requireFeature(event: RequestEvent, key: string): void {
	const user = requireUser(event);
	if (!(event.locals.flags?.[key] ?? isFeatureEnabled(key, user.id))) {
		error(403, FEATURE_FLAGS_BY_KEY.get(key)!.userMessage);
	}
}
```

Called at the top of every route/action that performs a gated action —
e.g. the send-transaction API route calls `requireFeature(event, 'send')`
before touching PSBT construction, exactly where `requireAdmin` is called
today for admin-only routes. **This is the actual enforcement boundary.**
The UI hiding a button (§5) is a courtesy; the 403 here is what makes the
flag real. Every flag in the registry needs its enforcement call site(s)
identified and wired as part of Unit 6 (§8) — this doc lists the known
ones per flag in Unit 6's description, but the sweep should treat that list
as a starting point, not exhaustive.

## 3. Admin UI

### 3.1 Global flags — `/admin/feature-flags` (new page)

Own route, same shape as `/admin/notifications`: `+page.server.ts` loads
`FEATURE_FLAGS` plus current `feature_flags` rows plus, per flag, a count
of per-user overrides (`SELECT key, COUNT(*) FROM user_feature_flags GROUP
BY key`); `+page.svelte` renders a toggle grid grouped by `category`, one
form action per flag (`?/toggle` with `key`/`enabled` fields, mirroring the
`userAction()` pattern in `admin/users/+page.server.ts:10-23`). A flag row
with >0 overrides shows a small "3 user overrides" badge linking to a
filtered view (or just noting the count — exact affordance is a UI-polish
call for whoever builds Unit 3).

### 3.2 Per-user overrides — new `/admin/users/[id]` detail page

`/admin/users` has no per-user detail route today (§0) — this plan adds
one, since a 20+ row tri-state grid doesn't fit inline in a table row.
`+page.server.ts` loads the user, `resolveAllFlags(userId)`, and which keys
have an explicit row in `user_feature_flags` (to distinguish "inheriting
global" from "explicitly set to the same value as global" in the UI — both
resolve to the same boolean but the admin should be able to tell them
apart, and to clear an explicit override back to "inherit"). Each flag row
gets a 3-way control: **Inherit** (delete the override row) / **Force on**
/ **Force off**.

The existing `/admin/users` list page (`+page.svelte:39-88`) gets one more
cell: a badge showing override count for that user (0 → nothing shown, or
a muted "—"; >0 → e.g. `2 overrides`), linking to `/admin/users/[id]`. This
is the "visual indicator when a user has overrides that differ from
global" the brief asks for — it belongs on the list (where an admin scans
many users at once), not just the detail page.

## 4. End-user UX

- **Hide, don't grey, where feasible.** A nav link or page a user can't use
  at all (e.g. `/explorer` when `explorer` is off) should be absent from
  the nav, not a disabled-looking link that begs to be clicked. This
  matches the existing admin-nav-item pattern
  (`+layout.svelte:15` — the Admin nav entry is conditionally *absent* for
  non-admins, not shown-disabled).
- **Grey + message for in-context actions.** A button reachable mid-flow
  (e.g. "Send" inside a wallet the user can otherwise fully view) is
  disabled with a tooltip/inline note using `FeatureFlagDef.userMessage`
  ("Sending has been disabled by your administrator.") rather than
  vanishing, since its absence there would look like a bug rather than a
  policy.
- **Users never see flag names, categories, or the concept of "global vs.
  override."** Only the effect (feature present/absent) and, where shown,
  the one generic sentence from `userMessage`.
- **Server-side is the real gate (§2.2) regardless of what the client
  renders** — a stale client bundle, a direct API call, or a UI bug that
  fails to hide something must not grant access the resolved flags deny.

## 5. Developer experience

Two call shapes cover everything:

```typescript
// In a load function or action, to decide what to render/allow:
import { isFeatureEnabled } from '$lib/server/featureFlags/resolve';
if (!isFeatureEnabled('coin_control', locals.user.id)) { /* omit the UTXO picker from returned data */ }

// At the top of a route/action that performs the gated action — the actual enforcement:
import { requireFeature } from '$lib/server/api';
requireFeature(event, 'send');
```

On the client, `data.flags.send` (boolean) — no `useFeatureFlags()` hook,
matching the codebase's existing no-hook, `data`-prop convention (§2.1).

## 6. Migration path

`defaultEnabled: true` is a literal type (§1.1) — a flag cannot ship
pre-disabled, so it's impossible for a code change alone to regress an
existing installation. On upgrade, `feature_flags` and `user_feature_flags`
both start empty (fresh `CREATE TABLE IF NOT EXISTS`, same as every other
table in `db.ts`); with no rows, every flag resolves to its registry
default, `true`, for every user. Nothing changes for any existing instance
until an admin explicitly visits `/admin/feature-flags` and flips
something. No backfill, no opt-in migration step needed.

## 7. Units of work

1. **Schema + registry** — `feature_flags`/`user_feature_flags` tables in
   `db.ts`; `src/lib/server/featureFlags/registry.ts` with the flag list in
   §1.1.
2. **Resolution engine + request wiring** — `resolve.ts` (§2), `locals.flags`
   in `hooks.server.ts`, `flags` in the root layout's load return,
   `requireFeature()` in `api.ts`.
3. **Admin: global flags page** — `/admin/feature-flags` (§3.1).
4. **Admin: per-user overrides** — new `/admin/users/[id]` detail page +
   override-count badge on the `/admin/users` list (§3.2).
5. **End-user UX pass** — hide/grey + disabled-message handling for nav and
   in-context actions (§4). Depends on 2–4 existing so real flags exist to
   test against.
6. **Enforcement sweep** — add `requireFeature()` calls at every real
   call site for each flag in §1.1 (send API, multisig-creation routes, the
   coin-control UTXO picker, CSV export route, address-book routes, QR
   camera entry points, wallet-config import/export routes, explorer
   routes, each `src/lib/hw/*` driver's registration path, each
   notification channel's send path). This is the largest, most scattered
   unit — likely worth splitting further per feature area once scoped in
   detail; tracked as one epic-level bead with child beads filed per area
   as the sweep starts, rather than guessing exact sub-boundaries now.
7. **Tests** — resolution-precedence unit tests (all 5 states in §1.2's
   table), a migration-safety test asserting every registered flag
   resolves `true` on an empty database, and at least one enforcement
   integration test (403 from a gated route when a flag is off).
