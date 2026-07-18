# Live Updates Design: One Multiplexed SSE Stream

Status: canonical design. This document is the source of truth for Cairn's real-time
update system. Any implementation, bead, or follow-up plan that touches live/streaming
behavior should defer to this doc — if code and doc disagree, that's a bug in one of them.

Goal: mempool.space-feel live UX everywhere in Cairn. No manual refresh, no stale tips,
no drift between what the server knows and what the browser shows.

## 1. Architecture: one multiplexed SSE stream

Cairn moves from multiple special-purpose SSE endpoints to a single multiplexed stream.

- **New endpoint:** `/api/live`. One `EventSource` per browser tab, full stop.
- **Rationale:** HTTP/1.1 caps a browser at 6 connections per origin. Umbrel and Tor
  Onion Service traffic is HTTP/1.1-only (no h2 multiplexing at the proxy). Today's two
  SSE endpoints already eat into that budget; adding more topic-specific streams would
  start starving ordinary `fetch()` calls (page loads, actions, polling that remains).
  One connection, many logical topics, solves this permanently.
- **Migration path:** the existing `/api/events` and `/api/notifications/stream`
  endpoints become **thin shims** — they stay live and functionally correct during the
  migration window, but internally they just forward frames from the new `liveHub`.
  They are retired outright at the end of Wave 3, once every consumer has moved to
  `/api/live`.

### 1.1 Topic model

- SSE events are **named** (`event: block`, `event: wallet`, etc.), not a single
  generic `message` type multiplexed by payload inspection.
- **Scoping is server-derived from the session**, never from client-supplied
  identifiers. A connection's `userId` and `isAdmin` come from the authenticated
  session that opened `/api/live` — the client cannot ask to see another user's
  frames by passing a `userId` query param or similar. This is a hard security
  boundary (see §6).
- `?topics=` is an **optional suppression hint**, not an authorization mechanism. Its
  only purpose is to let a client opt out of a heavy topic it doesn't currently need
  (e.g. `mempool` on a page that has no fee UI). Default behavior — no `?topics=` — is
  to receive **all topics the connecting user is entitled to**; the client-side router
  simply ignores frames for topics no component has subscribed to. This keeps the
  server-side branching simple (publish to everyone entitled, let the client filter)
  and means a forgotten `?topics=` never silently breaks a feature.

### 1.2 No replay buffers

- There is **no `Last-Event-ID` replay buffer** anywhere in this design. On every
  connect or reconnect, the server **primes current state**: current block tip,
  current health, current unread count, and current mempool snapshot if the connection
  wants it. This happens as a small burst of frames immediately after the connection
  opens, before any incremental deltas.
- Consequence: reconnection is self-healing by construction. A dropped connection,
  a laptop sleep/wake, a Wi-Fi blip, a service worker reload — all of it resolves to
  "reconnect, get primed, continue." A stale tip is structurally impossible because the
  client never has to reason about "what did I miss between disconnect and reconnect."
- This trades a small amount of reconnect bandwidth (a handful of small JSON frames)
  for eliminating an entire class of replay-buffer bugs (buffer overflow, buffer
  eviction races, duplicate-delivery on replay). Given Cairn's frame sizes and
  reconnect frequency, that trade is a clear win.

### 1.3 Connection lifecycle

The connection lifecycle reuses Cairn's existing, already-battle-tested SSE pattern
rather than inventing a new one:

- `ReadableStream` response with a 25-second heartbeat comment/frame to keep
  intermediary proxies (including Tor) from timing the connection out.
- Idempotent cleanup on `cancel()`/`abort()` — removing a connection from `liveHub`'s
  connection set must be safe to call more than once and safe to call from either the
  stream's cancel callback or an explicit server-side disconnect.

## 2. Event taxonomy

All frames are deltas or current-state snapshots — never a diff format requiring the
client to replay history. Initial data on page load continues to come from SvelteKit's
`load()`; the live stream only carries what changed *after* that load fired.

