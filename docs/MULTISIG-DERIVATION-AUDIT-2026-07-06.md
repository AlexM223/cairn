# Collaborative Custody Derivation Path Audit — 2026-07-06

Scope: verify Cairn's multisig (collaborative custody) derivation paths are correct
(BIP-48, not the deprecated BIP-45), properly separated from single-sig paths, and
compare against Bastion's (`C:\dev\bastion`) key-upload UX pattern to scope a possible
port.

**Bottom line: no bug found in Cairn.** BIP-48 is implemented correctly and is
cleanly separated from single-sig derivation everywhere it matters. The interesting
finding is on the Bastion side: the pattern Alex remembered ("ask upfront, pull both
single-sig and BIP-48 paths") isn't quite what Bastion does — its "pull both" path is
actually **BIP-45**, the same deprecated standard this audit set out to avoid. Beads
filed for the UX feature this inspired: [cairn-fdlf](#) (epic), cairn-fdlf.1,
cairn-fdlf.2, cairn-3mhi.

## 1. Cairn: derivation paths are correct and well separated

**Verdict: BIP-48 used correctly, BIP-45 never used, no conflation between
single-sig and multisig paths.**

The single source of truth for both path families is `src/lib/hw/common.ts`:

```ts
// Multisig account path — BIP-48
export function multisigAccountPathIndexes(scriptType, account, fail) {
  // ...
  const sub = scriptType === 'p2wsh' ? 2 : 1;
  return [48 + HARDENED, 0 + HARDENED, account + HARDENED, sub + HARDENED];
}

// Single-sig account path — BIP-44/49/84/86
export function singleSigAccountPathIndexes(scriptType, account, fail) {
  const purpose = SCRIPT_TYPE_PURPOSE[scriptType]; // 44/49/84/86
  return [purpose + HARDENED, 0 + HARDENED, account + HARDENED];
}
```

These are two separate functions with separate types (`MultisigScriptType` vs
`ScriptType`), separate return shapes (4 vs 3 path elements), and no shared business
logic beyond generic path-math helpers. `sub = 2'` for native P2WSH and `1'` for both
P2SH-P2WSH and legacy P2SH matches the BIP-48 spec (which only distinguishes wrapped
vs native segwit). Taproot multisig (`3'`) is deliberately unsupported — descriptor
parsing rejects `tr(...)` explicitly (immature MuSig2/FROST tooling), a documented
product decision, not an oversight.

**BIP-45 (`m/45'`) is never generated or offered anywhere.** The only occurrences of
`m/45'` in the repo are in test fixtures that prove the opposite — that Cairn
correctly *rejects* a BIP-45-shaped path as "not a re-derivable BIP-48 layout" (key
health check) or *preserves it verbatim* rather than coercing it (ColdCard/descriptor
export of an externally-imported wallet that happens to use a nonstandard path).

**Hardware key reads for multisig never reuse single-sig material.** Every driver
(`src/lib/hw/trezor.ts`, `ledger.ts`, `bitbox02.ts`, `jade.ts`) exposes two
independent functions — `readMultisigKeyFrom*` and `readSingleSigKeyFrom*` — each
computing its own path and making its own fresh live device round-trip. If a user
adds the same physical Trezor to both a single-sig wallet and, later, a multisig
wallet, Cairn issues a brand-new BIP-48 device query each time; it never surfaces or
derives from the existing single-sig xpub. Parallel client seams
(`wallets/new/_components/deviceRead.ts` vs
`wallets/multisig/new/_components/deviceRead.ts`) keep this separation explicit at
the UI layer too.

**Xpub import** (paste / QR / ColdCard file / full Caravan-format import) takes the
derivation path from whatever the source provides — user-typed fields, the file's
`bip48_1`/`bip48_2` section, or the descriptor's origin bracket — and never invents
or assumes a path. `parseCaravanImport()` (`src/lib/server/multisigExport.ts:293`)
reads `bip32Path` verbatim from imported files, so a nonstandard imported wallet is
preserved as-is rather than silently coerced to BIP-48.

One soft, non-security finding: the wizard's main "Add keys" step doesn't display the
derivation path prominently for a live-connected hardware key (it's visible via
descriptor export, ColdCard registration file, and the key-health recheck UI, just
not the primary add-key slot). Tracked as a low-priority nicety: cairn-3mhi.

### Files referenced
- `src/lib/hw/common.ts` — shared path/version constants, `multisigAccountPathIndexes` / `singleSigAccountPathIndexes`
- `src/lib/hw/{trezor,ledger,bitbox02,jade}.ts` — per-vendor `readMultisigKeyFrom*` vs `readSingleSigKeyFrom*`
- `src/lib/server/bitcoin/xpub.ts` vs `src/lib/server/bitcoin/multisig.ts` — separate SLIP-132 version tables for single-sig vs multisig
- `src/lib/server/multisigExport.ts` — Caravan/Unchained JSON import, ColdCard export
- `src/routes/(app)/wallets/multisig/new/+page.svelte` + `+page.server.ts` — creation wizard
- `src/routes/(app)/wallets/multisig/_components/keyHealth.ts` + `.test.ts` — path re-verification, explicit BIP-45 negative-case tests
- `src/routes/(app)/wallets/{new,multisig/new}/_components/deviceRead.ts` — parallel single-sig/multisig client seams

## 2. Bastion: the upfront-ask pattern exists, but pulls BIP-45, not BIP-48

Bastion's single-sig "add a hardware key" panel (`public/js/views/wallets.js:742-795`)
has an opt-in checkbox:

> "I plan to **share this key** with others in a collaborative (multi-user) wallet
> later — also prepare the Unchained-compatible sharing key now. *(The extra m/45'
> device read is supported on Ledger & Trezor today; it's skipped for
> BitBox02/Jade.)*"

When checked, `wireDeviceConnect()` (`wallets.js:1211-1266`) makes a **second live
hardware call in the same click handler**, right after the primary single-sig read:

```js
const sharing = await readKey({ path: "45'" });   // bare BIP-45, no account/change subtree
rememberMasterKey(sharing, '45', 0, deviceName);
```

This is genuinely the "ask once, touch device once, get two keys" mechanic Alex
remembered — but **the second path is BIP-45, not BIP-48.** Bastion's own comments
explain why: BIP-45 has no script-type subfield, so it can be derived before the
user has chosen P2WSH vs P2SH-P2WSH for the eventual multisig vault. BIP-48 *is*
implemented in Bastion, but only in the separate multisig-vault-creation wizard, and
only for "personal" vaults (`ms.collaborative === false`) — collaborative vaults
default every cosigner key to the BIP-45 path instead
(`msDefaultPath()`, `wallets.js:1657`). BIP-45 and BIP-48 are mutually exclusive
per-vault choices in Bastion, never both fetched together for one key.

Data model: Bastion stores this in a flat `master_keys` registry
(`src/server/db/schema.ts:396-410`), one row per `(user_id, xfp, purpose)` where
`purpose` is a bare string enum including `'45'` and `'48'` as peers of
`'44'|'49'|'84'|'86'`. A shared checkbox produces two independent rows linked only by
matching fingerprint — not one record with two xpub fields.

**Implication for Cairn:** the *mechanism* (opt-in checkbox → second live read in the
same touch session → remember for later) is worth porting. The *path choice* is not
— copying Bastion's BIP-45 usage would reintroduce exactly the deprecated standard
this audit was checking Cairn doesn't have. A Cairn port should prefetch a real BIP-48
path instead, accepting the tradeoff Bastion's design avoided: BIP-48 needs a
script-type subfield, so the prefetch can only fully cover one script type (proposed
default: native segwit, `2'`) without asking the user to pick upfront or doing a
second BIP-48 touch later for the other script type.

### Files referenced
- `public/js/views/wallets.js` — `singlesigPanel()` (:742-795), `wireDeviceConnect()` (:1211-1266), `msDefaultPath()` (:1657)
- `public/js/{ledger,trezor,bitbox,jade}.js` — per-vendor single-sig vs BIP-48-multisig key functions
- `src/server/db/schema.ts:396-410` — `master_keys` table
- `src/server/routes/wallets.ts:489-568` — `POST /master-keys` dual-row upsert

## 3. Beads filed

- **cairn-fdlf** (epic, P3) — Collaborative-custody key-add UX: prefetch BIP-48 multisig key alongside single-sig
  - **cairn-fdlf.2** (P3) — Add known-device-keys registry table (build first; Cairn has no equivalent of Bastion's `master_keys` cache today)
  - **cairn-fdlf.1** (P3, blocked by fdlf.2) — Add opt-in checkbox to single-sig key-add; prefetch BIP-48 (not BIP-45) in the same hardware session
- **cairn-3mhi** (P4) — Surface derivation path more visibly in the multisig "Add keys" wizard step

None of these are security fixes — Cairn's existing multisig derivation logic is
correct as-is. They're scoped as a UX feature and a minor visibility nicety.
