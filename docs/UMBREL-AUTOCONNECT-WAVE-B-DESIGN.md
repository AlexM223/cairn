# Umbrel zero-config Bitcoin Core RPC — Wave B (detect-and-surface)

Status: DESIGN ONLY (2026-07-12, bead cairn-ylz5, P1). Not yet built. Companion
to `docs/UMBREL-AUTOCONNECT-DESIGN.md` (Wave A, shipped) — read that first; this
doc reuses its gating vocabulary (platform gate, seed-once, provenance stamp,
silent fall-through) and only describes what is *different* for Core RPC.

## 0. TL;DR — the honest conclusion

**Silent, fully-automatic Core RPC auto-connect (the Wave A model) is
impossible without a manifest dependency.** Wave A works because an Electrum
handshake is *credential-free*. Bitcoin Core's JSON-RPC is not: every call
needs a username/password that lives only inside the Umbrel Bitcoin app's
private `.env`, injected only into apps that declare a hard
`dependencies: [bitcoin]` manifest entry — which Cairn deliberately does not
declare (the "no node required" positioning, cairn-2ldr). Umbrel exposes **no
cookie file** to non-dependent apps and runs bitcoind **without `-rest`**, so
there is no unauthenticated endpoint to lean on either.

Therefore Wave B is **detect-and-surface, not silent-connect**:

1. A credential-free *detection* probe confirms Umbrel's bitcoind is listening
   at the well-known `10.21.21.8:8332` (an unauthenticated JSON-RPC POST that
   comes back `401 Unauthorized` uniquely fingerprints bitcoind's HTTP-RPC
   listener).
2. On detection we seed **one advisory marker** (`core_rpc_detected='umbrel'`).
   We seed **no** `core_rpc_*` connection settings and change nothing about the
   live chain config — Core stays "not configured" until a human acts.
3. The settings provenance card (cairn-mz9p, extended here) renders an
   **assisted-connect** banner with the URL (`http://10.21.21.8:8332`) and user
   (`umbrel`) **pre-filled from hardcoded constants**, leaving the admin a
   single field to complete: paste the RPC password (copyable from the Umbrel
   Bitcoin app's own "Connect" screen). Submit runs the existing
   `testCoreRpc()` validation before it becomes live.

This turns a blind four-field manual setup (know the IP, the port, the user,
find the password) into a one-glance discovery + one-paste connect, without
ever adopting credentials off the wire or degrading the clean "not configured"
empty-state into a silent 401 storm.

## 1. Goal

An Umbrel operator who is running the Bitcoin Node app but has **not** wired it
to Cairn as a manifest dependency should, with near-zero effort, be able to
connect Cairn's Core-RPC-gated explorer features (block/tx detail, CPFP
ancestry, `estimatesmartfee`) to their own node — instead of the current state
where those surfaces render `CoreRpcRequiredNotice` empty-states
(`src/lib/components/CoreRpcRequiredNotice.svelte`) and the admin must fill the
custom-connection Core RPC fields entirely by hand.

"Near-zero" not "zero": the credential wall (§3) makes one human paste
irreducible on the no-dependency path. Full zero-config Core RPC is already
solved for the *dependency* path by Wave A2 (`chainEnvSeed.ts`, env vars
`CAIRN_CORE_RPC_URL/USER/PASS`); Wave B covers the no-dependency path that env
seeding cannot reach.

## 2. Evidence: how Umbrel exposes Bitcoin Core (questions a & b)

All verified 2026-07-12 against `getumbrel/umbrel-apps` (the `bitcoin` app) and
`getumbrel/umbrel-bitcoin`:

