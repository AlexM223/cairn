# Cairn Collaborative Custody Plan — Single-Instance Only

Status: **planning document**, not yet built. Written for parallel execution
by Opus subagents — same over-specified-contract approach as
`docs/NOTIFICATION-PLAN.md` and `docs/HARDWARE-PLAN.md`; read those docs'
header conventions if you haven't already.

**Scope boundary, stated up front because it shapes every decision below:**
this is **single-instance, same-database collaborative custody only** — one
Bitcoin instance, several user accounts on it, sharing one multisig wallet.
**No federation. No cross-instance protocol. No peer handshakes. No
relaying.** If a design decision below ever seems to gesture at "and this
could later federate," that's not intentional — flag it, don't build toward
it.

## 0. Reference material and how this plan uses it

This plan is informed by `docs/COLLABORATIVE-CUSTODY-AUDIT.md` — a from-the-code,
live-tested audit of Bastion (a sibling Bitcoin wallet project) commissioned
specifically so Cairn doesn't re-discover the same mistakes. Bastion has
already built, shipped, and **live-tested** exactly this feature (contacts,
wallet sharing, sign sessions, per-key signature tracking) plus a
cross-instance federation layer Cairn is explicitly not building. Per
Cairn's own standing convention (study battle-tested reference code, adapt
rather than copy): the sections below cite Bastion's design where Cairn
should follow it, and are explicit about where Cairn's actual existing
architecture calls for something different — Cairn is not a green field, it
already has a working local-multisig-signing system (`multisigs` /
`multisig_keys` / `multisig_transactions`, see below), and collaborative
custody needs to **extend that system**, not build a second, parallel one
next to it. Building a second parallel system is precisely Bastion's own
biggest structural regret, called out in its audit's opening line: *"Bastion
has two parallel, non-integrated collaborative-signing systems"* (local
sessions and federation, sharing no code). Cairn must not repeat that
pattern between "local multisig" and "collaborative multisig" — there should
be exactly one multisig-transaction lifecycle, usable by one owner or several
cosigners.

## 1. What Cairn already has (read this before designing anything)

Confirmed directly against current code — this is the foundation
collaborative custody sits on top of, not beside:

- **`multisigs`** (`src/lib/server/db.ts`): `id, user_id, name, threshold,
  script_type ('p2wsh'|'p2sh-p2wsh'|'p2sh'), receive_cursor, created_at`.
  Single-owner today (`user_id`) — no sharing concept exists.
- **`multisig_keys`**: `id, multisig_id, position, name, category
  ('hardware'|'mobile'|'recovery'), device_type, xpub, fingerprint, path,
  last_verified_at`. One row per key in the quorum — **already models "the
  wallet has N keys" independently of "how many people are involved,"** which
  is exactly the seam collaborative custody needs: assign a `multisig_keys`
  row to a specific user, and "one user holds two keys" fixes itself for
  free (see §4).
- **`multisig_transactions`**: `id, multisig_id, status ('draft'|
  'awaiting_signature'|'completed'), psbt, txid, recipient, amount,
  recipients, fee, fee_rate, change_index, broadcast_started_at, created_at,
  updated_at`. This is Cairn's existing local sign-session — draft →
  awaiting_signature (partial sigs collecting) → completed (broadcast). It
  is deliberately a parallel table to the single-sig `transactions` table
  (its own header comment explains why: independent lifecycles, no nullable
  wallet_id/multisig_id merge) — but it does NOT need a second parallel table
  for *collaborative* signing. This same table, plus an access-control layer
  on top, **is** the collaborative sign session.
- **`src/lib/server/bitcoin/multisigPsbt.ts`, `multisigPsbtProgress()`**:
  already computes signing progress **by exact pubkey match against each
  key's own `bip32Derivation` origin** (fingerprint + account path), not by
  a per-user headcount — this is precisely the fix Bastion had to
  retroactively apply after shipping a per-user-only design that broke on
  "one user holds two keys" (Bastion audit §3, the `bastion-swarm-1`-tagged
  comment). **Cairn already does this correctly from day one.** Nothing
  needs fixing here — collaborative custody just needs to surface this
  existing per-key progress data filtered by which user each key belongs to.