| Event | Scope | Payload | Cadence |
|---|---|---|---|
| `block` | broadcast | `{ height, hash? }` | On Electrum header event (existing dedupe logic applies) |
| `mempool` | broadcast, suppressible via `?topics=` | `{ count, vsizeVb, feeHistogram: [fee, vsize][], mempoolBlocks?, updatedAt }` | At most 1 per 5s, from a single shared ticker |
| `health` | broadcast | `{ electrum: 'up' \| 'down' \| 'degraded', tipHeight, tipAgeMs }` | On Electrum connect/disconnect/reconfigure, and on new tip |
| `wallet` | user-scoped | `{ walletKind: 'wallet' \| 'multisig', walletId, txid, event: 'received' \| 'confirmed' \| 'replaced' \| 'large', amountSats }` | Per `addressWatcher` diff |
| `notification` | user-scoped | `{ unread }` | Per `notify()` call |
| `mining` | user-scoped | `{}` (nudge only) | On `MiningAggregates` flush (~15s), plus immediately on block-found |
| `mining:pool` | admin-only, broadcast to admins | `{}` (nudge only) | On aggregates flush |

Notes:

- There is **no `activity` topic**. The activity feed is not a first-class stream —
  it reacts to `notification` and `wallet` frames it already receives, and re-derives
  its view from those. Adding a redundant `activity` topic would just be the same
  information published twice.
- `mining` and `mining:pool` are intentionally empty-payload **nudges**: the client
  reacts by invalidating the relevant cached data (see §4), not by trusting an inline
  payload. Mining aggregates are expensive enough to compute that we don't want to
  duplicate that computation into every SSE frame — one flush, one DB-backed
  invalidation, done.
- Every broadcast-scope event still respects the "entitled" rule from §1.1 — e.g.
  `mining:pool` is scoped to admins at publish time, not filtered client-side.

## 3. Server: `liveHub`

A new module, `src/lib/server/liveHub.ts`, is the single place that owns the set of
live connections and the single place that fans frames out to them.

### 3.1 Shape

```
Connection = { userId, isAdmin, wantsMempool, send }
liveHub: Set<Connection>

publish(topic, scope, data)
  scope = { broadcast: true } | { userId }
```

- `publish()` is called with a **fully-built payload** — the publisher (the code that
  knows about the block, the wallet event, the notification) builds the payload
  exactly once. `publish()` then iterates the connection set and filters by scope; it
  does not build or transform payloads per-recipient.
- **Hard invariant: `publish()` never reads SQLite.** This is deliberate and
  non-negotiable. Cairn has twice been bitten by event-loop stalls caused by
  synchronous SQLite reads on a hot path (cairn-xlrm, cairn-qyvl) — a fan-out routine
  that touches the DB once per connection, on every event, at scale, is exactly the
  shape of bug that caused those incidents. All data needed for a frame must already
  be in hand before `publish()` is called.

### 3.2 Relationship to `notifyBus`

`notifyBus` (the existing internal notification pub/sub) is **untouched**. `liveHub`
subscribes to it exactly once at module load and republishes matching events as
`notification` frames. This keeps `notifyBus` consumers (e.g. email/webhook delivery,
if any) working unmodified.

### 3.3 Block/header fan-out

Today, each SSE connection independently registers an `electrum.on('header')`
listener — meaning N connections means N listeners means N redundant handler
invocations per new block. This design replaces that with a **single process-level
listener**, registered once via `chainEvents.ts`, which computes the `block` (and
`health`) payload once and calls `liveHub.publish()` once. Header handling gets
cheaper as the number of connected clients grows, not more expensive.

### 3.4 Publishers

