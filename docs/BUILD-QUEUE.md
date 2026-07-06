# Cairn Build Queue — Everything Ready for Opus

Snapshot: 18 open beads (`br list --status open`, verified accurate via
`br doctor --repair` immediately before compiling this — `br ready` is
known to under-report on this instance, treat `br list --status open` as
the source of truth) plus three completed planning documents. This doc is
the single prioritized entry point — work top to bottom within a tier,
tiers in order, unless a dependency note says otherwise.

**When you close a bead from this list, close it in `br` with a reason
(`br close --actor opus <id> --reason "..."`) — don't just fix the code.**
The beads tracker is the shared coordination layer across every session
working on Cairn; a fix that isn't reflected there is invisible to
everyone else.

---

## TIER 0 — Fix before anything else ships

### cairn-j6fv (P1) — Wallet transaction amounts (`delta`) always report as 0

**The single most urgent item in this entire queue.** Confirmed by the
browser tester with a cross-check against real on-chain data: every
transaction's `delta` field is a hard `0` regardless of actual value,
across the wallet detail page, `/api/wallets/[id]/transactions`, the CSV
export, and the dashboard activity feed — while the aggregate confirmed
balance is computed correctly elsewhere, proving this is a display/API
computation bug, not a genuinely-zero-value edge case. This is financial
software showing users the wrong number for how much they received in
every transaction. Fix this first, before picking up anything else in this
queue — everything downstream (portfolio charts, CSV exports, activity
feed, and the collaborative-custody roster/notification work in
`docs/COLLABORATIVE-CUSTODY-PLAN.md`, which surfaces per-transaction
amounts in notifications) inherits correct data once this is fixed, and
inherits the bug if it isn't.

---

## TIER 1 — P1 bugs and blocking infrastructure

### Backup safety (one initiative, five beads — work as a unit)

- **cairn-m4e** (epic) — "Wallet config backup as a first-class safety
  requirement." Umbrella for the four below.