- **`src/lib/server/multisigTransactions.ts`**: `buildMultisigDraft`,
  `attachMultisigSignature`, `broadcastMultisigTransaction`,
  `multisigTransactionProgress`, etc. — all currently gated by a single
  `userId` param assumed to be the sole owner (`getMultisig(userId, id)`
  underneath, `WHERE id = ? AND user_id = ?`). **Collaborative custody's
  core backend work is generalizing these ownership checks into a 3-tier
  gate** (owner / cosigner / viewer — see §3), not inventing new signing
  logic.
- **Notifications**: `docs/NOTIFICATION-PLAN.md` (written alongside this
  plan) adds a general-purpose `notify()` dispatcher and a
  `sign_session_waiting` event type already anticipating multisig signing
  sessions specifically. **Collaborative custody must call into that system
  for every notification this plan needs, not build its own** — the whole
  reason `NOTIFICATION_EVENT_TYPES` already includes
  `sign_session_waiting` is that it was scoped with this plan in mind. If
  the notification plan's Unit 1 hasn't landed yet when this work starts,
  code against its documented `notify(payload)` contract (§1.3 there) the
  same way every other notification-plan unit does.
- **No contacts system, no wallet-sharing table, no cross-user roster
  concept exists in Cairn today** — this part genuinely is new, and is
  where Bastion's audit is most directly transplantable (§5).

## 2. The one deliberate architectural deviation from a literal reading of the task brief

The task brief asks for tables named `sign_sessions` and
`sign_session_signers`. **This plan does not create a `sign_sessions`
table.** It extends `multisig_transactions` (already Cairn's sign-session
table in every functional sense) with a roster table,
`multisig_transaction_signers`, that plays the exact role
`sign_session_signers` would have played. Rationale, stated plainly so this
isn't mistaken for an oversight: creating a separate `sign_sessions` table
would mean a multisig transaction's lifecycle exists in two places
(`multisig_transactions.status` and `sign_sessions.status`) that must be
kept in sync — exactly the kind of split Bastion's audit identifies as its
own worst structural problem, just at a smaller scale (within one instance,
not across instances). One transaction, one status, one table; the roster
is metadata about who's involved in signing *that* transaction, not a
separate transaction record.

Concretely, the requested concepts map onto Cairn's schema as:

| Task brief's name | This plan's actual table/mechanism |
|---|---|
| `contacts` | `contacts` (new, ≈ Bastion's table verbatim — see §5) |
| `wallet_shares` | `multisig_shares` (new — named for Cairn's terminology; multisig-only for v1, see §3) |
| `sign_sessions` | **the existing `multisig_transactions` table** (no new table) |
| `sign_session_signers` | `multisig_transaction_signers` (new — roster + per-user signing state for one `multisig_transactions` row) |

## 3. Wallet sharing (`multisig_shares`)

```sql
-- Collaborative custody: share a multisig wallet with another user on this
-- SAME instance. Single-instance only — no federation, no cross-instance
-- concept exists or is planned here. Multisig-only for v1 (a single-sig
-- wallet has exactly one key by definition, so "cosigner" doesn't apply
-- there; a future "share my single-sig wallet read-only with my spouse"
-- extension would reuse this exact table with wallet_kind='wallet' — the
-- schema already generalizes for free, see wallet_kind below, but v1 only
-- writes wallet_kind='multisig' rows).
CREATE TABLE IF NOT EXISTS multisig_shares (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	wallet_kind     TEXT NOT NULL DEFAULT 'multisig', -- future-proofing only; 'multisig' for every v1 row
	multisig_id     INTEGER NOT NULL REFERENCES multisigs(id) ON DELETE CASCADE,
	owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	shared_with_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	role            TEXT NOT NULL DEFAULT 'viewer', -- 'viewer' | 'cosigner'
	created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	UNIQUE (multisig_id, shared_with_id),
	CHECK (owner_id <> shared_with_id)
);
CREATE INDEX IF NOT EXISTS idx_multisig_shares_shared_with ON multisig_shares(shared_with_id);
CREATE INDEX IF NOT EXISTS idx_multisig_shares_multisig ON multisig_shares(multisig_id);
```

**Key-to-user assignment lives on `multisig_keys`, not on the share row** —
this is the one deliberate improvement over Bastion's design (which put a
single `cosigner_xfp` column on `wallet_shares`, meaning a user assigned to
two keys needed two share rows or a workaround). Add:

```sql
-- Guarded ALTER, following db.ts's existing migration convention.
-- NULL = unassigned (the key exists in the quorum but no collaborator has
-- claimed it yet — including every key for a solo, non-collaborative
-- multisig, which is the default/common case and must cost nothing extra).
ALTER TABLE multisig_keys ADD COLUMN assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_multisig_keys_assigned_user ON multisig_keys(assigned_user_id);
```

A user holding two of the wallet's keys is simply two `multisig_keys` rows
with the same `assigned_user_id` — no special-casing anywhere else in the
schema, and `multisigPsbtProgress()`'s existing per-key attribution (§1)
already reports progress per key; collaborative UI just groups those
per-key results by `assigned_user_id` to show "Bob (2 of his keys signed,
1 more needed)" instead of inventing new progress logic.