| Publisher | File | Topics | Notes |
|---|---|---|---|
| Address watcher | `src/lib/server/addressWatcher.ts` | `wallet` | Emitted next to the existing `notify()` call site — it already holds `kind`/`walletId`/`userId`/`txid`/`amountSats` in scope, so no new lookups are needed. |
| Chain events | `src/lib/server/chainEvents.ts` | `block`, `health` | Single process-level `electrum.on('header')` listener per §3.3. |
| Mining aggregates | `src/lib/server/mining/aggregates.ts` (`flush()`) | `mining`, `mining:pool` | Nudge on normal flush cadence; nudge immediately (out of band) on block-found. |
| Live tickers | `src/lib/server/liveTickers.ts` (new) | `mempool` | Single shared 5-second `unref()`'d interval, active only while at least one connection wants mempool data. Reads the existing SWR-cached mempool snapshot — one read per tick per process, not per connection. Diffs against the last emitted payload and only publishes on change. |

### 3.5 Hardening follow-up (explicitly deferred, not Wave 1)

A per-connection **bounded outbound queue with drop-and-collapse** for coalescable
topics (e.g. if a slow client is behind by three `mempool` frames, collapse to the
latest one rather than buffering all three or blocking the publisher). This matters at
scale but is not required for correctness at Cairn's current connection counts, so it
is scoped out of Wave 1 and tracked as its own follow-up bead (see §7).

## 4. Client

### 4.1 `liveClient` singleton

A new module, `src/lib/live/liveClient.ts`, owns exactly one `EventSource` per tab and
is the only thing in the client codebase allowed to construct one.

- Reuses the reconnect/visibility logic already proven in `sseReconnect.ts` and
  `liveBlocks.ts` — reconnect on visibility change, detect a stale connection via a
  watchdog timer, back off on repeated failures.
- Exposes `subscribe(topic, handler)`. Internally it dispatches incoming named SSE
  events into **per-topic Svelte 5 rune stores** under `src/lib/live/`:
  - `tipHeight.svelte.ts`
  - `mempoolStats.svelte.ts`
  - `chainHealth.svelte.ts`
- Components never construct or hold an `EventSource` themselves — they read the rune
  stores via `$derived`. This keeps connection lifecycle centralized and makes it
  impossible for a component to accidentally open a second connection.
- **Global topics** (`block`, `health`, `notification`) are subscribed once, from the
  root app layout, and live for the lifetime of the tab. **Scoped topics**
  (`wallet`, `mining`) are subscribed per-page, added on mount and removed on unmount,
  so a user browsing away from a wallet detail page stops receiving frames for it.

### 4.2 Payload-driven vs. invalidate-driven

Every surface picks one of two update strategies — this is a hard rule, not a
per-component judgment call:

- **Payload-driven** (render directly off the SSE payload, no `fetch()`): for cheap,
  self-contained UI — counters and ticks. Confirmation counts, tip height, mempool
  tiles, the fee histogram, the health banner.
- **Invalidate-driven** (the frame is a nudge; the client triggers a tag-scoped
  reload): for heavyweight or relational data that's expensive or awkward to inline
  into an SSE payload — lists. Wallet detail/list, home balances, activity feed,
  mining tables, explorer aggregates. This reuses the existing `cairn:*` invalidation
  tags and `triggerChainRefresh` machinery rather than introducing a second
  invalidation system.
- Invalidations are **debounced ~800ms client-side**, so a single block that touches
  many addresses in one wallet collapses into one reload instead of one reload per
  affected address.

### 4.3 Single confirmation source

Confirmation-count bugs (the cairn-1n11 class) have historically come from multiple
places in the codebase independently computing "how many confirmations does this tx
have" slightly differently, or from different pieces of code getting the tip height at
different times. This design fixes that **structurally**, not by convention:

```
// src/lib/confirmations.ts
confirmationsFor(txBlockHeight: number | null, tip: number): number
  txBlockHeight == null || txBlockHeight <= 0 → 0
  else → max(0, tip - txBlockHeight + 1)
```

- This is a pure function with no I/O and no hidden state.
- **Every** confirmation display in the app — badges, transaction detail text,
  progress pips, status classification (unconfirmed/confirming/confirmed) — is
  required to render through `confirmationsFor`, fed by the shared `tipHeight` rune.
  No component is permitted to maintain its own copy of the tip or its own
  confirmation math.
