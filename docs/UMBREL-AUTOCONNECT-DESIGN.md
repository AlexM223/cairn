# Umbrel zero-config Electrum auto-connect

Status: Wave A shipped (2026-07-12, cairn-hxfn). Reconstructed from the
shipped code after the original scratchpad design doc
(`scratchpad/sprint/UMBREL-AUTOCONNECT-DESIGN.md`) was lost to a reboot before
being committed. This is now the canonical design reference — code comments
in `chainEnvSeed.ts` / `umbrelProbe.ts` cite section numbers here.

## 1. Goal

A fresh Umbrel install of Cairn should connect to the operator's own
Electrum-compatible backend (electrs / Fulcrum / ElectrumX) automatically,
with no manual Admin -> Settings step and no requirement that Cairn's Umbrel
manifest declare a hard `dependencies:` entry on those apps. Without this, a
fresh install silently keeps using the public-server default
(`electrum.blockstream.info`) — worse privacy (address clustering visible to
a third party) than a self-sovereignty product should ship with by default.

Two independent mechanisms cover this, in order:

- **Wave A2 — env-var seed** (`chainEnvSeed.ts`, cairn-loq7, shipped
  2026-07-11): if Cairn's Umbrel manifest *does* declare a dependency on
  `bitcoin`/`electrs`, Umbrel injects connection details as
  `CAIRN_ELECTRUM_HOST/PORT/TLS` and `CAIRN_CORE_RPC_URL/USER/PASS` container
  env vars, which this module reads once at boot.
- **Wave A1 — Docker-network probe** (`umbrelProbe.ts`, cairn-hxfn, shipped
  2026-07-12): covers the more common case where no manifest dependency is
  declared (Cairn deliberately keeps electrs/Core as *optional*, per the
  "no node required" positioning tracked in cairn-2ldr) but the operator has
  electrs/Fulcrum/Core running anyway. Every Umbrel app shares the same
  `umbrel_main_network` Docker bridge regardless of declared dependencies, so
  a credential-free Electrum handshake against Umbrel's fixed, well-known
  service IPs finds it without needing the manifest entry at all.

Both are strictly Umbrel-only and both are pure best-effort convenience: if
neither applies, the existing public-server default / manual Admin ->
Settings entry works exactly as it always has.

## 2. Gating conditions

Both mechanisms share two gates, checked in this order every boot:

1. **Platform gate.** Only run when `CAIRN_PLATFORM === 'umbrel'` — an env
   var Cairn's own Umbrel store-package compose sets, never inferred from
   any other signal. This is what stops the probe from ever touching
   `10.21.21.x` on a non-Umbrel deployment (Docker Compose, bare metal, a
   different home-server platform), where those addresses are meaningless
   or could even collide with something else on the operator's LAN.
2. **Not-yet-configured gate.** Only run when `connection_mode` has never
   been set. Once an admin (or either seed mechanism) has picked a mode, nothing
   auto-reconfigures it again — every later boot is a no-op for both
   mechanisms. This makes both idempotent across restarts and guarantees a
   manual Admin -> Settings edit is never clobbered by the next container
   restart, forever (env vars in a compose file don't go away just because
   the admin overrode them once).

`chainEnvSeed.ts` runs first in `hooks.server.ts`'s `init()`, immediately
followed by `umbrelProbe.ts`. Because the env seed flips `connection_mode` to
`'custom'` the moment it adopts an env-provided host, the probe's own
not-yet-configured gate means **env always wins over probe** for free — no
extra coordination code needed between the two modules.

## 3. Probe order: electrs before Fulcrum

`umbrelProbe.ts` tries, in order:

1. `10.21.21.10:50001` — electrs
2. `10.21.21.200:50002` — Fulcrum

on the first reachable candidate, wins. Rationale for the order:

- Electrs is the more commonly installed Umbrel Electrum backend and is
  first alphabetically/historically in Umbrel's own app catalog conventions
  for fixed service IPs, so it's the more likely hit — checking it first
  minimizes probe latency on the common path.
- ElectrumX also exists on Umbrel and technically `implements: electrs` in
  Umbrel's app-store metadata, meaning it shares electrs's advertised
  service identity rather than reserving a separate fixed IP — so probing
  the electrs IP transparently covers an ElectrumX install too.
- Fulcrum's own `exports.sh` aliases electrs's environment variables
  whenever electrs itself isn't installed, so it's the natural fallback
  candidate; it gets a distinct fixed IP (`10.21.21.200`) and port (`50002`,
  its own default) reserved for exactly this case.

