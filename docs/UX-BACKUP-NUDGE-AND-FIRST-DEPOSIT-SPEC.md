# UX spec — Backup-nudge cadence (gt05.5) + First-deposit confidence (gt05.6)

Implementation-ready spec for two research beads under epic **cairn-gt05**. Grounded in
`docs/UX-PSYCHOLOGY-RESEARCH-R2-2026-07-18.md` (F16, F17), `docs/DESIGN-MANIFESTO.md`
(amber = attention not error; green = growth/received only; plain language; no jargon;
sats-first; never modal/red for expected states), and `docs/UX-REDESIGN-SPEC.md`.

Constraints honored throughout: **minimal diff** (modify existing components, no new ones);
**no new colors**; **no modals**; plain language a non-Bitcoiner understands; never expose
`mempool` / `UTXO` / `descriptor` / `xpub` raw.

---

## SPEC A — cairn-gt05.5: Backup nudge — decaying + polymorphic + state-driven cadence

### Problem with today's implementation
The amber "back up" banner lives in `src/routes/(app)/+layout.svelte` (`.backup-banner`,
~lines 193–216). It renders whenever `data.unbackedWallets` (from
`listUnbackedWallets()` in `src/lib/server/backups.ts`) is non-empty, and its only suppression
is a **per-session** `sessionStorage` flag `cairn.backup.banner.dismissed`. So it re-appears on
**every new session** — precisely the per-session ritual F16 says decays a warning to wallpaper
and then to alarm-fatigue. It is already correct on the two doctrine points F16 also requires:
it uses `--warning-muted` / `--warning-border` fill with a `--warning`-tinted `alert-triangle`
(amber, **never red**), and it is an inline row (**never modal**). The fix is **cadence +
polymorphism**, not tone.

The separate `.reminder-banner` (90-day stale-backup reminder, server-dismissed via
`backup_reminders`) is out of scope — leave it as-is.

### State model (persist server-side — new table)
The decay must survive across sessions and devices, so it cannot live in `sessionStorage`.
Mirror the existing server-persistence pattern used by `backup_reminders` / `wallet_backups`.

New table (migration in `src/lib/server/db.ts`, alongside the other backup tables):

```sql
CREATE TABLE IF NOT EXISTS backup_nudges (
  user_id      INTEGER NOT NULL,
  wallet_kind  TEXT    NOT NULL,          -- 'multisig' (only created-multisigs are ever nudged)
  wallet_id    INTEGER NOT NULL,
  first_seen_at TEXT   NOT NULL,          -- earned moment (first time this wallet became due)
  last_shown_at TEXT,                     -- last time the banner actually rendered for it
  shown_count  INTEGER NOT NULL DEFAULT 0,
  stakes_bucket INTEGER NOT NULL DEFAULT 0, -- highest stakes tier seen so far (see triggers)
  PRIMARY KEY (user_id, wallet_kind, wallet_id)
);
```

`stakes_bucket` tiers (monotonic — only ever raised, never lowered):

| Bucket | Meaning | Source field (already tracked) |
|---|---|---|
| 0 `NEW` | Unbacked wallet exists, no funds known | `listUnbackedWallets()` row present |
| 1 `MULTI` | A *second* unbacked wallet also exists | `listUnbackedWallets()` count ≥ 2 |
| 2 `FUNDED` | This wallet has received bitcoin | the inbound-payment notification path (see hook) |

Rationale for choosing server DB over `localStorage`/`sessionStorage`: the old nudge already
proved the client flag is too weak (resets every session = the nag). The 90-day reminder already
established the server-table precedent for exactly this kind of cross-session cadence.

### Decay schedule (concrete)
Measured from `last_shown_at` (or `first_seen_at` for the first showing). A wallet's nudge is
**due** when `now >= last_shown_at + interval(shown_count)`:

| After showing # | Next eligible |
|---|---|
| (never shown) | immediately — the earned moment |
| 1 | +3 days |
| 2 | +10 days |
| 3 | +30 days |
| 4+ | +90 days (quarterly), capped — never shorter |

**Hard cap (anti per-session):** never show the same wallet's nudge more than **once per 72h**,
regardless of decay *or* escalation. This is the rule that guarantees it can never become a
per-session ritual on an actively-used wallet.

### Escalation triggers (state-driven, bypass decay but not the 72h cap)
When the current `stakes_bucket` computed at load is **greater** than the stored one, the nudge
becomes immediately due (subject only to the 72h cap), the stored bucket is raised, and the
**escalated copy variant** is shown once before rotation resumes. Triggers, each tied to a field
the app already tracks:

1. **A second unbacked wallet appears** → bucket `MULTI`. Detectable for free from
   `listUnbackedWallets(userId).length >= 2` at layout load. No new data needed.
2. **This wallet received its first funds** → bucket `FUNDED`. **Hook the existing inbound-payment
   notification path** (`src/lib/server/notifications.ts` / the received-funds `notify(...)` call).
   When that fires for a wallet that is an unbacked `source='created'` multisig, call
   `escalateBackupNudge(userId, walletId, FUNDED)`, which raises `stakes_bucket` and clears
   `last_shown_at` so the nudge re-earns immediately (still gated by the 72h cap). This is the
   highest-value escalation: an unbacked wallet that just took real money must re-nudge now, not
   wait out a 30-day decay window.

> Note: a raw "balance crossed N sats" trigger is intentionally **not** specified — the layout
> loader has no cheap per-wallet balance (balance is client-scan-derived). The `FUNDED` trigger
> via the notification path captures the same stakes-raising event using data the server already
> has, with no new scan seam. If a persisted per-wallet balance is added later, add sats-band
> sub-tiers under `FUNDED`; not required for this bead.

### Copy variants (polymorphic — plain language, sats-first, amber grammar)
Copy lives in a client table in `+layout.svelte` keyed by a `variantId` the server returns, so
wording changes stay next to the styling. The server returns `{ walletId, name, unbackedCount,
variantId, tone }`; the client renders `variants[variantId]`. Selection rule:
`variantId = shown_count % N` for the calm rotation; on an escalation, force the matching escalated
variant for that one showing. **Never render the same string twice in a row** — indexing on
`shown_count` guarantees this.

Calm rotation (single unbacked wallet — `{name}` interpolated):

- **V1** (earned moment): `{name} lives only on this server right now. Download its backup so you can always get it back.` · link **Download backup**
- **V2**: `One thing left for {name}: save its backup. Without it, losing this server means losing access to the funds.` · link **Save it now**
- **V3**: `Still no backup for {name}. It takes a minute, and it's the one copy that protects your bitcoin.` · link **Download backup**
- **V4**: `A copy of {name}'s setup only exists here. Keep one somewhere safe — a phone, a drive, a printout.` · link **Get the backup**
- **V5** (quarterly, low-key): `{name} still isn't backed up. Whenever you're ready, the file's right here.` · link **Download backup**

Escalated variants (still amber, still an inline row — firmer, never red, never modal):

- **E-FUNDED**: `{name} now holds bitcoin and still has no backup. Save it now so a lost server can't cost you.` · link **Back up {name}**
- **E-MULTI**: `{unbackedCount} wallets still need backups. Start with {name} — each one's setup exists only here.` · link **Start with {name}**