- Direct consequence: this kills three separate polling loops that existed only to
  keep confirmation counts fresh — the activity feed's 10s poll, mining's 10s poll,
  and chain-health's 15s poll. Once `tipHeight` is live and every confirmation display
  derives from it, polling for "did the count change" is redundant by construction.

## 5. Per-surface wiring

| Surface | Topics consumed | Strategy |
|---|---|---|
| Home | `block`, `wallet`, `health` | Payload-driven (tip, health) + invalidate (balances) |
| Wallet detail — single-sig | `block`, `wallet` | Payload-driven confirmations, invalidate on wallet event |
| Wallet detail — multisig | `block`, `wallet`, `notification` (pending signatures) | Same as single-sig + notification nudge for pending cosigner action |
| Send | `block`, `wallet`, `mempool` | Payload-driven live fee suggestion from mempool fee histogram |
| Activity feed | `notification`, `wallet` | Invalidate-driven, debounced; **poll removed** |
| Explorer landing | `block`, `mempool`, `health` | Payload-driven |
| Explorer block/tx/address pages | `block` | Confirmations recompute payload-driven; tx page invalidates on inclusion |
| Explorer mempool page | `mempool` | Payload-driven |
| Mining — user view | `mining` (nudge) | Invalidate `cairn:mining:me`; **poll removed** |
| Mining — admin view | `mining:pool` (nudge) | Invalidate admin mining tables |
| Health banner | `health` | Payload-driven; **poll removed** |
| Notification bell | `notification` | Payload-driven; transport swap only (no behavior change) |

## 6. Security

Scoping is enforced **server-side, at publish time**, based on the authenticated
session that opened the connection — this is the load-bearing security property of
the whole design and is called out explicitly here so it isn't lost in implementation:

- A `userId`-scoped `publish()` call only reaches connections whose `Connection.userId`
  (set once, at connection time, from the session) matches. The client never supplies
  a `userId` that the server trusts.
- `mining:pool` frames only reach connections with `Connection.isAdmin === true`,
  set the same way.
- `?topics=` can only narrow what a client *chooses* to render; it can never be used
  to request another user's data, because entitlement is decided before the
  `?topics=` hint is even consulted.

## 7. Waves

| Wave | Scope | Deliverable |
|---|---|---|
| **Wave 1** | `liveHub` + `/api/live` (with `block` and `notification` folded in first) + `liveClient` + `tipHeight` store + `confirmations.ts`. Point `liveBlocks.ts`'s `onNewBlock` at the new hub. Wire all existing confirmation displays through `confirmationsFor`. Old `/api/events` / `/api/notifications/stream` become shims. | Live confirmations everywhere. |
| **Wave 2** | `addressWatcher` emits `wallet` frames. Home, wallet detail (single + multisig), and activity feed consume them. Activity feed's 10s poll removed. | Balances and transaction lists update live. |
| **Wave 3** | `liveTickers` mempool ticker; mining nudges; health frames. Remaining polls (mining 10s, health 15s) removed. Old shim endpoints retired. | Explorer, mining, and health surfaces are fully live. |

A **priority-2 follow-up**, tracked separately from the three waves, covers the
per-connection bounded-queue hardening described in §3.5.

## 8. Testing

- **Pure unit matrix for `confirmationsFor`:** unconfirmed (`null`/`0`/negative
  height), 1-conf, N-conf, and a reorg-clamp case (tip height moves backward — result
  must not go negative).
- **`liveHub` scope isolation — security-critical.** Explicit tests asserting a
  `wallet` frame scoped to user A never reaches a connection for user B, and that
  `mining:pool` frames never reach a non-admin connection. This is the single most
  important test in the suite given §6.
- **Throttle/debounce behavior** using fake timers: the `mempool` ticker's 5s cadence,
  the client's ~800ms invalidation debounce.
- **Handler integration tests:** a mocked Electrum header event results in the correct
  `block` frame; a `notify()` call results in a correctly-scoped `notification` frame;
  connection `cancel()`/`abort()` removes the connection from `liveHub` and is safe to
  call more than once.
