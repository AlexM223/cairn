# Verification evidence — vault-e2e stack (2026-07-04)

Host: Windows 11 Pro, Docker Desktop server 29.6.1, Node v24.14.1, Python 3.13.7.
All commands run from `C:\dev\cairn\scripts\vault-e2e` unless noted.

## 1. Stack boot

```
$ MSYS_NO_PATHCONV=1 docker compose -p vault-e2e up -d
$ docker ps --filter name=vault-e2e --format '{{.Names}} {{.Status}} {{.Ports}}'
vault-e2e-trezor    Up  0.0.0.0:29001->9001/tcp, 0.0.0.0:29002->9002/tcp, 0.0.0.0:31325->21327/tcp
vault-e2e-speculos  Up  0.0.0.0:25000->5000/tcp, 0.0.0.0:40001->40000/tcp
vault-e2e-bitcoind  Up  0.0.0.0:18543->18443/tcp
```

## 2. bitcoind regtest (official bitcoin/bitcoin:28.0)

```
$ curl -s -u vaulte2e:vaulte2e -d '{"method":"getblockchaininfo",...}' http://127.0.0.1:18543/
{"result":{"chain":"regtest","blocks":0,...}}
$ ... createwallet miner        -> {"result":{"name":"miner"},"error":null}
$ ... generatetoaddress 101     -> ["1c348299a70a3ca96073bd842bd3c2119e74689086d91eb9e319c5d95fc310fd", ...]
$ ... getbalance (miner)        -> {"result":50.00000000,"error":null}
```

Image choice: `bitcoin/bitcoin` is the Bitcoin Core project's official Docker
Hub image. 28.0 was already cached on this host and is the version the prior
emulator session validated the whole toolchain against (incl. the
mempool/electrs compatibility note); 29.x would work identically.

## 3. Trezor (trezor-user-env)

```
$ node setup-trezor.mjs
emulator-start: ok "Emulator version 2.7.2 (T2T1) started and wiped to be empty"
emulator-setup: ok "Emulator set up - ... 'all all all all all all all all all all all all' ..."
bridge-start: ok "Bridge version 2.0.33 started"
proxy injected; bridge should now answer on http://127.0.0.1:31325
bridge check: 200 {"version":"2.0.33"}

$ curl -s -X POST -H "Origin: https://connect.trezor.io" http://127.0.0.1:31325/enumerate
[{"path":"1","vendor":0,"product":0,"debug":true,"session":null,"debugSession":null}]

$ node trezor-xpub.mjs
local  master fingerprint: 5c9e228d
local  xpub @ m/48'/0'/0'/2' : xpub6EgGHjcvovyN3nK921zAGPfuB41cJXkYRdt3tLGmiMyvbgHpss4X1eRZwShbEBb1znz2e2bCkCED87QZpin3sSYKbmCzQ9Sc7LaV98ngdeX
device xpub @ m/48'/0'/0'/2' : xpub6EgGHjcvovyN3nK921zAGPfuB41cJXkYRdt3tLGmiMyvbgHpss4X1eRZwShbEBb1znz2e2bCkCED87QZpin3sSYKbmCzQ9Sc7LaV98ngdeX
MATCH: device xpub == local derivation. Trezor signer ready.
```

The device xpub came over the REAL `@trezor/connect` Node entrypoint through
the bridge on port 31325 (custom `BridgeTransport` subclass — see script).

## 4. Ledger (Speculos + app-bitcoin-new 2.4.6 mainnet, nanosp)

```
$ docker logs vault-e2e-speculos | tail
[*] Seed initialized from environment
[*] Env app name: 'Bitcoin'
[*] Env app version: '2.4.6'

$ node speculos-check.mjs
automation API /events: 200 {"events":[{"text":"Bitcoin",...},{"text":"app is ready",...}]}
local  master fingerprint: 6f309170
local  xpub @ m/48'/0'/0'/2' : xpub6ETWasCa39YssF19BXoBWo3rpyBBqLBn2wJ7o4HCdqje7KTt9FU57PXyDKd2KFP1npQLhN6aXJ9R5DqJEBKcKd5xHn8xjAVTsGJbmG4cMQ5
device master fingerprint: 6f309170
device xpub @ m/48'/0'/0'/2' : xpub6ETWasCa39Yss...  (identical)
MATCH: device fingerprint + xpub == local derivation. Ledger signer ready.

$ curl -s -X POST http://127.0.0.1:25000/button/right -d '{"action":"press-and-release"}'
{}
$ curl -s "http://127.0.0.1:25000/events?currentscreenonly=true"
{"events": [{"text": "App settings", ...}]}     # screen actually navigated -> button automation works
```