| Fact | Value | Source |
|------|-------|--------|
| bitcoind fixed IP on the shared bridge | `10.21.21.8` (`$APP_BITCOIN_NODE_IP` / `BITCOIND_IP`) | umbrel-apps `bitcoin/docker-compose.yml`; umbrel-bitcoin `docker-compose.yml` |
| RPC port | `8332` (`$APP_BITCOIN_RPC_PORT`) | `bitcoin/exports.sh` |
| RPC user | `umbrel` (default) | `bitcoin/exports.sh` (`APP_BITCOIN_RPC_USER`) |
| RPC password | cryptographically generated per-install, persisted in the bitcoin app's private `.env` (dev default `moneyprintergobrrr`) | `bitcoin/exports.sh` (generated via `rpcauth.py`) |
| RPC accepts connections from | `rpcallowip = <bridge subnet>/16` — i.e. **any** app on `umbrel_main_network` may *connect*, but must still *authenticate* | `bitcoin/docker-compose.yml` |
| Cookie file exported to other apps | **none** — Umbrel uses `rpcauth` user/pass, exports no `.cookie` path; bitcoind's datadir cookie is mounted only into the bitcoin app's own containers | `bitcoin/exports.sh` (no cookie var) |
| `-rest` (unauthenticated REST API) | **not enabled** | `bitcoin/docker-compose.yml` (absent) |
| `txindex` | **enabled by default** (`txindex=1`) | umbrel PR #305 "Add txindex=1 to bitcoin.conf" |
| Pruning | **off by default** (full node); pruning is an advanced opt-in | umbrel-bitcoin advanced settings |

Two conclusions fall straight out of this table:

- **`rpcallowip=/16` means our detection probe can reach the port** — the TCP
  connect + HTTP `401` round-trip is reliable from any app on the bridge, no
  dependency needed. (Same trust boundary Wave A relies on for electrs.)
- **Auth is a hard wall for a non-dependent app.** The generated password is
  neither injected into our env (no dependency) nor readable via a shared
  volume/cookie (none is mounted) nor bypassable (`-rest` off). A network probe
  fundamentally cannot obtain it. This is exactly the "materially different and
  more sensitive mechanism" the Wave A doc §7 flagged.

The one *good* piece of news: `txindex=1` on, pruning off means a **default
Umbrel Core fully serves every Core-RPC-gated explorer feature** (arbitrary
`getrawtransaction` works) once connected — so the payoff of connecting is
real and complete, not partial.

## 3. Why not silent auto-connect (question c) — options weighed

- **(rejected) Silently seed `core_rpc_url=http://10.21.21.8:8332` with no/guessed
  creds.** Every RPC call 401s. This is strictly *worse* than today's clean
  `CoreRpcRequiredNotice` empty-state: `getChainConfig()` would hand
  `ChainService` a `coreRpcUrl`, `this.core` becomes non-null
  (`chain/index.ts` ~L580), and explorer detail pages would swap the honest
  "connect Core" notice for a live-looking surface that errors on every load.
- **(rejected) Scrape credentials from "anywhere" on the bridge.** There is
  nowhere to scrape (no cookie mount, no env). Even hypothetically, auto-adopting
  an off-the-wire secret is a trust escalation we will not do implicitly (§7).
- **(rejected, not ours to take) Declare a hard `dependencies: [bitcoin]`.**
  That would make Wave A2 env-seeding fire and fully auto-connect Core —
  silently and correctly — but Umbrel dependencies are hard install-blockers
  with no soft/optional primitive (cairn-2ldr option b, already rejected on
  positioning grounds). If Umbrel ever ships an optional-dependency primitive,
  that becomes the superior path and Wave B's detect-and-surface can be retired.
- **(chosen) Detect-and-surface with a one-paste assisted connect.** Honest,
  safe, and reduces friction to the single irreducible step (the password),
  which the admin can copy directly from Umbrel's Bitcoin app UI.

## 4. Gating conditions

Shares Wave A's **platform gate** verbatim: run only when
`CAIRN_PLATFORM === 'umbrel'`, so the probe never dials `10.21.21.8` on a
non-Umbrel deployment where that address is meaningless or could collide with
something on the operator's LAN.

The **not-yet-configured gate is different from Wave A's**, and this is the
single most important design decision in the doc:

> Core RPC is a **separate concern from `connection_mode`/Electrum.**
> `getChainConfig()` (`settings.ts` L216-224) returns `coreRpc*` **in both
> `public` and `custom` modes** — there is no public Core fallback, so Core is
> "on" iff `core_rpc_url` is set, regardless of `connection_mode`.