All strings: no "don't worry", no jargon (`config`/`setup` is the plainest word for the
wallet-config file and is already used in today's banner), amber-attention register, one clear
action link. The `--warning` amber tone and `alert-triangle` icon are unchanged.

### Component-level changes
- **`src/lib/server/db.ts`** — add the `backup_nudges` table migration (idempotent
  `CREATE TABLE IF NOT EXISTS`, same style as the surrounding backup tables). Optionally
  `ON DELETE CASCADE` off `multisigs`, or leave orphans (never queried without a join).
- **`src/lib/server/backups.ts`** — add:
  - `getDueBackupNudge(userId): { walletId; walletKind; name; unbackedCount; variantId; tone } | null`
    — internally calls `listUnbackedWallets(userId)`, loads/creates `backup_nudges` rows, computes
    the highest current `stakes_bucket`, applies the decay schedule + 72h cap, and returns the one
    due nudge (oldest unbacked wallet wins) or `null`. When it returns a nudge, it stamps
    `last_shown_at = now`, `shown_count += 1`, and persists the raised `stakes_bucket`.
  - `escalateBackupNudge(userId, walletId, bucket)` — raises `stakes_bucket` and clears
    `last_shown_at`. Called from the inbound-notification hook.
  - Keep `listUnbackedWallets` as-is (now an internal helper of `getDueBackupNudge`).
- **`src/routes/(app)/+layout.server.ts`** — replace the bundle field
  `unbackedWallets: listUnbackedWallets(userId)` with `backupNudge: getDueBackupNudge(userId)`.
  Keep it **inside** the `cachedNavBundle` loader closure so the `last_shown_at` stamp runs at
  most once per 15s cache miss — over-stamping is harmless (decay only ever widens), and the 15s
  staleness just means a newly-due nudge can appear up to 15s late. Drop `showBackupReminder`? No —
  leave the separate 90-day reminder wiring untouched.
- **`src/lib/server/notifications.ts`** (inbound-payment path) — after firing a received-funds
  notification, if the wallet is an unbacked `source='created'` multisig, call
  `escalateBackupNudge(userId, walletId, FUNDED)`. Best-effort, never throws.
- **`src/routes/(app)/+layout.svelte`** — in the `.backup-banner` block (~193–216):
  - Replace the `unbacked`-array logic with a single `const nudge = $derived(data.backupNudge)`.
  - Render when `nudge && !backupDismissed`. Keep `backupDismissed` as a **session-only hide-for-now**
    (it does *not* reset the server decay); the server's `getDueBackupNudge` is what governs
    re-appearance, so even a never-dismissing user won't see it again until the interval elapses.
  - Add a client `BACKUP_NUDGE_COPY` table keyed by `variantId`; interpolate `{name}` /
    `{unbackedCount}`; render `nudge.variant.text` + the action link to `nudge.href`.
  - Styling (`.backup-banner`, amber tokens, `alert-triangle`, dismiss `x`) unchanged.

### Acceptance criteria (Spec A)
1. A freshly-created unbacked multisig shows the nudge **once** at creation, then the amber row
   does **not** re-appear on the next session/reload until ≥3 days later (decay, not per-session).
2. Consecutive showings are **never byte-identical** — the copy string rotates through V1…V5.
3. Sending funds into an unbacked wallet makes the nudge re-appear on the next load with the
   **E-FUNDED** copy, even if the last calm showing was <30 days ago — but never within 72h of the
   previous showing.
4. A second unbacked wallet switches the banner to **E-MULTI** with the correct count.
5. The nudge is **never** modal, **never** red, and can **never** appear twice within any 72h
   window for the same wallet.
6. Backing up the wallet (`markBackedUp`) removes it from the nudge entirely on next load.
7. Decay state survives a server restart (it is timestamp-persisted, not in-process).

---

## SPEC B — cairn-gt05.6: First-deposit confidence — agency-giving empty + pending states

### Problem
Both the never-funded empty state and the first-deposit-pending state are
intolerance-of-uncertainty states (F17) that drive block-explorer refreshing. Today:
- The receive section (`src/routes/(app)/wallets/[id]/+page.svelte` ~852–958) shows the address +
  "A fresh address, every time." + a privacy caption, but **no mechanism-fact confidence line**
  ("is this really mine?").
- The pending state shows only `· <amount> on its way` in the hero-sub (~662–666) and a
  `burialRingsLabel(0)` → **"unconfirmed"** tag in the tx row (~1035, 1053) — a bare status, not an
  agency-restoring answer that makes one check sufficient.

Answer with **mechanism-fact + agency**, not reassurance-theater. No "don't worry".

### Data actually available (grounding — do not exceed it)
- `available` (`scan.confirmed − maturingTotal`), `scan.txs` (with `height`, `delta`, `txid`,
  `fee`), `scan.unconfirmed` (total inbound sats not yet confirmed).
- Confirmation math via `confirmationsFor(height, tip)` / `confirmationsOf()`; `tipHeight` rune +
  `/api/live` SSE already re-scan on new block / received / confirmed, so these states
  **self-update with no user action** — the "your own node is telling you" claim is real.
- **No per-tx ETA / fee-rate / mempool-position** is available at this surface. Pending copy must
  therefore use a **hedged general-network fact** ("usually within an hour"), never a fabricated
  per-tx estimate.
- Every received tx is recorded to the activity feed (`recordActivity`), so "it'll show in your
  activity" is always true; a push notification is only true when the user configured one, so
  **do not promise a push** — point at the always-present activity feed instead.

### (a) Empty / never-funded receive state — mechanism-fact confidence line
Derive: `const neverFunded = $derived(!!scan && available === 0 && scan.txs.length === 0 && scan.unconfirmed === 0);`

In the receive section, gated on `scan` truthy and `neverFunded`, add one confidence line (reuse
the existing `.hw-caption` class — `--text-secondary`, no new color):

> **This address belongs to your wallet. Anything sent to it is controlled only by your keys — nobody else can move it. You can share it or reuse this flow as often as you like.**

Keep the existing "A fresh address, every time." headline and the privacy caption
("A new address for every payment keeps your history private. Old addresses keep working
forever…") — they are doctrine-approved. The tx-list empty state
("No transactions yet / Send some sats to a receive address and they'll show up here.", ~1027–1032)
is **explicitly blessed** by DESIGN-MANIFESTO §4 — leave it unchanged.

### (b) First-deposit-pending state — self-updating, answers the check once
Derive: `const hasIncomingPending = $derived(!!scan && scan.unconfirmed > 0);` (inbound only —
guard `> 0`, not `!== 0`, so outbound-change edge cases don't trigger it).

Add a calm status block (new `.hw-pending-note`, gated on `hasIncomingPending`), placed directly
under the hero-sub or immediately above the transactions tab. Uses `--text-secondary` body with the
amount rendered via the existing `<Amount>` (which already colors inbound growth-green per
manifesto §3.5) — **no new color, no red, not a modal**. Exact copy:

> **Your payment is on its way in.**
> Your node has seen it — **`<Amount sats={scan.unconfirmed} … direction="in" />`** arriving. It'll be
> spendable once the network confirms it, usually within an hour. You don't need to do anything:
> this page updates itself, and it'll appear in your activity as soon as it confirms — no need to
> check anywhere else, this is your own node telling you.

Notes on the strings:
- "usually within an hour" is a **general network fact**, kept hedged ("usually") because there is
  no per-tx estimate — never render a precise countdown here.
- "confirms" / "spendable" only — never "mempool", "block", "UTXO".
- "this is your own node telling you" is the sovereignty payoff F17 asks for (removes the reason to
  leave for a third-party explorer).

**Tx-row label** (~1053): the shared `burialRingsLabel(0)` returns `"unconfirmed"` and is
unit-tested/locked (`src/lib/components/heartwood/burialRingsLabel.test.ts`) — **do not change the
shared helper**. Instead, in the wallet-detail tx row only, when `conf === 0 && tx.delta >= 0`,
render the local label **"confirming now"** in place of the meta status, leaving the helper (and
every other consumer) untouched.

### Files to touch
- **`src/routes/(app)/wallets/[id]/+page.svelte`** — add the two `$derived` flags; add the
  confidence line in the receive section (gated on `neverFunded`); add the `.hw-pending-note` block
  (gated on `hasIncomingPending`); local "confirming now" label for 0-conf inbound rows; one small
  `.hw-pending-note` style rule (surface-neutral, no new token).
- **`src/routes/(app)/wallets/multisig/[id]/+page.svelte`** — mirror all three changes (this route
  has the same receive/pending/tx-row structure per grep). Keep copy identical.

### Edge cases (Spec B)
- **Node unreachable** (`scan` null / `receive` null): show neither the confidence line nor the
  pending note — the existing "Still connecting to your node" empty state owns that case. All new
  blocks are gated on `scan` truthy.
- **Pending deposit then RBF'd / double-spent away** (the `cairn-a2p1` cancelled-inflow path):
  `scan.unconfirmed` returns to 0, so `hasIncomingPending` flips false and the pending note
  auto-hides; the existing "no longer on its way" row handling is unchanged.
- **Already-funded wallet receiving a new deposit:** `neverFunded` is false (so no confidence
  line), but `hasIncomingPending` is true — the pending note still shows, which is correct and
  desirable (not limited to the literal first deposit).
- **Immature coinbase (mining rewards):** driven by `maturingTotal`, a separate section — the
  pending note keys only off `scan.unconfirmed` (ordinary inbound), so the two never conflate.
- **Multiple simultaneous pending inflows:** `scan.unconfirmed` is the aggregate, so the note shows
  the combined amount arriving — acceptable and accurate.
- **Confirmation lands while page open:** the `/api/live` SSE re-scan flips `scan.unconfirmed` to 0
  and moves the tx to "1 confirmation"; the pending note disappears with no user action — this *is*
  the self-updating payoff, and it is already wired.

### Acceptance criteria (Spec B)
1. A never-funded wallet's receive view shows the mechanism-fact confidence line (keys-only
   control, safe to reuse/share); it contains no "don't worry" and no jargon.
2. An incoming unconfirmed deposit shows the calm pending note with the live amount, the hedged
   "usually within an hour", and the "you can leave / it'll appear in your activity" agency line.
3. The pending note self-clears the moment the tx confirms (no reload).
4. Nothing in either state is red, modal, or a spinner-wall; no `mempool`/`UTXO`/`descriptor`
   leaks; the shared `burialRingsLabel` helper and its tests are unchanged.
5. Both single-sig and multisig wallet-detail routes render identical copy.