**Sharing mechanism** (`src/lib/server/multisigShares.ts`, new):
- `shareMultisig(ownerId, multisigId, contactUserId, role, keyIds?: number[])`
  — **the target must be an accepted contact** (§5), exactly Bastion's rule
  and for the same reason: wallet sharing is friends-only, not
  arbitrary-user-id sharing, and an accepted-contacts check is a cheap,
  meaningful guard against social-engineering a share via a leaked user id.
  If `role === 'cosigner'` and `keyIds` is given, each id must reference an
  **unassigned** key belonging to this exact multisig (400 if any key is
  already claimed by someone else, or belongs to a different wallet).
- `updateMultisigShare(ownerId, shareId, { role?, keyIds? })` — role
  upgrade/downgrade, key reassignment.
- `revokeMultisigShare(ownerId, shareId)` — deletes the share row and
  clears `assigned_user_id` on any keys that pointed at this user for this
  wallet (`UPDATE multisig_keys SET assigned_user_id = NULL WHERE
  multisig_id = ? AND assigned_user_id = ?`). Per Bastion's confirmed gap
  #3 (no roster resync), this plan deliberately specifies: revoking a share
  does **not** retroactively pull that user off an already-created,
  in-flight `multisig_transactions` roster (§4) — the roster is frozen at
  transaction-creation time, matching Bastion's (correct, deliberate)
  behavior. Document this clearly in the revoke UI's confirmation copy so
  an owner isn't surprised that revoking access doesn't cancel a signature
  already in flight.

**Three-tier access gate**, directly adapting Bastion's pattern
(`src/lib/server/wallets/multisig.ts` gains two new exported functions
alongside the existing owner-only `getMultisig`):

```ts
/** Owner only — unchanged, existing function. Import, delete, manage shares,
 *  broadcast, descriptor/registration export. */
export function getMultisig(userId: number, id: number): MultisigRow | null;

/** Owner OR any accepted share (viewer or cosigner). Balance, addresses,
 *  transaction history, labels — read-only surfaces. */
export function getViewableMultisig(userId: number, id: number): MultisigRow | null;

/** Owner OR a share with role='cosigner'. The entire sign-flow surface for
 *  transactions this user is a roster member of (see §4 — being a
 *  wallet-level cosigner is necessary but not alone sufficient; the
 *  transaction-level roster in multisig_transaction_signers is the actual
 *  per-transaction gate). */
export function getSignableMultisig(userId: number, id: number): MultisigRow | null;
```