- **cairn-dcp** — Mandatory backup download step on wallet creation.
- **cairn-iyj** — Server-tracked backup status with a persistent banner.
- **cairn-lun6** — Restore-from-backup entry point.
- **cairn-iylz** (P2, grouped here since it's the same initiative) —
  Backup filename convention and descriptor export everywhere.
- **cairn-2vha** (P2, same initiative) — Admin backup prominence and
  staleness warning.
- **cairn-2xhw** (P2, same initiative) — 90-day periodic backup reminders.

**Cross-reference**: `docs/NOTIFICATION-PLAN.md` §3's event-hooks table
already anticipates `backup_missing`/`backup_stale` as notification events
and explicitly notes (having checked `src/lib/server/backup.ts` directly)
that **no last-backup timestamp is tracked anywhere yet** — building that
tracking is shared groundwork between this bead cluster and the
notification plan. Whichever lands first should build the
`last_instance_backup_at` tracking once; the other should consume it, not
duplicate it. Flag this explicitly to whoever picks up either side.

### cairn-a4k / cairn-vrf — Multisig vault epic, one real remaining item

`cairn-vrf` ("Multisig vaults (local M-of-N)") is the top-level epic for
all of Cairn's multisig work — checked its dependency tree directly:
**every child is closed except `cairn-a4k`** ("Vault end-to-end emulator
verification"). This is not two separate items, it's one: finish `cairn-a4k`
(drive a real hardware-emulator end-to-end multisig flow, per its own
description) and `cairn-vrf` closes itself as a natural consequence. Don't
treat `cairn-vrf` as separate work to scope.

---

## TIER 2 — P2 bugs and polish

- **cairn-ethg** — Admin recovery setup is documented as mandatory but not
  server-enforced (a real gap between claimed and actual behavior, not a
  security hole — see the bead for the exact fix location:
  `+layout.server.ts`/`hooks.server.ts` need the redirect the code comment
  already claims exists).
- **cairn-kc4e** — User agreement/disclosure page never shows the
  configured Operator name. Root cause already diagnosed by the reporter:
  the Settings page's "User Agreement" section appears to have its own
  form/submit action separate from the one visible "Save settings" button
  — the admin believes they saved it (no error shown) but nothing
  persisted. Check for a second, distinct form action being silently
  skipped, the same class of bug as the earlier-fixed admin "Test
  connection" button (disabling/handling state outside the actual
  submission path).
- **cairn-vxi / cairn-l83 / cairn-asn** — Jade driver, BitBox02 driver, and
  the umbrella epic for both. **These three beads are the pre-existing
  tracking placeholders for exactly the work `docs/HARDWARE-PLAN.md` Scope
  2 now specifies in full detail** (library choices, connection flows,
  Caravan cross-references, emulator availability, component file plan,
  subagent breakdown). Don't scope this work twice — treat the hardware
  plan as the authoritative spec and these three beads as the tracking
  handles to close once that plan's Scope 2 units land. Note the plan's own
  recommendation: BitBox02 and Jade-USB are the higher-value, better-
  sourced targets; Jade-QR (BC-UR format, unrelated to Cairn's existing
  BBQr support) is flagged in the plan as large enough to warrant a
  separate follow-on release rather than bundling into the same push.

## TIER 3 — P3 minor polish

- **cairn-yhxl** — Admin > Users "Wallets" count column omits multisig
  wallets (counts only the `wallets` table, not `multisigs`). Small,
  isolated fix.
- **cairn-ydqv** — DB migration warning uses `console.warn` instead of the
  pino logger. One-line fix, `src/lib/server/db.ts`'s rename-recovery
  migration.
- **cairn-ei6** — Mobile: primary nav is a horizontal-scroll strip instead
  of a proper mobile nav pattern.

---

## TIER 4 — The three major planning documents (large, multi-subagent initiatives)

Each of these is its own fully-specified plan with a subagent breakdown —
this queue doesn't re-derive their contents, just sequences them relative
to everything else and to each other.

### `docs/NOTIFICATION-PLAN.md` — notification system

10 subagent units (core dispatcher/schema, in-app bell, 5 channels, event
hooks, settings UI, admin UI). No dependency on Tier 0-3 work to *start*
(Unit 1's contracts are self-contained), but **event-hook Unit 8 is more
valuable once cairn-j6fv is fixed** — a `tx_received`/`tx_large`
notification reporting the wrong amount is worse than not having one.
Sequence Unit 8 after Tier 0.

### `docs/HARDWARE-PLAN.md` — single-sig hardware import + BitBox02/Jade

Two scopes, 7 subagent units (A/B/C for single-sig import wiring,
D/E1/E2/F/G for BitBox02+Jade). Zero dependency on anything else in this
queue — can start immediately, fully parallel to Tiers 0-3 and the other
two plans.

### `docs/COLLABORATIVE-CUSTODY-PLAN.md` — same-instance shared multisig custody

7 subagent units (contacts, sharing/access-gate, route audit, sign-session
roster + notification wiring, shared-wallet-list UI, collaborators UI,
roster UI). **Real dependency on the notification plan**: Unit 4 (roster +
notification wiring) calls `notify()` per the notification plan's Unit 1
contract — code against that documented signature if Notification Unit 1
hasn't merged yet, same pattern every other cross-plan dependency in this
project already uses. **No dependency on the hardware plan** — collaborative
custody's signing step reuses whichever device signers already exist
(Trezor/Ledger/ColdCard/QR/file today; BitBox02/Jade automatically once the
hardware plan lands, no collaborative-custody-side change needed either
way).

---

## Suggested parallel tracks

If resourcing allows genuinely parallel work, four independent tracks with
minimal cross-blocking:

1. **Correctness track** (solo-able, do first): Tier 0 → Tier 1 → Tier 2 → Tier 3.
2. **Notification track**: `docs/NOTIFICATION-PLAN.md` in full, Unit 8 timed after Tier 0 lands.
3. **Hardware track**: `docs/HARDWARE-PLAN.md` in full, fully independent.
4. **Collaborative custody track**: `docs/COLLABORATIVE-CUSTODY-PLAN.md`,
   with its Unit 4 sequenced after Notification Track's Unit 1 (contract-only
   dependency, not a hard blocking merge order).

Tracks 2-4 don't block each other and don't block Track 1 — the only real
cross-track dependency in the whole queue is Collaborative Custody Unit 4
→ Notification Unit 1's *contract* (not its merged code).