So Wave B must **not** gate on `connection_mode` (Wave A's gate) and must **not**
touch it. The Core-specific gates are:

1. `CAIRN_PLATFORM === 'umbrel'`.
2. `getSetting('core_rpc_url')` is unset/empty (i.e. `coreRpcConfigured()` is
   false) — never probe/nudge once Core is already wired (by env-seed or an
   admin).
3. `getSetting('core_rpc_detected')` is unset — seed-once idempotence; the probe
   runs at most once per install and every later boot is a no-op.

Running order in `hooks.server.ts init()`: **after** `seedChainConfigFromEnv()`
(so an env-provided `core_rpc_url` from a dependency wins and gate #2 short-
circuits the probe) and alongside `probeAndSeedUmbrelElectrum()`. Because it is
a TCP/HTTP probe with a 2 s timeout it runs in the same `await` slot as the
Electrum probe.

## 5. Mechanism

`src/lib/server/umbrelCoreProbe.ts` (new), exporting
`probeAndDetectUmbrelCore(): Promise<string[]>` — same return contract as the
other two seeders (keys written this boot, folded into `seededKeys`).

```
CANDIDATE = { url: 'http://10.21.21.8:8332', label: 'umbrel-bitcoind' }
DETECT_TIMEOUT_MS = 2_000   // fail fast; this blocks boot, Umbrel-only
```

Detection is a **credential-free** POST of a trivial JSON-RPC body
(`{"jsonrpc":"1.0","id":"cairn-detect","method":"getblockchaininfo","params":[]}`)
with **no Authorization header**, using a short-timeout `fetch` (mirror the
transport hygiene in `bitcoinCore/client.ts` — unwrap the cause chain, never
let it collapse to "fetch failed"). Interpretation:

- **HTTP `401`** → **detected.** bitcoind's HTTP-RPC listener answered and
  demanded auth. This is the definitive fingerprint and the expected result.
- **HTTP `403`** → detected (some configs answer 403 to a disallowed-IP; still
  proves a bitcoind listener).
- **HTTP `503` with a warmup body / `-28`** → detected (node up but still in
  warmup; see §7 IBD).
- **Connection refused / timeout / ENOTFOUND / any transport error** →
  **not detected**, no-op, silent fall-through (Core app not installed).
- **HTTP `200`** (would only happen if a misconfigured node allowed
  unauthenticated RPC) → detected, but we still do **not** auto-connect (we
  never adopt an endpoint as live without an admin action — §7).

Critically, **we never read anything from the response body as configuration.**
The only bit we extract is "a bitcoind is present at the well-known address."
The URL and user we later surface are **hardcoded constants**, not values
learned from the responder (§7 rationale).

On detection, write exactly one key via the shared seed-once helper:

```
seedIfUnset('core_rpc_detected', 'umbrel')   // advisory marker only
```

and log `{ event: 'umbrel_core_detected', url }`. Nothing else. In particular
we do **not** write `core_rpc_url`, `core_rpc_user`, `core_rpc_pass`,
`connection_mode`, or `chain_provisioned_by`. The live chain config is
byte-for-byte identical before and after a successful detection — the only
observable effect is that the settings UI can now render the assisted-connect
banner.

Never throws (try/catch around the whole body → returns `[]`), and
`hooks.server.ts` wraps the call in its own try/catch, exactly like the other
two seeders.

## 6. Settings keys & provenance

**Seeded by the probe (server-side, seed-once):**

| Key | Value | Store | Notes |
|-----|-------|-------|-------|
| `core_rpc_detected` | `'umbrel'` | `settings` (plaintext, non-secret) | Advisory marker; drives the banner only. **Never** consulted by `getChainConfig()`. |

**Written only when the admin completes the assisted connect** (via the
existing admin-settings save path, §8): `core_rpc_url`, `core_rpc_user`,
`core_rpc_pass` (encrypted via `setSecretSetting`, as today).

**Provenance stamp.** Do **not** overload Wave A's `chain_provisioned_by` (that
key records *Electrum/connection* provenance for the electrs card and must stay
Electrum-scoped). Introduce a parallel, Core-specific marker so the two cards
are independent:

| `core_rpc_provisioned_by` | Meaning |
|---------------------------|---------|
| `null` | Core not configured, or configured by hand with no Umbrel involvement. |
| `'umbrel-env'` | Seeded fully-automatically by `chainEnvSeed.ts` from `CAIRN_CORE_RPC_*` (dependency path). *(Optional: have `chainEnvSeed.ts` stamp this when it writes `core_rpc_url` from env — a small additive change so the provenance card can say "auto-connected from your Umbrel Bitcoin app." Not required for Wave B's core function.)* |
| `'umbrel-detect'` | Admin completed the assisted-connect flow that started from `core_rpc_detected='umbrel'`. Stamped by the save path when the form carries a `coreRpcAssisted=umbrel` hidden marker. |

`core_rpc_detected` is the *pre-connect* signal; `core_rpc_provisioned_by` is
the *post-connect* provenance. Keeping them distinct is what lets the card
correctly say "detected but not yet connected" vs "auto/assisted-connected."

Add `coreRpcProvisionedBy: string | null` and `coreRpcDetected: string | null`
to `InstanceSettings` (`src/lib/types.ts`) and read them in
`getInstanceSettings()` (`settings.ts` ~L141, next to the existing
`chain_provisioned_by` read). Expose via `getPublicInstanceSettings()`
(no secret content, safe to serialize).

## 7. Security analysis (question c, expanded)

- **No credential adoption off the wire.** The probe sends only; nothing it
  receives becomes configuration. The URL/user surfaced to the admin are
  compile-time constants (`http://10.21.21.8:8332`, `umbrel`), so a hostile
  container squatting on `10.21.21.8` **cannot inject a rogue endpoint** into
  Cairn's config — the worst it can do is answer `401` and cause the banner to
  appear, which leads the admin to paste a password that then fails
  `testCoreRpc()` against the impostor. No silent adoption path exists.
- **Blast radius if a rogue Core were connected anyway is read-only.** Cairn's
  Core RPC usage is exclusively block/tx *reads* — `getblock`,
  `getrawtransaction`, `gettxout`, `getblockheader`, `getblockchaininfo`,
  `estimatesmartfee`, `getmempool*` (`bitcoinCore/client.ts` wrappers). Cairn
  **never** sends PSBTs, private keys, xpubs, or wallet state to Core RPC. So
  even a fully-compromised Core endpoint yields at most *wrong explorer data
  displayed*, never fund or key exposure. This is why an assisted (human-in-the-
  loop) connect is an acceptable trust posture here, whereas silent adoption is
  not worth even the small risk.
- **Human-in-the-loop is the gate.** The irreducible password paste *is* the
  admin's explicit intent to trust that endpoint — the correct place for the
  trust decision, consistent with the platform rule that credentials are only
  ever entered by the operator, never fabricated or scraped by the app.

## 8. Failure modes (question e)

| Scenario | Behavior |
|----------|----------|
| **Core app not installed** | Probe gets connection-refused/timeout → no marker seeded → no banner → identical to today. Silent fall-through. |
| **Core installed but syncing (IBD)** | Detection still succeeds (`401`, or `503`/`-28` during earliest warmup — both treated as detected). We seed only the marker, not a live connection, so IBD causes nothing at detect time. When the admin connects, `testCoreRpc()`'s `getblockchaininfo` returns `initialblockdownload:true`; the assisted-connect card should surface a "Core is still syncing (blocks N)" note but still allow connecting — explorer works for already-synced heights. |
| **Pruned node** | Not the Umbrel default (pruning is advanced opt-in). If an operator has pruned, arbitrary old `getrawtransaction`/`getblock` may fail `-1`/`-5`; `chain/index.ts` already degrades these to not-found / `CoreRpcRequiredNotice`. No Wave B-specific handling; document the caveat in the card copy. |
| **Wrong password pasted / auth failure** | `testCoreRpc()` returns `{ ok:false, error }` with the friendly 401 message (existing behavior). Because detection never stored creds, there is **never** a silent 401 storm — the failure only ever happens inside an explicit admin test/save. |
| **Core uninstalled later (stale marker)** | Strictly cosmetic — unlike a stale seeded `electrum_host` (which would actively break the live connection), `core_rpc_detected` is **never** the live connection. Worst case: a stale "Bitcoin Core detected" banner until dismissed. Mitigations: (a) banner only renders while `!coreRpcConfigured()`, so once connected it's gone; (b) the card should offer a **Dismiss** action that writes `core_rpc_detected='dismissed'` (still seed-once-respecting); (c) optionally the card's load can do a cheap live re-probe before rendering. If the admin *had* connected and then uninstalls, live Core calls fail and explorer falls back to the existing degraded-mode `CoreRpcRequiredNotice`/error paths. |

## 9. UI touchpoints (interface for cairn-mz9p)

cairn-mz9p ("Settings-UI provenance card for auto-connected chain backends")
already owns the admin-settings connection card. Wave B extends its data
contract; it does **not** add a second card. The card's `+page.server.ts` load
(`src/routes/(app)/admin/settings/+page.server.ts`) already exposes settings —
add these props from `getPublicInstanceSettings()`:

- `coreRpcConfigured: boolean` (from `coreRpcConfigured()`).
- `coreRpcDetected: string | null` (`'umbrel'` | `'dismissed'` | null).
- `coreRpcProvisionedBy: string | null`.
- Constants for prefill: `UMBREL_CORE_RPC_URL='http://10.21.21.8:8332'`,
  `UMBREL_CORE_RPC_USER='umbrel'` (export from `umbrelCoreProbe.ts` so server
  and card share one source of truth).

Card states the Svelte component (`+page.svelte`) must render:

1. `coreRpcConfigured && coreRpcProvisionedBy==='umbrel-env'` → "Connected
   automatically to your Umbrel's Bitcoin Core" (green, with manual-override
   link) — mirrors the electrs card.