**Every route that currently calls the owner-only `getMultisig` needs an
explicit decision**: does this specific action stay owner-only (broadcast,
delete, share management — matching Bastion's `getOwnedWallet` list exactly)
or does it become viewer/cosigner-reachable? Audit every route under
`src/routes/api/wallets/multisig/**` and `src/routes/(app)/wallets/multisig/**`
against this 3-way split before wiring anything — don't guess per-route,
enumerate them in a single pass so the gate assignment is a deliberate,
reviewed decision, not an accident of which function happened to be
convenient to call.

**404, never 403, on a non-participant's request** — Bastion's audit calls
this out explicitly as a deliberate, worth-keeping choice (no existence
leakage). `getViewableMultisig`/`getSignableMultisig` return `null` for a
random unrelated user exactly like they do for a non-existent wallet id;
callers throw the existing `error(404, ...)` pattern (`src/lib/server/api.ts`)
uniformly, never a 403 that would confirm "this wallet exists, you're just
not allowed."

## 4. Sign session state machine — on `multisig_transactions`, plus a roster table

```sql
-- The roster for one multisig_transactions row: which users are expected to
-- contribute a signature, and whether they have. Frozen at transaction-
-- creation time (see buildMultisigDraft below) — adding/removing a
-- multisig_shares cosigner afterward does not touch an in-flight roster,
-- matching Bastion's audited (and endorsed) behavior.
CREATE TABLE IF NOT EXISTS multisig_transaction_signers (
	id               INTEGER PRIMARY KEY AUTOINCREMENT,
	transaction_id   INTEGER NOT NULL REFERENCES multisig_transactions(id) ON DELETE CASCADE,
	user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	-- Denormalized copy of which key(s) this user was assigned at roster-
	-- freeze time (JSON array of multisig_keys.id) -- NOT a live join to
	-- multisig_keys.assigned_user_id, precisely so a later key reassignment
	-- can't rewrite history for an in-flight or completed transaction.
	assigned_key_ids TEXT NOT NULL,
	has_signed       INTEGER NOT NULL DEFAULT 0,
	signed_at        TEXT,
	created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	UNIQUE (transaction_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_multisig_tx_signers_tx ON multisig_transaction_signers(transaction_id);
CREATE INDEX IF NOT EXISTS idx_multisig_tx_signers_user ON multisig_transaction_signers(user_id);
```

**Why `has_signed` here can be advisory-only, not authoritative** — matching
Bastion's audited, correct design: the real signature count and per-key
attribution always come from `multisigPsbtProgress()` reading the actual
PSBT bytes (already true in Cairn today, §1). `has_signed` on this roster
row is a **UI/notification convenience** (so the sign-session view doesn't
re-parse the PSBT just to render a checkmark next to Bob's name) — it is
**derived from and reconciled against** `multisigTransactionProgress()`'s
real output every time the transaction is read or updated, never trusted as
the source of truth on its own. This is the same lesson Bastion's audit
documents having to learn after shipping a per-user-headcount-only design
(§1) — Cairn should encode the lesson directly rather than risk relearning
it.

**Creating a session** — extend the existing `buildMultisigDraft()`
(`src/lib/server/multisigTransactions.ts`): after inserting the
`multisig_transactions` row, compute the roster as
`{owner} ∪ {distinct assigned_user_id values across this multisig's keys}`
(**the owner is an implicit roster member even if none of the wallet's keys
are explicitly assigned to them** — mirroring Bastion's rule exactly, since
an owner who holds unassigned keys directly is still expected to sign with
them). Insert one `multisig_transaction_signers` row per roster member,
`assigned_key_ids` = the JSON array of that user's `multisig_keys.id`s at
this moment (or `[]` for the owner if they hold no explicitly-assigned key
but sign the "remaining" keys — see the finalizing-signer attribution note
below). **Reject the build (400) if the number of distinct roster members
signing across the quorum's keys is provably insufficient to reach
`threshold`** (same guard Bastion applies at session creation) — cheap,
prevents an obviously-doomed session from ever being created.

**This is also exactly where this plan fixes Bastion's confirmed,
live-tested bug**: call `notify()` (from `docs/NOTIFICATION-PLAN.md`, event
type `sign_session_waiting`) for **every roster member except the creator**,
immediately here, at creation — not deferred until someone else signs.
Bastion's audit is unambiguous that this exact omission is a real,
reproduced-live bug (§3 of the audit, "no notification when a session is
created" — Bob got zero notification until Alice signed first). Cairn's
`buildMultisigDraft` must notify at creation. Then, separately, submitting
a signature (`attachMultisigSignature`) ALSO notifies remaining unsigned
roster members of updated progress (fires again, same event type, updated
`detail.collected`/`detail.required`) — both hooks matter, creation and
each subsequent signature, not just one or the other.

**Submitting a signature**: `attachMultisigSignature` already exists and
already does the hard part (PSBT combine via `combineMultisigPsbts`,
substitution-guard verification via `assertSameTransaction` reused from the
single-sig PSBT module — confirm this reuse is actually happening; if
`multisigPsbt.ts` has its own independent substitution check rather than
sharing the single-sig one, that's worth unifying, one substitution guard
for the whole app, not two implementations of the same security property).
This plan's addition: gate the call on the caller having a
`multisig_transaction_signers` row for *this exact transaction* (not just
being a wallet-level cosigner in general — a user could be a cosigner on
the wallet but added to `multisig_shares` *after* this transaction's roster
was frozen, and per §3's revoke behavior, additions don't retroactively
join an existing roster either, symmetric with the revoke case). After a
successful combine, `UPDATE multisig_transaction_signers SET has_signed=1,
signed_at=now WHERE transaction_id=? AND user_id=?` (best-effort attribution
— if the finalizing signature strips per-input `bip32Derivation` the way
Bastion's audit describes Core's `combinepsbt` doing, and the newly-signed
key can't be attributed by pubkey match, fall back to "the one roster
member not yet marked signed," same elimination heuristic Bastion's audit
documents as its own fix for this exact edge case).

**Reading status**: extend `multisigTransactionProgress()`'s return shape
with `waitingOn: number[]` (user ids) and `signedBy: number[]`, derived by
joining `multisig_transaction_signers` against the live PSBT-derived
per-key progress (§1) — **no ordering/turn-taking**, matching Bastion:
everyone still owed a signature is simply "waiting," there is no concept of
whose turn it is.

**Broadcast stays exactly what it already is** — `broadcastMultisigTransaction`
already sets `status = 'completed'` together with `txid` (§1's 3-state
model). **This plan does not add a 4th `'broadcast'` status.** Bastion's
audit flags "sessions never reach status='broadcast'" as a confirmed gap in
*their* 4-state model (`open`|`complete`|`broadcast`|`cancelled`, where
`complete` means fully-signed-but-not-yet-sent and a separate transition to
`broadcast` was simply never wired). Cairn's existing 3-state model doesn't
have this gap in the first place — "fully signed, not yet broadcast" isn't
its own stored status, it's a **derived** condition (`multisigTransactionProgress().complete
=== true && status !== 'completed'`), so there's no enum value that could
go stale from a missing wiring. Keep it that way; do not introduce a
fully_signed intermediate status just to mirror Bastion's shape — that
would reintroduce the exact class of bug their audit found, for no benefit.

## 5. Contacts (`contacts`)

Adopt Bastion's design close to verbatim — it's a small, self-contained,
well-tested piece with no meaningful Cairn-specific wrinkle:

```sql
CREATE TABLE IF NOT EXISTS contacts (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- requester
	contact_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- target
	status          TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted'
	created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	UNIQUE (user_id, contact_user_id),
	CHECK (user_id <> contact_user_id)
);
CREATE INDEX IF NOT EXISTS idx_contacts_contact_user ON contacts(contact_user_id);
```

New module `src/lib/server/contacts.ts`:
- `requestContact(userId, email)` — looks up the target by email
  (`users.email COLLATE NOCASE`, already the users table's collation).
  **Anti-enumeration, adopting Bastion's exact response-shape trick**: an
  unknown email and a freshly-created pending request both return the same
  success shape — a caller cannot distinguish "no such account" from
  "request sent." If the target already requested the caller, **auto-accept**
  instead of creating a duplicate row (Bastion's rule: a mutual request from
  both sides is itself the acceptance signal).
- `respondToContact(userId, contactId, accept: boolean)` — accept flips
  status; decline deletes the row.
- `removeContact(userId, contactId)` — unfriend, either party, either
  status — one function handles decline/cancel/unfriend uniformly, per
  Bastion's audit noting this uniform handling as a deliberate simplicity
  win worth keeping.
- `listContacts(userId)` — split into "friends" (accepted) and "requests
  received"/"requests sent" (pending, by direction) for the UI.
- **Cairn-specific integration point Bastion doesn't have**: since Cairn
  already has an invite-code system (`src/lib/server/auth.ts`, invite
  redemption) and this plan's audit source notes Bastion auto-inserts an
  accepted contacts row when someone redeems a personal invite link —
  **Cairn's invites are currently admin-issued only** (no self-service
  personal invite links exist today, per `src/lib/server/db.ts`'s `invites`
  table having no per-user "my own invite link" concept). Decide explicitly
  whether this plan also adds self-service personal invite links (Bastion's
  §5, a `created_by` pointing at a regular user rather than only admins) as
  a prerequisite for easy contact-adding, or whether contacts are added
  purely by knowing an existing user's email on this instance. **Recommend
  scoping personal invite links as a separate, smaller follow-on** rather
  than folding it into this plan — collaborative custody's core value
  (shared multisig signing) doesn't require it; email-based contact
  requests between already-registered users cover the primary use case
  ("my spouse and I already both have accounts, let's share a wallet").

Contacts is **display-name-revealing by design**, unlike some of Cairn's
other identity-adjacent features — Bastion's audit confirms this is
deliberate ("know who you're friending"), and Cairn should keep that framing
explicit in the UI copy (contrast with, say, the recovery-phrase feature's
careful "this is not your Bitcoin seed" disambiguation — contacts needs its
own equally clear framing: "this shows your name and email to whoever you
add").

## 6. Derivation path privacy

New function, `src/lib/server/multisigShares.ts` (or co-located with the
existing multisig config/descriptor code):

```ts
/**
 * Redact a multisig's key list for a non-owner viewer: every key's
 * `path` is stripped EXCEPT the viewer's own assigned key(s) (matched via
 * multisig_keys.assigned_user_id). xpub and fingerprint are never redacted.
 * The owner always sees everything unredacted.
 */
export function redactMultisigKeysForViewer(
	keys: MultisigKeyRow[],
	viewerId: number,
	ownerId: number
): MultisigKeyRow[];
```

Directly adapting Bastion's `redactConfigForViewer()` and its stated
rationale (audit §2): a cosigner only ever needs their own derivation path
(their own device/signing flow injects it locally); seeing other cosigners'
full paths leaks account structure for no functional benefit. xpubs and
fingerprints stay visible to every viewer/cosigner regardless — they're
needed to recognize which key is which in the UI (and are not
sensitive on their own; Cairn's whole design already treats xpubs as
shareable-but-not-secret, see the existing Caravan export feature).

**Where this gets called**: every read path that can be reached by
`getViewableMultisig`/`getSignableMultisig` (not just the owner-only ones)
— the multisig detail page, the descriptor/Caravan export endpoints (a
cosigner exporting "their view" of the wallet should get the same
redaction), and any API response embedding the key list. Audit every such
response shape explicitly rather than assuming one central serialization
point catches all of them — Cairn's existing multisig detail/export code
was written single-owner-only and may format the key list in more than one
place.

## 7. UI flow — how one user invites another to co-sign

Walking through the actual user journey, since this is what ties §3-§6
together into something a user can follow without narration:

1. **Alice has an existing multisig wallet** (built solo, or freshly
   created with some keys still marked `category: 'recovery'`/unassigned —
   collaborative sharing works retroactively on an existing wallet, it's
   not only a creation-time choice).
2. **Alice adds Bob as a contact**: Settings → Contacts (new page) →
   "Add contact" → enters Bob's email → sees "Request sent" (same response
   whether or not Bob's email is real, §5). Bob sees a pending request
   under Contacts → Accept. Both now see each other under "Contacts."
3. **Alice shares the wallet**: on the multisig wallet's detail page, a new
   "Collaborators" section (owner-only) → "Share with a contact" → picks
   Bob from her accepted-contacts list (not a free-text email field here —
   the contact relationship must already exist, per §3's rule) → chooses
   role (`viewer` or `cosigner`) → if cosigner, optionally assigns one or
   more of the wallet's currently-unassigned keys to Bob right there (or
   leaves it for later — "decide later" is a valid state, matching
   Bastion's audit noting the same). Confirm → Bob is added.
4. **Bob sees the shared wallet**: it appears in Bob's own `/wallets` list
   (query needs to become `getMultisig(ownerId=userId) UNION shares WHERE
   shared_with_id=userId`, not just the existing owner-only listing —
   another place §3's audit-every-route instruction applies) with a visual
   "Shared by Alice" badge distinguishing it from wallets Bob owns
   outright. Bob's view of the key list is redacted per §6 — he sees his
   own path, not Alice's or the third key's.
5. **Alice builds a transaction** (existing send flow, unchanged) — at the
   point a draft is created, the roster is frozen (§4) and every roster
   member except Alice gets a `sign_session_waiting` notification
   immediately (the bug Bastion's audit caught, fixed here by construction,
   not patched in later).
6. **Bob gets the notification** (in-app bell at minimum, plus whichever
   channels Bob has configured per the notification plan — email/Telegram/
   etc. are exactly the kind of "someone needs my signature" event those
   channels exist for), opens the wallet, sees "Awaiting your signature,"
   and goes through the **existing** per-device signing stepper (Trezor/
   Ledger/ColdCard/QR/file — already built, already device-aware, nothing
   new to build here) scoped to his assigned key(s).
7. **Bob signs** → `attachMultisigSignature` combines his signature in,
   updates his roster row, and (if quorum isn't yet met) notifies remaining
   unsigned roster members with updated progress.
8. **Quorum reached** → Alice (owner-only, per §3's broadcast gate — a
   cosigner never gets a broadcast control, matching Bastion's UI behavior
   exactly: "Fully signed — only the wallet owner can send it to the
   network") broadcasts. Existing broadcast code, no changes needed beyond
   what §4 already covers.

## 8. What this plan deliberately does NOT build

Restating the scope boundary from the top, now that the shape of the work
is concrete, so no subagent accidentally wanders into it:

- No `federation_peers`/handshake/instance-identity concept of any kind.
- No multi-hop relay, no cross-instance PSBT routing.
- No messaging/chat system (Bastion's `messages` table) — out of scope for
  this plan specifically; could be a later, separate feature, and per the
  audit, Bastion's own messaging is *not* integrated with sign sessions
  anyway (no auto-posted "Alice signed" chat messages), so there's no
  dependency here to worry about.
- No personal self-service invite links (§5's explicit recommendation to
  scope that out) — contacts work via direct email lookup between existing
  accounts for v1.

## 9. Subagent breakdown

| # | Unit | Files | Depends on |
|---|------|-------|-----------|
| 1 | Contacts system | `src/lib/server/contacts.ts`, `contacts` table migration, `src/routes/api/contacts/**`, `src/routes/(app)/settings/contacts/+page.svelte` (or wherever Settings houses it) | Nothing |
| 2 | `multisig_shares` schema + service + 3-tier gate | `multisig_shares` + `multisig_keys.assigned_user_id` migrations, `src/lib/server/multisigShares.ts` (`getViewableMultisig`/`getSignableMultisig`/`shareMultisig`/`updateMultisigShare`/`revokeMultisigShare`/`redactMultisigKeysForViewer`) | Unit 1 (share creation checks accepted-contact status) |
| 3 | Route audit + gate wiring | Every route under `src/routes/api/wallets/multisig/**` and `src/routes/(app)/wallets/multisig/**` reviewed and assigned to owner/viewer/cosigner per §3 | Unit 2 (needs the gate functions to exist, even as stubs, to wire against) |
| 4 | `multisig_transaction_signers` + roster/notification wiring | New table migration, `buildMultisigDraft`/`attachMultisigSignature` extended per §4, `notify()` calls at creation AND each signature | Unit 2 (needs `assigned_user_id`), `docs/NOTIFICATION-PLAN.md` Unit 1's `notify()` contract (code against the documented signature if that plan's code hasn't merged yet) |
| 5 | Shared-wallet list + "Shared by X" UI | `/wallets` list query extended to include shares, badge UI | Unit 2 |
| 6 | Collaborators UI (share/revoke/assign-key) | New "Collaborators" section on the multisig detail page | Units 1, 2 |
| 7 | Sign-session roster UI (waiting-on/signed-by, per-user grouping) | Extends the existing multisig send flow's signing-progress display | Unit 4 |

**Build order**: Unit 1 has zero dependencies, start immediately. Unit 2
depends only on Unit 1's contact-check being callable (can stub against the
documented function signature). Units 3-7 fan out from Unit 2's gate
functions and Unit 4's roster table — all can proceed in parallel once
those two land, coding against this document's contracts in the meantime
exactly as the notification and hardware plans describe. Unit 3 (the full
route audit) is tedious but not hard — budget real time for it anyway, since
"which routes are viewer-reachable" is a security decision, not a
formality, and getting one route wrong either leaks a wallet's existence
(missed 404) or blocks a legitimate cosigner (over-restricted).
