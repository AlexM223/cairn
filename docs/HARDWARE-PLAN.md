# Cairn Hardware Wallet Plan — Single-Sig Device Import + BitBox02/Jade Support

Status: **planning document**, not yet built. Two independent scopes, written
for Opus to execute with subagents. Read `docs/NOTIFICATION-PLAN.md`'s header
conventions if you haven't already — same rules apply here: this doc *is* the
contract, over-specified on purpose so units can build in parallel without
syncing up first.

---

# SCOPE 1: Single-sig hardware wallet import

## 1.0 Correcting the starting assumption

The task brief for this scope says "this should be straightforward — the
hardware wallet drivers already exist for multisig, just wire the same device
picker in." **That's half true, checked directly against the code**:

**What already exists and is directly reusable:**
- The device-picker UI *pattern* (method cards → connect/scan/paste per
  device) is fully built in `src/routes/(app)/wallets/multisig/new/+page.svelte`
  (functions `pickMethod`, `connectDevice`, `handleColdcardFile`, `startQrScan`/
  `handleQrText` — read that file's Keys step, roughly lines 130-410 and
  960-1100, before writing a single line of this scope's code).
- The camera-QR scanning module (`src/lib/hw/qrScan.ts`:
  `isCameraScanAvailable()`, `startScan(videoEl, onText, opts)`) is
  device-agnostic — used as-is, no changes needed.
- `src/lib/components/DevicePicker.svelte` already exists and already renders
  a Trezor/Ledger/ColdCard/QR/File tile grid — but it's currently used
  **passively**, at the end of the single-sig wizard (Step 4, "Name"), purely
  to *label* which device the user says they'll sign with later. It does not
  connect to anything.
- The wallet record already has a `device_type` column
  (`src/lib/server/db.ts`, `wallets` table) and `WalletDeviceType` type
  (`src/lib/types.ts`: `'trezor' | 'ledger' | 'coldcard' | 'qr' | 'file'`) —
  storage is a solved problem, this scope is purely about *how the xpub gets
  into Step 2* and *auto-filling the device type Step 4 already collects*.

**What does NOT exist yet and is genuinely new work — confirmed by reading
the driver files directly:**
- `src/lib/hw/trezor.ts` and `src/lib/hw/ledger.ts` only export
  `readMultisigKeyFromTrezor(scriptType: MultisigScriptType, account)` /
  `readMultisigKeyFromLedger(...)` — both hardcoded to BIP-48 multisig
  account paths (`m/48'/0'/{account}'/{2|1}'`) and both normalize the
  returned key to the multisig xpub convention. **There is no single-sig
  equivalent today.** This scope adds
  `readSingleSigKeyFromTrezor(scriptType: ScriptType, account)` /
  `readSingleSigKeyFromLedger(...)` as siblings to the multisig functions —
  same device-talking machinery, different derivation path (standard
  BIP44/49/84/86: `m/44'/0'/{account}'` for p2pkh, `m/49'/0'/{account}'` for
  p2sh-p2wpkh, `m/84'/0'/{account}'` for p2wpkh, `m/86'/0'/{account}'` for
  p2tr) and different SLIP-132 xpub normalization (xpub/ypub/zpub prefix
  matching `src/lib/server/bitcoin/xpub.ts`'s `PUBLIC_VERSIONS` table, NOT
  the multisig-only prefix `normalizeMultisigXpub` produces).
- `src/routes/(app)/wallets/multisig/new/_components/coldcardImport.ts`'s
  `parseColdcardExport(text, scriptType: MultisigScriptType)` is
  multisig-shaped (expects a multisig descriptor/redeem-script template in
  the file). ColdCard's "Generic JSON" export for a **single-sig** wallet has
  a different, simpler shape (a flat `{xpub, xfp, path}` per script type, no
  multisig template) — this scope adds a sibling parser, not a generalization
  of the existing one (don't try to make one function branch on both shapes;
  the two export formats are different enough that separate, clearly-named
  functions are more readable and testable — see how `readMultisigKeyFromX`
  and the new `readSingleSigKeyFromX` are already planned as siblings, not
  one parameterized function).
- BitBox02 and Jade are **not in `WalletDeviceType` or `DevicePicker.svelte`
  at all** — see Scope 2 below. This scope's device picker work should be
  built assuming those two tiles will be added by Scope 2's work landing
  around the same time; coordinate the `WalletDeviceType` union and
  `DevicePicker.svelte`'s `OPTIONS` array as a single shared edit both scopes
  touch (small, low-conflict-risk diff — see §3 "shared touchpoints").

## 1.1 The new flow

Replace Step 2 ("Extended public key", currently a bare paste textarea) in
`src/routes/(app)/wallets/new/+page.svelte` with the same shape as the
multisig wizard's Keys step, scoped to reading exactly one key (no "add
another key" loop — single-sig has one key by definition):

1. **Method picker**: Trezor, Ledger, ColdCard, BitBox02, Jade, Air-gapped QR,
   Paste public key (7 tiles — reuse the multisig wizard's `method-card` grid
   markup/CSS verbatim, just with 7 options instead of 5 and no "Paste" being
   visually different from the rest, since for single-sig paste is simply one
   more equally-valid method, not a fallback-after-failure state the way it's
   framed in the multisig wizard's copy).
2. **Per-device connect UI**, one `{:else if method === '...'}` branch per
   device, following the multisig wizard's existing per-device copy pattern
   exactly (short instructional paragraph + one action):
   - **Trezor / Ledger**: "Plug in your {device} and unlock it. Cairn reads
     the wallet's public key straight from the device — it can watch, never
     spend." + Connect button → `readSingleSigKeyFromTrezor`/`readSingleSigKeyFromLedger`
     (new functions, §1.0).
   - **BitBox02**: same shape, device-specific copy from Scope 2's research
     (BitBox02 requires an on-device confirmation tap even for a public-key
     read — say so: "Confirm on the BitBox02 when it asks.").
   - **ColdCard**: "On the ColdCard: **Advanced/Tools → Export Wallet →
     Generic JSON** (choose the single-sig / non-multisig option if asked).
     Move the microSD card to this computer, then choose the exported file."
     + file input → new `parseColdcardSingleSigExport` (§1.0).
   - **Jade**: two sub-choices per Scope 2's findings — if Jade ships with
     USB/Web Serial support in this same release, offer both "USB" and
     "QR" here; if Scope 2's research concludes QR-only for v1, only show
     the QR path and copy accordingly. **This scope's exact Jade UI branch
     depends on Scope 2's driver existing** — see §3 dependency note.
   - **Air-gapped QR**: "On the device, find **Export xpub** (or 'show
     wallet key as QR') and hold the code up to your camera." + camera scan
     using the existing `startScan`/`isCameraScanAvailable` — no changes
     needed to the QR module itself, single-sig just needs a key-shaped
     regex check on the decoded text (`/^[xyz]pub/i` or `/^\[/` for an
     origin-prefixed key, same heuristic `handleQrText` already uses in the
     multisig wizard).
   - **Paste public key**: the CURRENT Step 2 behavior verbatim (the existing
     textarea + "What's an xpub?" help box) — becomes one method among seven
     rather than the only option.
3. On a successful read from ANY method (device, file, QR, or paste), capture
   **both** the xpub AND which method produced it, then skip straight past
   the old standalone Step 4 device-labeling question — **it's now redundant
   for every method except Paste** (if a Trezor produced the key, we already
   know `deviceType = 'trezor'`; only a pasted key still needs the "which
   device holds this key?" question, since paste is deliberately
   device-agnostic). Concretely: keep `DevicePicker.svelte` on Step 4, but
   pre-select it based on which method was used in Step 2, and only actually
   show it as an interactive, unset choice when `method === 'paste'`.
   Otherwise show it as a small confirmed summary ("Signing device: Trezor")
   with a "change" link that reveals the picker if the user really did use a
   different device than what read the key (rare, but don't make it
   impossible — e.g. someone reads a Ledger's xpub via QR because their
   browser lacks WebHID, and the signing device really is a Ledger, not
   "QR").
4. Preview (Step 3, addresses derived from the key) and Name (Step 4, now
   showing the pre-filled/confirmed device) are otherwise unchanged.

## 1.2 File-level plan

| File | Change |
|---|---|
| `src/lib/hw/trezor.ts` | Add `readSingleSigKeyFromTrezor(scriptType: ScriptType, account = 0)`, sibling to `readMultisigKeyFromTrezor` (§1.0) — same `TrezorConnect.getPublicKey` call shape, single-sig BIP44/49/84/86 path via a new `singleSigAccountPath(scriptType, account)` helper (mirrors the existing `multisigAccountPath`), normalize the returned xpub via the SLIP-132 single-sig prefix table (import from `xpub.ts` or replicate the 4-entry map — p2pkh/p2sh-p2wpkh/p2wpkh/p2tr — do not reuse `normalizeMultisigXpub`, it's the wrong prefix family). Add a matching unit test in `trezor.test.ts` (the existing multisig reader tests are the template). |
| `src/lib/hw/ledger.ts` | Same addition, `readSingleSigKeyFromLedger`, mirroring `readMultisigKeyFromLedger`. Ledger's `PURPOSE_TEMPLATE` map (`44: 'pkh(@0/**)'` etc. — already present in this file per earlier work) already covers single-sig purposes; this function is largely "call the existing plumbing with a single-sig template and a non-multisig path" rather than new protocol work. |
| `src/routes/(app)/wallets/new/_components/deviceRead.ts` (**new** — sibling to the multisig wizard's `deviceRead.ts`, same dynamic-import-with-graceful-fallback pattern) | `readKeyFromTrezor(scriptType: ScriptType)` / `readKeyFromLedger(scriptType: ScriptType)` / `readKeyFromBitbox02(...)` / `readKeyFromJade(...)`, each a thin wrapper matching the existing `callReader` helper shape in the multisig version. Re-export `DeviceReadUnavailable`. |
| `src/routes/(app)/wallets/new/_components/coldcardImport.ts` (**new**) | `parseColdcardSingleSigExport(text: string, scriptType: ScriptType): { xpub, fingerprint, path }`, sibling to the multisig version, different expected JSON shape (confirm the exact single-sig ColdCard "Generic JSON" export shape against a real export or ColdCard's own firmware docs/source before writing the parser — don't guess the field names). |
| `src/routes/(app)/wallets/new/+page.svelte` | Step 2 rebuilt per §1.1. Reuse the multisig wizard's `method-card`/`connect-box`/`file-drop` CSS classes verbatim (copy the `<style>` blocks, don't reinvent) so the two wizards stay visually identical. Step 4 updated per §1.1 point 3. |
| `src/lib/components/DevicePicker.svelte` | No structural change *for this scope specifically* beyond whatever Scope 2 adds (BitBox02/Jade tiles) — this scope only changes how/when it's shown (pre-selected + collapsed vs. interactive), not its internals. |
| `src/lib/types.ts` | No change needed for Scope 1 alone (device types already exist) — Scope 2 extends `WalletDeviceType`. |

## 1.3 Testing

- Unit tests for the two new reader functions (mock the Trezor
  Connect/Ledger transport layers the same way the existing
  `trezor.test.ts`/`ledger.test.ts` already mock them for the multisig
  readers — same file, same mocking pattern, just asserting the single-sig
  path/prefix instead).
- Unit test for `parseColdcardSingleSigExport` against a real (or
  realistic, hand-constructed) ColdCard single-sig export fixture.
- Manual/E2E: the existing `scripts/vault-e2e` harness already drives a
  Trezor emulator end-to-end for multisig — extend it (or add a sibling
  script) to cover single-sig import via the emulator too, so this doesn't
  regress silently the way the Ledger Buffer-polyfill bug did (that bug
  shipped past a clean test suite because the tests ran under Node, where
  the browser-only failure mode didn't reproduce — an emulator-driven
  browser test is the only thing that actually catches this class of bug).

---

# SCOPE 2: BitBox02 + Jade hardware wallet support

Research findings below are from live web research (Caravan's source,
npm registries, vendor GitHub orgs), not training-data recall — each claim
below is sourced. Treat anything not explicitly sourced as a gap to verify
before building, not an assumption to build on.

## 2.1 BitBox02

**Library: `bitbox-api` (npm), NOT `bitbox02-api`.** Confirmed via the npm
registry directly: `bitbox-api` is at **0.13.0**, published 2026-04-13,
actively maintained (20 published versions). The older `bitbox02-api`
(GopherJS-compiled from Go) is stale — over a year since its last publish.
Confirmed against Caravan's real source
(`caravan-bitcoin/caravan`, `packages/caravan-wallets/src/bitbox.ts`, fetched
directly): it imports `PairedBitBox`, `BtcCoin`, `BtcMultisigScriptType`,
`BtcScriptConfig` from `'bitbox-api'` and pins `^0.10.0` — this is genuinely
what production multisig-coordinator code ships with, not a guess.

**Important build-config implication**: `bitbox-api` is a Rust core compiled
to WASM with generated TypeScript bindings (source:
`github.com/BitBoxSwiss/bitbox-api-rs`). Per its own `README-npm.md`, Vite
needs `vite-plugin-wasm` + `vite-plugin-top-level-await` added to
`vite.config.ts` (Webpack needs `experiments: { asyncWebAssembly,
topLevelAwait }`, not applicable here). **Cairn's current `vite.config.ts`
has no WASM support at all** — this is new plugin surface, not just a new
npm dependency, and needs its own `optimizeDeps` treatment the same way the
Ledger Buffer-polyfill fix added a dedicated `optimizeDeps.include` block for
that device's dependency graph (see that fix, commit `eb4df2b`, for the
precedent to follow — BitBox02 will need an analogous block, informed by
whatever WASM-loading errors actually surface in practice, the same way the
Ledger fix was informed by a real reproduced 504).

**Connection flow** (from `bitbox-api-rs/src/wasm/connect.rs` and `webhid.js`,
and Caravan's `withDevice()` wrapper in `bitbox.ts` lines 192-228):

1. `bitbox.bitbox02ConnectAuto(onCloseCb)` — checks `navigator.hid`; WebHID if
   present, else falls back to **BitBoxBridge** (a locally-installed native
   app exposing `ws://127.0.0.1:8178`) for Firefox/Safari, which lack WebHID.
   **v1 scope decision, mirroring Ledger's existing Chromium-only posture in
   Cairn**: support the WebHID path only; treat BitBoxBridge as a documented
   gap ("BitBox02 needs Chrome/Edge/Brave," same limitation already accepted
   for Ledger) rather than building bridge support now.
2. WebHID device selection: `navigator.hid.requestDevice(...)`, filtered by
   `productName.includes('BitBox02')` (Caravan's own filter — use the same).
3. `unpaired.unlockAndPair()` → `pairing.getPairingCode()` — **first
   connection only**: a short code shown to the user, confirmed on the
   device. This is a **Noise protocol handshake with trust-on-first-use
   pubkey pinning** (`src/noise.rs`, `LocalStorageNoiseConfig`) — meaningfully
   different from Ledger, which has no persistent trust relationship to
   store. **Cairn needs a storage decision here**: Caravan uses
   `localStorage` directly; Cairn's own design philosophy (no exposed
   internals, friendly wrapping) argues for a small server-side table instead
   — `bitbox_pairings (user_id, wallet_id_or_multisig_id, device_static_pubkey,
   paired_at)`, analogous to the existing `ledger_multisig_registrations`
   table, so the pairing survives a browser-data wipe the way Ledger's policy
   HMAC already does. Decide before building; don't default to localStorage
   just because Caravan did — Caravan is a stateless web app with no backend,
   Cairn already has a database for exactly this kind of thing.
4. `pairing.waitConfirm()` → `PairedBitBox`. Run operations. `close()` in a
   `finally` block (same discipline as every other device driver in Cairn).

**Required operations** (real signatures from `bitbox.ts`):
- `pairedBitBox.rootFingerprint(): Promise<string>`
- `pairedBitBox.btcXpub(coin: BtcCoin, keypath: string, xpubType: 'xpub'|'tpub', display: boolean): Promise<string>`
- `pairedBitBox.btcIsScriptConfigRegistered(coin, scriptConfig, keypathAccount): Promise<boolean>`
- `pairedBitBox.btcRegisterScriptConfig(coin, scriptConfig, keypathAccount, xpubType: 'autoXpubTpub', name?): Promise<void>`
  — **multisig wallets must be explicitly registered on-device before
  addresses/signing work**, checked lazily via `btcIsScriptConfigRegistered`
  first (Caravan's `maybeRegisterMultisig` pattern). This is the same shape
  Cairn already has for Ledger (`ledger_multisig_registrations` table) — a
  `bitbox02_multisig_registrations` table follows the identical pattern, not
  a new concept.
- `pairedBitBox.btcAddress(coin, keypath, scriptConfig, display: boolean): Promise<string>` — on-device address verification
- `pairedBitBox.btcSignPSBT(coin, psbtBase64: string, {scriptConfig, keypath}, format: 'default'): Promise<string>`

**Scope gap to flag explicitly**: `BtcScriptConfig` for multisig only covers
`P2WSH` and `P2WSH-P2SH` — Caravan's own code throws for anything else.
Cairn's multisig feature currently supports a third script type, plain
`p2sh` (`src/lib/server/db.ts`, `multisigs.script_type` comment:
`'p2wsh' | 'p2sh-p2wsh' | 'p2sh'`) — **a BitBox02 cannot be used as a signer
for a plain-P2SH Cairn multisig wallet.** The device picker / signer
selection UI needs to grey out or hide the BitBox02 option specifically when
a multisig's `script_type === 'p2sh'`, with copy explaining why, rather than
letting the user pick it and hit a confusing failure mid-flow.

**Emulator**: real, buildable, confirmed via `BUILD.md` in
`BitBoxSwiss/bitbox02-firmware`: `make dockerdev && make simulator`
(headless) or `make simulator-graphical --preseed` (GUI, loads a fixed test
mnemonic). Runs via `./build-build-noasan/bin/simulator [--port N]` (default
15423). **No Docker image or Windows build path was found** — Linux/macOS
only per the documented build. The `bitbox-api` WASM bindings include
direct simulator-connect support (`src/simulator.rs`) separate from the
WebHID path, meaning test code can talk to the simulator over TCP without
going through a browser at all — this is the right foundation for a
CI-friendly test harness, analogous to how `scripts/vault-e2e` already
drives a Trezor emulator.

## 2.2 Jade

**No official JS/TypeScript SDK exists.** Confirmed: Blockstream's only
official client library is Python (`Blockstream/Jade` repo README). Caravan
(`packages/caravan-wallets/src/jade.ts`) depends on **`jadets`** (npm,
latest 1.1.18) — a third-party, single-maintainer TypeScript reimplementation
of Jade's protocol (`github.com/Austin-Fulbright/jadets`), created May 2025,
0 GitHub stars at time of research. **This is a real risk to flag, not paper
over**: it's what a real production coordinator ships with today, but it's
thin, young, and single-maintainer. Options, in order of recommendation:
(1) depend on `jadets` and treat it the way Cairn already treats other
lightly-maintained hardware SDKs (pin the version, don't auto-update); (2) if
`jadets` proves unreliable in practice, the protocol is CBOR-RPC over Web
Serial per Blockstream's own documented API (`Blockstream/Jade`,
`docs/index.rst`) and a thin client could be hand-rolled — larger effort,
only worth it if (1) fails in practice.

**Connection flow — USB** (from `jadets`' `SerialTransport.ts` and Caravan's
`JadeInteraction.withDevice`):
1. `navigator.serial.requestPort()` — **no VID/PID filter is applied** by
   `jadets` (confirmed: no Jade USB VID/PID was found in any source during
   this research) — the user picks from Chrome's generic serial-port list,
   which is a materially worse first-connect experience than Ledger/Trezor's
   filtered device picker. Cairn should look harder for a real VID/PID before
   shipping (check Jade's own firmware source or ask on their support
   channels) rather than accepting the unfiltered picker as final.
2. `jade.connect()` opens the port (115200 baud, CBOR framing via `cbor2`).
3. `jade.authUser(network, httpRequestFn)` — PIN-unlock handshake. **Inverted
   from what you'd expect**: the Jade device itself decides the PIN-server
   request/response, and the host app's only job is to relay `fetch()` calls
   on the device's behalf (`JadeHttpRequestFunction` in `jade.ts`).
   Blockstream's hosted "blind oracle" PIN server never sees the actual PIN
   (only a hash+nonce), and is self-hostable
   (`github.com/Blockstream/blind_pin_server`) — worth mentioning in Cairn's
   own privacy-conscious documentation once this ships, since a self-hoster
   may want to point at their own PIN server rather than Blockstream's.
4. Run operations. `jade.disconnect()` in `finally`.

**Connection flow — QR (air-gapped)**: companion app shows an unsigned PSBT
as a QR (Blockstream Help Center confirms this is BC-UR encoded — see
below), Jade's camera scans it and shows transaction details on-device for
confirmation, then Jade displays the **signed** PSBT back as an animated
BC-UR QR series for the companion app's camera to scan.

**Required operations** (from `jadets`' `jade.ts`):
- `jade.getVersionInfo()`
- `jade.getXpub(network: string, path: number[])` → base58 xpub
- `jade.getMasterFingerPrint(network: string)`
- `jade.registerMultisig(network, name: string, descriptor: MultisigDescriptor)` /
  `jade.getMultiSigName(network, descriptor)` — **same on-device registration
  requirement as BitBox02**: build a `MultisigDescriptor` (variant e.g.
  `"wsh(multi(k))"`, sorted flag, threshold, per-signer fingerprint/path/xpub)
  and register before addresses/signing work. Cairn's descriptor library
  (`src/lib/server/bitcoin/multisig.ts`, `multisigToDescriptor`) already
  produces the equivalent descriptor shape for Caravan export — this is very
  likely a light adapter over existing code, not new descriptor-building
  logic.
- `jade.getReceiveAddress(network, {paths, multisigName})` — on-device address verification
- `jade.signPSBT(network: string, psbt: Uint8Array)` → signed PSBT bytes
- `jade.signMessage(path: number[], message: string)`

**QR format — the important finding**: Jade's QR mode uses **BC-UR**
("Uniform Resources," the Blockchain Commons format also used by Passport
and Keystone), confirmed directly from Blockstream's own Help Center
documentation. **This is a different format from BBQr**, which is what
Cairn already implements for SeedSigner (`src/lib/hw/bbqr.ts`). Jade's QR
mode does **not** drop into Cairn's existing air-gapped QR plumbing — it
needs a separate BC-UR encoder/decoder. The common JS implementations are
`bc-ur` or `@keystonehq/bc-ur-registry` (well-known in the air-gapped-wallet
ecosystem; not independently deep-dived in this research pass — vet both
before picking one). **This is materially more work than the USB path and
should be scoped/prioritized as such**: recommend shipping Jade USB
(Web Serial) first, and treating Jade QR as a distinct, separately-estimated
follow-on rather than bundling it into the same initial release — it's not
"the QR signer we already have, plus one more device," it's a whole second
QR codec.

**Emulator**: real, Docker-buildable, confirmed via the `Blockstream/Jade`
repo (README/CHANGELOG/Dockerfile) — QEMU-based:
`DOCKER_BUILDKIT=1 docker build . -t testjadeqemu`, run via
`main/qemu/run_emulator.sh [--larger-display]`. Exposes serial-over-TCP on
port 30121 and a web display on 30122. `jadets` ships a `TCPTransport.ts`
specifically for talking to this emulator — strong signal this is the
intended dev/CI testing path, and (like BitBox02's simulator) doesn't
require exercising real `navigator.serial` to get protocol-level test
coverage. **Documented as Linux-only.**

## 2.3 Component plan for both

Follow the existing per-device signer component pattern exactly — one
component per (device × flow), matching how `TrezorSigner.svelte` /
`LedgerSigner.svelte` already exist separately for the single-sig send flow
(`wallets/[id]/send/_components/`) and `MultisigTrezorSigner.svelte` /
`MultisigLedgerSigner.svelte` exist separately for the multisig send flow
(`wallets/multisig/[id]/send/_components/`) — don't try to build one
device-agnostic mega-component; the existing codebase has deliberately not
done that even between Trezor and Ledger, which are more similar to each
other than either is to BitBox02 or Jade.

New files, mirroring existing names 1:1:

| Device | Single-sig send | Multisig send | Driver module |
|---|---|---|---|
| BitBox02 | `wallets/[id]/send/_components/BitboxSigner.svelte` | `wallets/multisig/[id]/send/_components/MultisigBitboxSigner.svelte` | `src/lib/hw/bitbox02.ts` |
| Jade (USB) | `wallets/[id]/send/_components/JadeUsbSigner.svelte` | `wallets/multisig/[id]/send/_components/MultisigJadeUsbSigner.svelte` | `src/lib/hw/jade.ts` |
| Jade (QR) | `wallets/[id]/send/_components/JadeQrSigner.svelte` | `wallets/multisig/[id]/send/_components/MultisigJadeQrSigner.svelte` | `src/lib/hw/jadeUr.ts` (the BC-UR codec, separate from `hw/bbqr.ts`) |

Each driver module (`bitbox02.ts`, `jade.ts`) follows the existing
`ledger.ts`/`trezor.ts` shape: typed error classes with a `code` field (see
`LedgerError`/`TrezorError`), lazy dynamic imports of the heavy vendor SDK
inside the functions that need it (never at module top level — same
SSR/bundle-size discipline the Ledger fix established), and pure/testable
logic (PSBT → device request shape, signature merge-back) separated from the
actual device I/O so it can be unit-tested without hardware, exactly like
`ledger.test.ts`'s "without a Node Buffer global" regression suite already
demonstrates is possible and necessary for this codebase specifically.

Key-read integration: both devices plug into the existing
`deviceRead.ts` seam (Scope 1 §1.2, and its multisig-wizard equivalent)
as `readKeyFromBitbox02`/`readMultisigKeyFromBitbox02` and
`readKeyFromJade`/`readMultisigKeyFromJade` — same dynamic-import-with-
`DeviceReadUnavailable`-fallback pattern already established for Trezor and
Ledger, no new architectural seam needed there.

---

# SCOPE 1 + 2 SHARED TOUCHPOINTS

A short list of files both scopes edit, called out so whoever lands second
merges cleanly rather than reverting the other's change:

- `src/lib/types.ts` — `WalletDeviceType` grows from
  `'trezor' | 'ledger' | 'coldcard' | 'qr' | 'file'` to include `'bitbox02'`
  and `'jade'`. Also update the corresponding label maps wherever
  `WalletDeviceType` is exhaustively switched over for display (grep for
  `WALLET_DEVICE_LABELS` or similar — `src/routes/(app)/wallets/[id]/send/+page.svelte`
  and `DevicePicker.svelte` both almost certainly have one).
- `src/lib/components/DevicePicker.svelte` — `OPTIONS` array grows by two
  tiles (BitBox02, Jade), same shape as the existing five.
- `src/lib/server/db.ts` — the `multisig_keys.device_type` column's
  documented value set (currently a comment: `'trezor'|'ledger'|'coldcard'|'qr'|'file'`)
  grows to include the two new values — comment-only change, the column is
  already a free-text `TEXT`, no migration needed for the column itself.
- The multisig wizard (`wallets/multisig/new/+page.svelte`) also needs
  BitBox02/Jade tiles added to ITS method picker (`type Method = 'trezor' |
  'ledger' | 'coldcard' | 'qr' | 'paste'` grows too) — this is arguably
  Scope 2's responsibility since it's "add the new devices everywhere a
  device list exists," not Scope 1's single-sig-specific work, but flagging
  here so it isn't dropped between the two scopes' subagents.

---

# SUBAGENT BREAKDOWN

| # | Unit | Scope | Files | Effort signal | Depends on |
|---|------|-------|-------|---------------|-----------|
| A | Single-sig Trezor/Ledger device readers | 1 | `hw/trezor.ts`, `hw/ledger.ts` additions + tests | Small — same devices, new path/prefix math over existing plumbing | Nothing |
| B | Single-sig ColdCard + QR import | 1 | New `wallets/new/_components/{deviceRead,coldcardImport}.ts` | Small | Unit A (`deviceRead.ts` wraps A's functions) |
| C | Single-sig wizard UI rebuild | 1 | `wallets/new/+page.svelte` Step 2 + Step 4 | Medium — mostly copy-adapt from the multisig wizard's existing markup/CSS | Units A+B (calls their exports); can start on static UI/copy immediately, wire the calls once A/B land |
| D | BitBox02 driver | 2 | `hw/bitbox02.ts` (new) + Vite WASM plugin config, following §2.1 | **Large** — new WASM build tooling, a persistent-pairing storage decision, and a new DB table (`bitbox02_multisig_registrations`) are all genuinely new surface, not just "port the pattern" | Nothing — independent of Jade and of Scope 1 |
| E1 | Jade USB driver | 2 | `hw/jade.ts`, depends on the unofficial `jadets` package, per §2.2 | Medium — real protocol, but a maintained (if thin) library does the heavy lifting | Nothing |
| E2 | Jade QR (BC-UR) driver | 2 | `hw/jadeUr.ts` (new BC-UR codec, separate from the existing `hw/bbqr.ts`) | **Large** — confirmed this is NOT an extension of Cairn's existing air-gapped QR support, it's a second, unrelated QR encoding to integrate from scratch. Recommend scheduling as a distinct follow-on release after E1 ships, not bundled into the same milestone. | Nothing, but lower priority than E1 — sequence it after if resourcing is tight |
| F | BitBox02 + Jade signer components (multisig AND single-sig send flows) | 2 | Per the §2.3 table (6 new component files + 2 driver-adjacent files) | Medium, scales with how many of D/E1/E2 have landed | Units D, E1 (and E2 if that's in scope for this pass) |
| G | Shared touchpoints (types, DevicePicker, wizard method lists) | 1+2 | Per the "Shared Touchpoints" section above | Small | Should land AFTER D/E1's driver shape is known (device capabilities affect what the picker tile copy promises — e.g. the p2sh-multisig BitBox02 exclusion from §2.1) but BEFORE C/F need it — a natural second-wave unit, not truly parallel with everything else |

Build order: **A, D, E1, E2 can start immediately and in parallel** (zero
dependencies on each other). **B** needs A's exports to exist (can stub
against the documented signature and swap the stub once A lands, same
pattern as the notification plan's unit dependencies). **G** should land
once D/E1's actual capabilities are known. **C and F** are the integration
units, naturally last. **If this needs to ship in stages rather than all at
once, the natural cut line is E2 (Jade QR)** — it's the single largest,
least-certain piece of the whole plan (unofficial upstream library for E1
already, plus an entirely separate codec for E2), and BitBox02 + Jade-USB
alone already covers 3 of the 4 originally-requested new devices'
highest-value connection modes.