APDU path exercised via `@ledgerhq/hw-transport-node-speculos-http`
(installed in this directory's own node_modules; repo package.json untouched).
ELF provenance: LedgerHQ/app-bitcoin-new CI artifact `bitcoin-app-nanosp`
(GitHub releases ship no binaries), sha256
`bd1a1812f0bf657af43a3391d46a3f944bafcdbf2b7bac4de3ce7460ac45770a`, previously
downloaded to `.hw-emu-test/ledger-app/` and proven to sign there.

## 5. ColdCard file signer

```
$ node cc-sign.mjs --selftest
{ "signer": "coldcard-file", "xfp": "73c5da0a", "path": "m/48'/0'/0'/2'",
  "xpub": "xpub6DkFAXWQ2dHxq2vatrt9qyA3bXYU4ToWQwCHbf5XB2mSTexcHZCeKS1VZYcPoBd5X8yVcbXFHJR9R8UCVpt82VX1VhR28mCyxUFL4r6KFrf" }
```

## 6. Core-wallet cosigners

```
$ node core-signer.mjs create signer-a
{ "signer":"core", "wallet":"signer-a", "xfp":"45b76288", "path":"m/48'/0'/0'/2'",
  "xpub":"xpub6DrT2f9DCRig...", "tpub":"tpubDEE5Ytxtuhg9...", "keyOriginTprv":"[45b76288/48h/0h/0h/2h]tprv8hY3QUvemKzU.../<0;1>/*" , ... }
$ node core-signer.mjs create signer-b
{ ... "xfp":"dccd724f", ... }
```
(xfp/xpubs are random per wallet creation — regenerate after recreating bitcoind.)

## 7. Full 2-of-3 quorum rehearsal (ColdCard + 2 Core cosigners)

```
$ node verify-quorum.mjs
cosigners: 73c5da0a 45b76288 dccd724f
vault address: bcrt1qq5ktuqs7ghfkes6ev84nz2e79lg3p4x5aqh8mcx6040eyn3hgmxq7rjh8y
vault balance: 2
taproot destination: bcrt1pz0frcdehgm87tpl8st7vgj5xszgr5dl5l7rrrgysya49jm6ee2ystkpgqh
cc-sign: {"signedInputs":1,"xfp":"73c5da0a","out":"...\\spend-signed.psbt"}
quorum enforced: 1 signature does not finalize
2nd signature completes the quorum
{ "txid": "10a70fcdef8373d51d095ee26c63c8de9346c433c4ef8f06148f8afa2edef277",
  "confirmations": 1,
  "dest": "bcrt1pz0frcdehgm87tpl8st7vgj5xszgr5dl5l7rrrgysya49jm6ee2ystkpgqh" }
VAULT 2-OF-3 REHEARSAL PASSED
```

This exercised: BIP48 sortedmulti wsh descriptor import + address derivation,
vault funding, `walletcreatefundedpsbt` with correct bip32 derivations, the
ColdCard binary `.psbt` file round trip, quorum enforcement (1 sig rejected by
`finalizepsbt`), `descriptorprocesspsbt` cosigning, broadcast to a
taproot/bech32m (bc1p-equivalent) destination, and confirmation.

## Issues hit and resolved (so the E2E agent doesn't re-hit them)

1. `docker exec <c> python3 /tmp/proxy.py` → Git Bash rewrote `/tmp/...` to a
   Windows path (`can't open file '/trezor-user-env/C:/Users/...'`). Fix:
   wrap in `sh -c`.
2. `docker exec -d ... sh -c "nohup python3 ... &"` → proxy died with the
   shell (no process, empty log). Fix: `sh -c "exec python3 ..."` under `-d`.
3. Bare `curl http://127.0.0.1:21325/` inside the container → HTTP 403:
   trezord-go enforces an Origin allowlist. Send an `Origin:
   https://connect.trezor.io` header when probing manually.
4. `getdescriptorinfo` on a multipath `sortedmulti(...<0;1>...)` descriptor →
   `Key path value '<0;1>' is not a valid uint32` (Core 28 limitation for
   multi). Expand to `/0/*` and `/1/*` twins.
5. Private-descriptor checksum: use the `.checksum` field of
   `getdescriptorinfo` (checksum of input as given); `.descriptor` is the
   normalized PUBLIC form whose checksum differs → `Provided checksum ...
   does not match` from `descriptorprocesspsbt` otherwise.
6. Re-importing an already-active descriptor into the same watch wallet →
   `new range must include current range` → verify-quorum uses a unique
   wallet name per run.

## Vault E2E through Cairn's OWN code (bead cairn-a4k) — PASSED 2026-07-06

The rehearsal above proves the *stack*; this run proves **Cairn's real modules**
drive the whole journey. Test: `src/lib/server/bitcoin/vaultRegtestE2E.test.ts`
(gated behind `VAULT_E2E=1`, inert in normal CI).

```
VAULT_E2E=1 npx vitest run src/lib/server/bitcoin/vaultRegtestE2E.test.ts
  ✓ vault 2-of-3 regtest E2E through Cairn multisig code (cairn-a4k)
  a4k: broadcast txid c367f9b925c269b950bff0bf1b750a4fbab166af3c9b5487a6689a419c06df17, confirmations 1
```

What ran through Cairn's actual code (not a parallel re-implementation):
- `createMultisig` / `toMultisigConfig` — 2-of-3 p2wsh vault from three real
  BIP48 cosigners (two Core signers + the known-mnemonic ColdCard key).
- `deriveMultisigAddress` — Cairn's derived scriptPubKey asserted **byte-equal**
  to Bitcoin Core's `deriveaddresses` for the same index (mainnet-xpub vs
  regtest-tpub derivation agree, as they must — pubkey derivation is
  version-byte-independent).
- `constructMultisigPsbt` — built the actual spend PSBT from the funded UTXO.
- Quorum enforced: one `descriptorprocesspsbt` signature does **not** finalize;
  the second completes it (matches the real 2-of-3 policy).
- Broadcast + confirmed on regtest (txid above).
- `caravanExport` → `parseCaravanImport` round-trip: threshold + all three
  fingerprints preserved; descriptor is `wsh(sortedmulti(2,...))`.

Signing here uses Core-wallet cosigners (deterministic, CI-able) rather than the
Trezor/Speculos emulators; the emulators' own signing paths are already proven
against Cairn's exact `trezor.ts`/`ledger.ts` translation code in `.hw-emu-test`
(single-sig) — this test closes the remaining gap: Cairn's **multisig** builder
and export in a live fund→spend→broadcast loop.