2. `coreRpcConfigured && coreRpcProvisionedBy==='umbrel-detect'` → "Connected to
   your Umbrel's Bitcoin Core."
3. `!coreRpcConfigured && coreRpcDetected==='umbrel'` → **assisted-connect
   banner**: "Bitcoin Core detected on your Umbrel. Connect it for full block &
   transaction explorer features." Shows URL + user pre-filled (read-only or
   editable), one password field, a "where do I find this?" hint pointing at the
   Umbrel Bitcoin app's RPC/Connect screen, a **Connect** button (posts the
   assisted form → §8 save path with `coreRpcAssisted=umbrel`), and a
   **Dismiss** link.
4. else → today's plain manual Core RPC fields (unchanged).

**Save-path wrinkle to fix as part of this work:** the admin settings action
currently writes `core_rpc_*` **only inside the `if (connectionMode ===
'custom')` block** (`+page.server.ts` L101/L123-130). But Core RPC is
mode-independent (§4). The assisted-connect submit must persist `core_rpc_*`
**regardless of `connection_mode`** (and must not force-flip the operator's
Electrum `connection_mode` to `custom` as a side effect of connecting Core).
Lift the three `core_rpc_*` writes out of the custom-only block, or give the
assisted action its own handler that writes Core settings + stamps
`core_rpc_provisioned_by='umbrel-detect'` without touching `connection_mode`.
The parallel JSON endpoint `src/routes/api/admin/settings/+server.ts`
(map at L22-24) already writes `core_rpc_*` unconditionally — align the form
action with it.

## 10. Test plan

**Unit (`src/lib/server/umbrelCoreProbe.test.ts`, Vitest — mirror
`umbrelProbe.test.ts` / `chainEnvSeed.test.ts`):**

- Gated out when `CAIRN_PLATFORM !== 'umbrel'` → returns `[]`, no fetch, no
  settings written.
- Gated out when `core_rpc_url` already set (`coreRpcConfigured()`), or
  `core_rpc_detected` already present → `[]`, no fetch.
- Probe returns `401` → seeds `core_rpc_detected='umbrel'`, returns
  `['core_rpc_detected']`, writes **no** `core_rpc_url`/`user`/`pass`/
  `connection_mode`/`chain_provisioned_by`.
- Probe returns `503`/`-28` warmup body → detected (same as 401).
- Probe connection-refused / timeout / DNS error → `[]`, nothing written, no
  throw.
- Response body containing a rogue `url`/host field is **ignored** (assert the
  seeded/surfaced URL equals the hardcoded constant, not the response).
- `getChainConfig()` output is identical before vs after a successful detection
  (proves the marker never leaks into the live config).
- Seed-once idempotence: two consecutive calls seed once, second returns `[]`.

**Settings/UI:** extend
`src/routes/(app)/admin/settings/page.server.test.ts` — assisted-connect submit
writes `core_rpc_*` + stamps `core_rpc_provisioned_by='umbrel-detect'` even when
`connection_mode==='public'`, and does **not** mutate `connection_mode`; wrong
password → `testCoreRpc` fail surfaced, nothing persisted.

