# Vault E2E emulator stack (bead cairn-a4k — infrastructure prep)

Everything the vault end-to-end test needs: bitcoind regtest, a Trezor
emulator + bridge, Ledger Speculos with a real Bitcoin app, a ColdCard-style
file signer, and Bitcoin Core wallets as scripted cosigners. **All components
were booted and verified on this host** (Windows 11 + Docker Desktop 29.6.1,
Node 24, 2026-07-04) — command evidence in `VERIFICATION.md`.

A previous session already proved full *signing* round trips against these
exact emulator images (including the app's own translation code) — see
`C:\dev\cairn\.hw-emu-test\README.md`. This stack is a clean, self-contained,
port-shifted re-creation for the vault E2E, with the multisig plumbing
rehearsed end to end.

## Status summary

| Component | Status | Notes |
|---|---|---|
| bitcoind regtest (`bitcoin/bitcoin:28.0`, official Bitcoin Core image) | **verified working** | wallet created, 101 blocks mined, balance 50 BTC via RPC |
| Core-wallet scripted cosigners (`core-signer.mjs`) | **verified working** | xpub/xfp/path extraction + `descriptorprocesspsbt` signing |
| Trezor emulator (`ghcr.io/trezor/trezor-user-env`) | **verified working** | T2T1 fw 2.7.2, test seed loaded, bridge reachable on host, BIP48 xpub fetched via real `@trezor/connect` and matches local derivation |
| Ledger Speculos (`ghcr.io/ledgerhq/speculos`) | **verified working** | app-bitcoin-new 2.4.6 (mainnet, nanosp), master fp + BIP48 xpub via APDU match local derivation, button automation API works |
| ColdCard file signer (`cc-sign.mjs`) | **verified working** | self-test + real signature in the quorum rehearsal below |
| 2-of-3 quorum rehearsal (`verify-quorum.mjs`) | **verified working** | fund vault → PSBT → cc file round trip → 1 sig does NOT finalize → 2nd sig completes → broadcast to taproot dest → confirmed. txid `10a70fcdef8373d51d095ee26c63c8de9346c433c4ef8f06148f8afa2edef277` |

No component was infeasible; no fallback is *required*. If Trezor or Speculos
ever flakes mid-run, `core-signer.mjs` is the drop-in cosigner fallback
(same `{ xpub, xfp, path }` contract, zero UI).

## Boot / teardown

```sh
cd C:/dev/cairn/scripts/vault-e2e
npm install                                   # once; local deps only (repo package.json untouched)
MSYS_NO_PATHCONV=1 docker compose -p vault-e2e up -d
node setup-trezor.mjs                         # REQUIRED after every `up`: starts emulator, seeds it, starts bridge, injects proxy
# ... verify:
node speculos-check.mjs
node trezor-xpub.mjs
node core-signer.mjs create signer-a
node verify-quorum.mjs                        # needs the `miner` wallet, see below

# teardown (containers are named vault-e2e-*)
docker compose -p vault-e2e down
```

bitcoind state is ephemeral (no volume): after each `up`, recreate the miner
wallet and mine coinbase maturity:

```sh
curl -s -u vaulte2e:vaulte2e -d '{"jsonrpc":"1.0","id":"t","method":"createwallet","params":["miner"]}' http://127.0.0.1:18543/
ADDR=$(curl -s -u vaulte2e:vaulte2e -d '{"jsonrpc":"1.0","id":"t","method":"getnewaddress","params":[]}' http://127.0.0.1:18543/wallet/miner | python -c "import sys,json;print(json.load(sys.stdin)['result'])")
curl -s -u vaulte2e:vaulte2e -d "{\"jsonrpc\":\"1.0\",\"id\":\"t\",\"method\":\"generatetoaddress\",\"params\":[101,\"$ADDR\"]}" http://127.0.0.1:18543/
```

The Trezor emulator's seed is also ephemeral — `setup-trezor.mjs` re-seeds it
each time. Speculos re-seeds itself from the compose command line.

## Ports (ALL SHIFTED from defaults — see "leftover containers" below)

| Service | Host | Container | Auth / protocol |
|---|---|---|---|
| bitcoind RPC | `127.0.0.1:18543` | 18443 | `vaulte2e` / `vaulte2e`, JSON-RPC. Wallet paths: `/wallet/<name>` |
| Trezor controller | `ws://127.0.0.1:29001` | 9001 | trezor-user-env JSON websocket (`emulator-press-yes`, etc.) |
| Trezor dashboard | `http://127.0.0.1:29002` | 9002 | browser UI, handy for debugging |
| Trezor bridge | `http://127.0.0.1:31325` | 21327→21325 | trezord-go 2.0.33 behind in-container proxy; requires `Origin: https://connect.trezor.io`-style header for manual curl |
| Speculos API + automation | `http://127.0.0.1:25000` | 5000 | REST: `/events`, `/button/{left,right,both}`, `/automation`, `/screenshot`, `/apdu` |
| Speculos raw APDU | `tcp://127.0.0.1:40001` | 40000 | only needed by `@ledgerhq/hw-transport-node-speculos` (TCP variant); the HTTP transport uses 25000 |

**Leftover containers from the previous session** (`hwtest-bitcoind`,
`hwtest-electrs`, `cairn-trezor-emu`, `cairn-speculos`) were still running
when this stack was built and own the DEFAULT ports (18443, 21325, 5000...).
This stack deliberately avoids them and runs fine alongside. If the E2E agent
wants the default ports (e.g. for browser-based `@trezor/connect-web`, which
only probes 21325), tear those down first:
`docker rm -f cairn-trezor-emu cairn-speculos hwtest-bitcoind hwtest-electrs`
(their session is complete; see `.hw-emu-test/README.md` "Cleanup").

## The three signers (test seeds — NEVER use for real funds)

All BIP48 p2wsh account path `m/48'/0'/0'/2'` (mainnet-style coin type; the
regtest chain doesn't care, and the app builds mainnet-encoded descriptors).

| Signer | Seed | Master fingerprint | xpub @ m/48'/0'/0'/2' |
|---|---|---|---|
| **Trezor** (emulator) | `all all all all all all all all all all all all` | `5c9e228d` | `xpub6EgGHjcvovyN3nK921zAGPfuB41cJXkYRdt3tLGmiMyvbgHpss4X1eRZwShbEBb1znz2e2bCkCED87QZpin3sSYKbmCzQ9Sc7LaV98ngdeX` |
| **Ledger** (Speculos) | `glory promote mansion idle axis finger extra february uncover one trip resource lawn turtle enact monster seven myth punch hobo dawn victory error impact` | `6f309170` | `xpub6ETWasCa39YssF19BXoBWo3rpyBBqLBn2wJ7o4HCdqje7KTt9FU57PXyDKd2KFP1npQLhN6aXJ9R5DqJEBKcKd5xHn8xjAVTsGJbmG4cMQ5` |
| **ColdCard** (`cc-sign.mjs`) | `abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about` | `73c5da0a` | `xpub6DkFAXWQ2dHxq2vatrt9qyA3bXYU4ToWQwCHbf5XB2mSTexcHZCeKS1VZYcPoBd5X8yVcbXFHJR9R8UCVpt82VX1VhR28mCyxUFL4r6KFrf` |

Core cosigner wallets (`core-signer.mjs create <name>`) generate a **random**
seed per wallet creation — their xfp/xpub change whenever bitcoind is
recreated; always re-run `create` and read the JSON it prints.

## How the E2E agent drives each signer

### Bitcoin Core cosigner (also the universal fallback)
```sh
node core-signer.mjs create signer-a          # -> { xfp, path, xpub, tpub, keyOriginTpub, keyOriginTprv, ... }
node core-signer.mjs sign <psbtB64|@file> '<private descriptor with our tprv>'   # descriptorprocesspsbt
```
Notes proven by `verify-quorum.mjs`:
- Core 28 rejects multipath `<0;1>` keys inside `sortedmulti` — expand into
  `/0/*` + `/1/*` descriptor twins (helper included in the script).
- On a regtest node, descriptors must use **tpub/tprv encodings** (the
  `keyOriginTpub`/`keyOriginTprv` outputs); the mainnet `xpub` output is what
  the app itself consumes. Same key material, different serialization.
- `getdescriptorinfo`: use `.checksum` (checksum of the descriptor as given),
  not the checksum on `.descriptor` (normalized/public form) for private
  descriptors.
- `walletprocesspsbt` only signs scripts the wallet knows; for multisig either
  `importdescriptors` the full vault descriptor into the signer wallet first,
  or (simpler, what we verified) use node-level `descriptorprocesspsbt`.

### ColdCard (file round trip)
```sh
node cc-sign.mjs --selftest                   # prints xfp/xpub
node cc-sign.mjs unsigned.psbt [out.psbt]     # reads binary OR base64 .psbt file,
                                              # signs inputs listing xfp 73c5da0a, writes *-signed.psbt (binary, NOT finalized)
```
Mimics a real ColdCard: partial signatures only, coordinator finalizes.
Verified inside the quorum rehearsal against a real Core-built PSBT.

### Trezor
- **Node path (recommended, proven):** `@trezor/connect` (the Node entrypoint,
  already a dependency of the repo's `@trezor/connect-web` and declared here) —
  Bridge transport, no popup. Because our bridge is on **31325**, pass a
  subclassed transport; `TrezorConnect.init({ transports: [class extends BridgeTransport { constructor(p){ super({...p, port: 31325}); } }] })`.
  Working example incl. the xpub fetch + UI auto-answer handlers:
  `trezor-xpub.mjs`. For signing, `TrezorConnect.signTransaction`; full
  reference incl. PSBT translation: `.hw-emu-test/trezor-node-sign.mjs`.
  Multisig inputs additionally need the `multisig` field (all cosigner xpubs +
  address_n suffix) and `script_type: 'SPENDMULTISIG'`/witness equivalent.
- On-device confirmations: send `{"type":"emulator-press-yes"}` to
  `ws://127.0.0.1:29001` for every `ui-button` event (see the `UI_EVENT`
  handler in `trezor-xpub.mjs`).
- **Regtest caveat (bit us before):** Connect independently verifies segwit
  input amounts and will try to fetch prev-txs from its own backend — on a
  private regtest chain supply `refTxs` yourself (built from
  `getrawtransaction`; ready-made code in `.hw-emu-test/trezor-node-sign.mjs`).
- **Browser path (`@trezor/connect-web`, what the app itself uses):** Connect's
  popup probes the FIXED port 21325; it cannot be pointed at 31325. For a
  browser-level test, free port 21325 (tear down `cairn-trezor-emu`, edit the
  compose mapping `31325:21327` → `21325:21327`, re-run `setup-trezor.mjs`).
  Note the previous session found this harness's headless browser blocks
  Connect's popup (`window.open`) — the Node path is the realistic one here.

### Ledger
- Transport: `@ledgerhq/hw-transport-node-speculos-http` (declared in THIS
  directory's `package.json`; install with `npm install` here — **do not** add
  it to the repo package.json). `SpeculosHttpTransport.open({ apiPort: 25000 })`.
- Client: `AppClient` from `@ledgerhq/hw-app-btc/lib/newops/appClient` (repo
  dep). **Load all `@ledgerhq/*` packages via `createRequire` — their ESM
  builds don't resolve under raw Node** (see header of `speculos-check.mjs`).
- Working xpub/fingerprint fetch: `speculos-check.mjs`. Signing reference:
  `.hw-emu-test/ledger-node-sign.mjs` (single-sig `WalletPolicy`).
- **Multisig specifics:** app-bitcoin-new requires REGISTERING a multisig
  wallet policy first — `client.registerWallet(policy)` with template like
  `wsh(sortedmulti(2,@0/**,@1/**,@2/**))`, which prompts on-device approval;
  drive it with the automation API (`POST /button/right` to scroll,
  `/button/both` to approve; read screens via `GET /events?currentscreenonly=true`).
  Keep the returned HMAC and pass it to `signPsbt`. The signing prompts also
  need button presses (or preload rules via `POST /automation`).
- The bundled app is **mainnet** app-bitcoin-new 2.4.6 for nanosp
  (`assets/ledger-app-nanosp/app.elf`, sha256 `bd1a1812...`, from LedgerHQ's
  own CI artifacts — GitHub *releases* ship no binaries; CI artifact name
  `bitcoin-app-nanosp` on LedgerHQ/app-bitcoin-new). More models (nanox, flex,
  stax) are already downloaded in `.hw-emu-test/ledger-app/extracted/`.

## Mainnet-encoding-on-regtest trick (from the previous session, use it)

The app is mainnet-facing (`bc1...`/`bc1p...` addresses, xpubs). Regtest and
mainnet addresses share scriptPubkeys — only the HRP differs. So: derive the
vault's mainnet address in the app, re-encode it as `bcrt1...` to fund it via
regtest RPC, and let everything script-level operate on scriptPubkeys. For a
`bc1p` destination test, the regtest-broadcast form is the same output script
as the `bc1p` address (verify-quorum.mjs already sends to a taproot/bech32m
destination). If the app needs a chain backend, `mempool/electrs` works
against Core 28 (NOT getumbrel/electrs — parse error); recipe in
`.hw-emu-test/README.md`.

## Recommended E2E plan

1. Boot stack + `setup-trezor.mjs` + miner wallet + 101 blocks.
2. Collect the three signer descriptors: Trezor + Ledger xpubs via
   `trezor-xpub.mjs` / `speculos-check.mjs` (or app UI), ColdCard via
   `cc-sign.mjs --selftest`.
3. Create the 2-of-3 vault in the app with those three keys; fund its
   (regtest-re-encoded) address via bitcoind RPC; mine a block.
4. Build the spend to a `bc1p` destination in the app; sign with Trezor
   (Node connect, port-31325 transport) and Ledger (register policy, sign,
   drive buttons); use the ColdCard `.psbt` file round trip as the third-key
   check and the quorum test (assert 1 sig ≠ final, 2 sigs = final — pattern
   in `verify-quorum.mjs`).
5. Broadcast via the app; confirm with `generatetoaddress`.
6. Fallback if an emulator misbehaves: swap that key for a
   `core-signer.mjs` cosigner — identical `{ xpub, xfp, path }` contract and a
   verified signing path, so the vault/quorum logic still gets exercised.

## Files

- `docker-compose.yml` — the three containers, shifted ports
- `setup-trezor.mjs` — post-boot Trezor provisioning (MUST run after every up)
- `proxy.py` — in-container TCP proxy (bridge binds loopback-only; Docker can't forward that)
- `core-signer.mjs` — Core wallet cosigner: create/extract + descriptorprocesspsbt sign
- `cc-sign.mjs` — ColdCard-style file signer (seed above)
- `trezor-xpub.mjs` / `speculos-check.mjs` — per-device verification + reference code
- `verify-quorum.mjs` — full 2-of-3 multisig rehearsal (run it anytime as a health check)
- `assets/ledger-app-nanosp/app.elf` — app-bitcoin-new 2.4.6 mainnet, nanosp
- `package.json` — this directory's own deps (repo package.json untouched)
- `VERIFICATION.md` — captured outputs of every verification above

## Windows gotchas (all hit and worked around here)

- Git Bash mangles `/tmp`-style args to `docker exec` → wrap container paths
  in `sh -c "..."` or set `MSYS_NO_PATHCONV=1`.
- `docker exec -d ... sh -c "nohup x &"` dies with the shell → use
  `sh -c "exec python3 ..."` under `-d` (done in `setup-trezor.mjs`).
- trezord-go binds 127.0.0.1 inside the container; publishing 21325 directly
  yields connection-reset → the proxy.py hop is mandatory.
- `network_mode: host` does not work on Docker Desktop for Windows — explicit
  port mappings only.
