# Solo Mode + Umbrel Auto-Admin — Scoping Plan

Status: both parts are now built. Part 1's auto-admin loop closed 2026-07-06
(cairn-49xi.2 — see docs/PUBLISH-PLAN.md's status note): `bootstrapAdminFromEnv()`
flags the account with `users.must_reset_password` and the `(app)` layout gate
forces `/setup-admin` before any other route. Part 2's `instanceMode` setting
and the three gated surfaces are implemented (`src/lib/server/settings.ts`,
`src/lib/server/instanceModeMigration.ts`, and the gates in
`admin/+layout.svelte`, `settings/+page.svelte`, and
`wallets/multisig/[id]/+page.server.ts`). Two related asks bundled into one doc
because they share a theme: **a fresh Heartwood install should feel like a
single-user appliance, not a multi-tenant server you have to configure.**

---

## Part 1 — Umbrel auto-admin setup

### What "auto-admin" means

Many Umbrel apps boot with an admin account already created and a generated
password shown on the install card, so the user opens the app and logs in —
no signup form, no email to pick.

### What Heartwood has today

- `bootstrapAdminFromEnv()` ([auth.ts:237](../src/lib/server/auth.ts:237)) already
  does most of the mechanical work: if `CAIRN_ADMIN_PASSWORD` (or the legacy
  `APP_PASSWORD` alias) is set at boot, it creates the first admin user (default
  email `admin@cairn.local`, overridable via `CAIRN_ADMIN_EMAIL`) or sets the
  password on an existing passwordless first user. It never overwrites a
  password an operator already chose. Runs once from
  [hooks.server.ts:19-23](../src/hooks.server.ts:19).
- The signup page already gets out of the way once this runs: `firstUser` in
  [signup/+page.server.ts](../src/routes/(auth)/signup/+page.server.ts) is
  `userCount() === 0`, so as soon as bootstrap creates the first user, `/login`
  no longer redirects to `/signup`. **No code change is needed for "skip the
  signup page" — it already falls out of the existing bootstrap.**
- `docs/PUBLISH-PLAN.md` §5/§7.3 already looked at this and made an explicit
  decision for the *v1 App Store submission*: don't wire Umbrel's own derived
  `APP_PASSWORD` (via `derive_entropy "app-cairn-seed-APP_PASSWORD"`) into
  Heartwood's login, because it collides in name with Heartwood's own legacy
  `APP_PASSWORD` alias for break-glass admin recovery. The draft manifest ships
  `defaultUsername: ""` / `defaultPassword: ""` — i.e., v1 is plain browser
  signup, not auto-admin.

That v1 decision is reasonable for "ship something safe first," but it's the
opposite of what's being asked for now. This plan supersedes it with a real
auto-admin design, using the escape hatch PUBLISH-PLAN.md itself already
flagged: *"derive a distinctly named secret rather than reusing Umbrel's
`APP_PASSWORD`."*

### Recommended design

1. **Distinctly-named derived secret.** In the Umbrel package's `exports.sh`,
   derive e.g. `derive_entropy "app-cairn-seed-admin-password"` into an env var
   that is **not** named `APP_PASSWORD` (avoids the collision). Pass it into
   `docker-compose.yml` as Heartwood's own `CAIRN_ADMIN_PASSWORD` — this reuses
   `bootstrapAdminFromEnv()` completely unchanged.
2. **Manifest fields.** Set `defaultUsername: admin@cairn.local` and
   `defaultPassword: $<the derived var>` in `umbrel-app.yml` so Umbrel's
   install-complete screen shows real, usable credentials instead of blanks.
3. **First-login forced password reset (new — this is the actual gap).**
   Nothing today prompts a bootstrapped admin to replace the generated
   password. Since that password sits in Umbrel's install UI/logs
   indefinitely, add a `users.must_reset_password` flag set by
   `bootstrapAdminFromEnv()` on creation, checked at login to force a
   "set your own password (and, optionally, a real email)" step before the
   dashboard. This also solves the `admin@cairn.local` placeholder-email
   problem — notification emails need somewhere real to go.
4. **Docs.** Update `docs/PUBLISH-PLAN.md` §5/§7.3 once this is built —
   supersede the "ship empty `defaultUsername`/`defaultPassword`" line.
5. **Test.** Fresh-install through an umbrelOS VM/device (per the
   `umbrel-test-app` workflow): install → password shown → login → forced
   reset prompt → dashboard → restart → confirm the reset password persisted
   and bootstrap doesn't re-fire.

### Decision: forced-reset step requires both password and email (2026-07-06)

Question was: should the forced-reset step also require setting a real email
(for notifications to work), or is "keep `admin@cairn.local`, just change the
password" an acceptable end state?

**Decided: require both in the same step.** A solo user who never types their
email won't get any email notifications (backup reminders, send confirmations)
and won't know why — that's a silent failure mode, not a graceful degradation.
Making email mandatory alongside the password reset costs one extra form field
at a moment the user is already forced to stop and pay attention, so there's no
real cost to bundling it. `admin@cairn.local` remains the bootstrap default
purely so `bootstrapAdminFromEnv()` has *something* to write before the human
ever logs in — it must never be the long-term address.

---

## Part 2 — Solo mode / progressive disclosure

### Baseline definition

**Solo mode** = the experience of a single-user Heartwood instance: no invite
system, no user list, no contacts, no wallet sharing/cosigner-role UI visible
anywhere. Everything else — send, multisig with your *own* multiple hardware
keys, hardware wallet support, notifications, the explorer — stays fully on,
because none of that is inherently collaborative.

### Existing feature flags don't cover this

Audited all 23 flags in
[featureFlags/registry.ts](../src/lib/server/featureFlags/registry.ts) against
the 4 categories (`wallet`, `hardware`, `notifications`, `marketing`,
`upcoming`). **None of them gate multi-user surface** — they're all capability
switches (send, coin control, CSV export, per-hardware-driver toggles,
per-notification-channel toggles, banners/referrals, unbuilt features). That's
correct and shouldn't change: `multisig_create` in particular is core
single-user functionality (a solo user's own 2-of-3 across their own devices)
and must stay on by default in solo mode, not get bundled into a "collab" gate.

Separately confirmed the actual multi-user surfaces are **currently ungated by
any flag at all**:
- `/admin/users`, `/admin/invites` (nav tabs in
  [admin/+layout.svelte](../src/routes/(app)/admin/+layout.svelte) render
  unconditionally; no `requireFeature()` call in either route)
- `/settings/contacts` + `api/contacts/*` (no `requireFeature()` call)
- multisig wallet sharing (`multisigShares.ts`, `api/wallets/multisig/[id]/shares`)
  — no `requireFeature()` call
- the `registrationMode` setting (open/invite/closed) in `/admin/settings`

### The registry's default-on contract doesn't fit this case

`FeatureFlagDef.defaultEnabled` is typed as the literal `true` — a flag can
never ship pre-disabled (registry.ts:28-32), specifically so an upgrade never
silently pulls a capability out from under an existing user. That's the right
invariant for *capability kill switches*, but solo mode is a different kind of
thing: it's "new installs start narrow," not "an existing feature now defaults
off for everyone." Reusing the flag registry for it would either violate the
compiler-enforced contract or require special-casing one entry, which
undermines the guarantee for every other flag.

### Decision: dedicated `instanceMode` setting, not a feature flag (2026-07-06)

Question was: reuse the feature-flag registry for this (special-casing one
entry to default off), or model it as its own instance-level setting?

**Decided: don't add a `FEATURE_FLAGS` entry for this.** Model it the
same way `registrationMode` already is — a dedicated instance-level setting,
`instanceMode: 'solo' | 'team'` in `settings.ts`, alongside
`registrationMode`. Reusing the flag registry was rejected outright, not just
disfavored: `FeatureFlagDef.defaultEnabled` is typed as the literal `true`
specifically so no flag can ever ship pre-disabled, and that compiler-enforced
guarantee is what lets every *other* flag be trusted not to silently pull a
capability out from under an existing user on upgrade. Carving out one
exception for solo mode would mean either breaking that type-level guarantee
or hand-auditing every future flag addition against a mental exception list —
both worse than just using a different mechanism for a fundamentally different
kind of switch ("new installs start narrow" vs. "kill switch for an existing
capability").

Migration logic on upgrade, applied once by a startup migration (same
mechanism as existing `settings.ts`-adjacent migrations):
- New install (no users yet) → `instanceMode = 'solo'`.
- Existing install → `instanceMode = 'team'` **if** evidence of multi-user
  usage already exists (`users` count > 1, or any row in
  `multisig_shares`/`invites`/`contacts`), **else** `'solo'` (a lone existing
  user isn't using any of this, so narrowing their nav removes nothing they
  rely on).
- The migration runs once and stamps a marker so it never re-evaluates
  `instanceMode` after the admin has explicitly toggled it — otherwise an
  admin who unlocks team mode, then deletes their only cosigner's contact
  row, would get silently narrowed back to solo on the next restart.

`instanceMode === 'team'` becomes the gate for: the `/admin/users` and
`/admin/invites` tabs + routes, `/settings/contacts` + its API, and the
multisig-share/cosigner UI + its API. Solo mode hides these outright (not a
"disabled by your administrator" message — that copy is for feature flags,
this is just a narrower nav). Toggling `instanceMode` to `'team'` is a plain
admin action from `/admin/settings` (an "Unlock team features" control next to
the existing `registrationMode` radio group) — reversible, non-destructive,
never deletes data, just re-hides the nav if turned back off.

**Follow-up decision (cairn-7t0z.5):** "re-hides the nav" must not mean
"revokes access that was already granted." The instanceMode gate applies only
to the *management* surfaces — the `/admin/users`, `/admin/invites`,
`/settings/contacts` pages and the multisig-share creation/invite endpoints.
It must **not** gate the read/resolve path a cosigner already uses to view or
sign a wallet they were shared into, or an existing collaborator's login
itself. A cosigner's access shouldn't depend on the owner's later nav
preference — if the owner flips back to solo after inviting a cosigner, that
cosigner keeps working, the owner just stops seeing the management chrome.

### Beads to file

**Part 1 — Umbrel auto-admin** (epic + 4 units): manifest/exports.sh wiring,
forced first-login password (+ email) reset, PUBLISH-PLAN.md doc update,
umbrelOS VM test pass.

**Part 2 — Solo mode** (epic + 4 units): `instanceMode` setting + upgrade
migration, gate the 3 surfaces (admin users/invites, contacts, multisig
sharing), "Unlock team features" admin control, solo-mode nudge copy (e.g. a
one-line "Want to share this wallet with a co-signer? Turn on team features in
Settings" hint on the multisig wallet page, so the capability doesn't just
vanish without a trail back to it).