**Live Umbrel (umbrel-s15 test container path, per MEMORY heartwood-app-store):**

1. On `ghcr.io/getumbrel/umbrelos:1.7.4`, install the Bitcoin Node app; install
   heartwood-bitcoin (dependency-free package). Confirm boot logs show
   `umbrel_core_detected url=http://10.21.21.8:8332` and that Admin → Settings
   shows the assisted-connect banner with URL/user pre-filled.
2. Copy the RPC password from the Umbrel Bitcoin app's Connect screen, paste,
   Connect → banner flips to "Connected", `core_rpc_provisioned_by=umbrel-detect`,
   and an explorer tx/block detail page renders real data (validates the whole
   `txindex=1` payoff end to end).
3. Uninstall the Bitcoin app → confirm the stale marker only yields a cosmetic
   banner (when not connected) / graceful degraded-mode (when connected), never
   a crash or a 401 storm.
4. Negative: heartwood-bitcoin **without** the Bitcoin app installed → no marker,
   no banner, identical to today (silent fall-through).

## 11. Non-goals

- **Silent full auto-connect of Core RPC.** Impossible without a dependency
  (§0/§3); explicitly out of scope. Wave B stops at detect + one-paste.
- **Reading/guessing Core's RPC password** from any shared volume, cookie, or
  response body. There is nowhere to read it and we will not fabricate it.
- **Declaring a manifest `dependencies: [bitcoin]`.** Owned by cairn-2ldr;
  rejected on positioning grounds. If Umbrel ships an *optional* dependency
  primitive, revisit — that path supersedes Wave B.
- **Probing arbitrary LAN/host addresses or multiple candidate IPs.** Exactly
  one well-known Umbrel address, Umbrel-only, matching Wave A's tight scope.
- **Auto-enabling `txindex`/reindex on the operator's node**, or any write/
  configuration RPC against Core. Read-only, always.
- **The provenance card's visual design** — owned by cairn-mz9p / the admin
  settings redesign (cairn-zoz8.16); this doc only specifies the data contract
  it consumes.

## 12. Recommended implementation plan (units)

**Unit B1 — detection probe + settings plumbing.**
`src/lib/server/umbrelCoreProbe.ts` (new): `probeAndDetectUmbrelCore()`, the
`UMBREL_CORE_RPC_URL/USER` constants, seed-once `core_rpc_detected` marker;
`src/lib/server/settings.ts` reads `core_rpc_detected` + `core_rpc_provisioned_by`
into `getInstanceSettings()`; `src/lib/types.ts` gains the two fields;
`src/hooks.server.ts` calls the probe right after the Electrum probe and folds
the keys into `seededKeys`. Tests: `umbrelCoreProbe.test.ts`.

**Unit B2 — assisted-connect save path.**
`src/routes/(app)/admin/settings/+page.server.ts`: lift the `core_rpc_*` writes
out of the `connectionMode==='custom'` block (or add a dedicated assisted
action) so Core connects mode-independently and without flipping
`connection_mode`; stamp `core_rpc_provisioned_by='umbrel-detect'` on the
assisted path; run `testCoreRpc()` before persisting. Optionally have
`chainEnvSeed.ts` stamp `core_rpc_provisioned_by='umbrel-env'` when it seeds
`core_rpc_url` from env. Tests: extend `page.server.test.ts`.

**Unit B3 — provenance/assisted-connect card (folds into cairn-mz9p).**
`src/routes/(app)/admin/settings/+page.server.ts` load exposes
`coreRpcConfigured`/`coreRpcDetected`/`coreRpcProvisionedBy` + prefill
constants; `+page.svelte` renders the four card states in §9 incl. the
Dismiss action (`core_rpc_detected='dismissed'`). Sequence with cairn-mz9p so
the Electrum and Core cards share one component.

**Unit B4 (verification only) — live umbrel-s15 pass** per §10, gated to run
against a real Bitcoin Node app before the next heartwood-app-store package cut
(ties into the cairn-x26e "confirm the probe fires on real containers"
follow-up).

B1 is independently shippable and inert to users (marker-only). B2+B3 deliver
the visible value and should land together. B4 is the release gate.