Each probe is a real `ElectrumClient.headersSubscribe()` handshake (not just
a TCP connect) with a short 2-second timeout, because this runs
synchronously during server boot (gated to Umbrel only) and an unreachable
candidate must fail fast rather than eating the client's normal ~15s default
timeout twice in a row.

## 4. Seed-once semantics

Both mechanisms use the identical `seedIfUnset(key, value)` pattern (each
module keeps its own private copy rather than sharing an import, so either
module's seed contract stays independently auditable without cross-module
reasoning): write a `settings` row only if no row exists yet for that key.
On a successful probe, `umbrelProbe.ts` writes, in this order:

1. `electrum_host` (only if unset)
2. `electrum_port` (only if unset)
3. `electrum_tls` = `'false'` (only if unset — both electrs and Fulcrum are
   probed as plain TCP, no TLS, since they're reached over the trusted
   internal Docker bridge, not the public internet)
4. `connection_mode` = `'custom'` (only if still unset — re-checked here
   rather than assumed from the boot-time gate purely to keep this module's
   logic trivially comparable to `chainEnvSeed.ts`'s, even though a
   concurrent write between the two checks isn't actually possible in this
   single-threaded init path)
5. `chain_provisioned_by` = `'umbrel-probe'` (only if unset)

Any individual key an admin has already customized (e.g. a non-default
`electrum_port` set before Umbrel's electrs was ever installed) is left
untouched even if the rest of the seed proceeds — each key has its own
independent seed-once check, not one all-or-nothing guard.

## 5. Provenance stamps: `umbrel-env` vs `umbrel-probe`

`chain_provisioned_by` (exposed on `InstanceSettings.chainProvisionedBy`,
`src/lib/types.ts`) records *which* mechanism auto-connected the instance,
purely for the settings UI to render an "auto-connected" card — it never
affects which connection is actually used:

- `'umbrel-env'` — written by `chainEnvSeed.ts`, **only** when the
  env-provided `CAIRN_ELECTRUM_HOST` was actually adopted (i.e. `electrum_host`
  was unset and got written this call). If an admin's own pre-existing custom
  host silently blocked that write, this stamp is *not* applied — otherwise a
  manually-entered connection would get mislabeled as auto-connected.
- `'umbrel-probe'` — written by `umbrelProbe.ts` on a successful handshake.
- `null` — a manually-entered custom connection, or the public-server
  default; no auto-connect mechanism has ever fired for this instance.

## 6. Failure behavior: silent fall-through

Neither mechanism ever throws. `umbrelProbe.ts` wraps its entire body in a
try/catch that logs and returns an empty applied-keys list on any error —
a bad env var, a network probe timeout, connection refused, a malformed
handshake response, or literally anything else. `hooks.server.ts` further
wraps both calls in their own try/catch during `init()`. The net effect: if
nothing is reachable (or something unexpected goes wrong), the instance
boots exactly as it would have with neither mechanism present — the
existing public-server default is live, and the connection wizard / Admin ->
Settings custom-connection form work normally for a manual setup.

## 7. What Wave B might add

Not yet built. Candidate follow-on work, gated behind the same
`CAIRN_PLATFORM === 'umbrel'` + not-yet-configured pattern:

- **Bitcoin Core RPC detection.** The current probe only covers Electrum-
  compatible backends. A parallel credential-free-where-possible probe
  against Umbrel's Bitcoin Core app (fixed IP + default RPC port) could seed
  `core_rpc_url` the same way, though Core RPC normally requires credentials
  the probe doesn't have — this would likely need to read Umbrel's own
  exported RPC credentials file from a shared volume rather than a pure
  network handshake, which is a materially different (and more sensitive)
  mechanism than the Electrum probe and needs its own design pass.
- **Manifest-declared soft dependency**, if Umbrel's app-proxy framework
  ever adds an optional/soft dependency primitive (see cairn-2ldr option b,
  currently rejected because Umbrel dependencies are hard install-blockers
  today) — would let Cairn advertise the relationship in its manifest
  without forcing electrs to be a hard prerequisite.
- **Settings-UI surfacing** of *which* candidate matched (electrs vs.
  Fulcrum vs. ElectrumX) beyond the generic `umbrel-probe` stamp, if users
  want to see it — currently informational-only and not requested.
