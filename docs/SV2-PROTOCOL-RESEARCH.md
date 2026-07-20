# Stratum V2 (SRI) Protocol Research — Reference for Heartwood Integration

**Date:** 2026-07-19 · **Session:** SV2 Protocol Research (scoping only, no implementation)
**Sources studied:** local clones of `stratum-mining/sv2-ui`, `stratum-mining/stratum`, `stratum-mining/sv2-apps` (all `main`, cloned 2026-07-19); `stratum-mining/sv2-spec` (raw markdown); Docker Hub + GitHub releases APIs.
File citations below use `sv2-ui/...`, `sv2-apps/...`, `stratum/...` relative paths into those repos.

---

## 1. Executive overview

- **The SRI code has been split across three repos.** `stratum-mining/stratum` now contains *only* the low-level protocol crates (workspace member `stratum-core`, with `sv1/` and `sv2/` crate trees: `binary-sv2`, `codec-sv2`, `framing-sv2`, `noise-sv2`, `channels-sv2`, `handlers-sv2`, `parsers-sv2`, `subprotocols/`, etc. — see `stratum/Cargo.toml`). The runnable roles live in **`stratum-mining/sv2-apps`** (status: **alpha**, per `sv2-apps/README.md`). The wizard/dashboard is **`stratum-mining/sv2-ui`**.
- **Four runnable roles, three binaries.** `pool_sv2` (SV2 pool, with an *embedded* Job Declarator Server subserver), `jd_client_sv2` (miner-side Job Declarator Client), `translator_sv2` (SV1→SV2 Translator Proxy). The standalone `jd-server` is now a library crate consumed by the pool (`sv2-apps/pool-apps/jd-server/` has no config-examples and no binary; the pool config has a `[jds]` section instead).
- **Template Provider question is resolved upstream — but creates Heartwood's biggest deployment constraint.** The Sjors-patched-Core era is over. Templates come from **official Bitcoin Core v30.x/v31.x via the multiprocess Mining IPC interface** (Cap'n Proto over a UNIX socket, `-ipcbind=unix`, `node.sock`), consumed directly by pool/JDC through the `sv2-apps/bitcoin-core-sv2` crate. Alternatively, a hosted/local TCP Template Provider (`[template_provider_type.Sv2Tp]`, default port 8442) can be used — served by the `stratum-mining/sv2-tp` sidecar (MIT, tags to v1.1.1), which *itself* talks to Core over the same IPC interface. **Either way you need a Core v30+ node started in multiprocess mode with `-ipcbind=unix`** — stock Umbrel bitcoind does not do this today (see §7).
- **Unmodified V1 miners (Bitaxe etc.) need only the Translator Proxy.** One container, SV1 listen on 34255, upstream = any SV2 endpoint (pool or JDC) + its base58 authority pubkey. For "connect Heartwood users to an external V2 pool," a single `translator_sv2` container is the entire footprint.
- **Everything is dual-licensed MIT OR Apache-2.0** (sv2-apps, stratum, sv2-ui). `sv2-tp` is MIT. No copyleft anywhere in the stack; bundling in Heartwood is unproblematic.
- **Distribution is good:** multi-arch (amd64+arm64) Docker images on Docker Hub (`stratumv2/{pool_sv2,jd_client_sv2,translator_sv2}`, tags `v0.1.0`…`v0.6.0` + `main`), *and* prebuilt static binaries (x86_64/aarch64, linux-musl + darwin) attached to every sv2-apps GitHub release — so a **native, no-Docker bundle is feasible**, matching how Heartwood runs its Tessera-derived V1 pool in-process today.

---

## 2. Repo landscape

| Repo | Role | State observed |
|---|---|---|
| `stratum-mining/stratum` | Protocol crates only (`stratum-core`; `sv1/`, `sv2/` crate trees; noise, codec, framing, channels, handlers) | Workspace excludes integration tests; MSRV pinned via `rust-toolchain.toml` (1.75 note in Cargo.toml comments) |
| `stratum-mining/sv2-apps` | Runnable roles + shared app utils + `bitcoin-core-sv2` IPC crate + Docker compose | **Alpha** (README); releases v0.1.0 (2025-11-27) → **v0.6.0 (2026-07-08)**; MSRV 1.88.0 |
| `stratum-mining/sv2-ui` | React wizard + Express backend that orchestrates containers via Dockerode and proxies monitoring APIs | Actively developed; Umbrel is an explicit OS target (`sv2-ui/shared/src/constants.ts`, `DEFAULT_BITCOIN_PATHS.umbrel = '~/.bitcoin'`; `src/components/setup/icons/UmbrelIcon.tsx`) |
| `stratum-mining/sv2-tp` | Sidecar TCP Template Provider (Core-derived), speaks TDP on :8442, consumes Core Mining IPC | Tags to v1.1.1; MIT |
| `stratum-mining/sv2-spec` | Protocol spec (also rendered at stratumprotocol.org/specification) | Authoritative for framing/security details below |

---

## 3. Protocol fundamentals (from sv2-spec 03/05/06/07)

**Three sub-protocols:** Mining Protocol (miners/proxies ↔ pool), Job Declaration Protocol (JDC ↔ JDS; miner-chosen templates), Template Distribution Protocol (TDP; replaces `getblocktemplate`).

**Framing (6-byte header + payload):** `extension_type` U16 (0x0000 core; LSB = `channel_msg` bit for channel-routed messages), `msg_type` U8, `msg_length` U24, then payload (leading `channel_id` U32 when channel-scoped). Data types: U8/U16/U24/U32/U64/U256, `STR0_255`, `B0_255`/`B0_64K`/`B0_16M`, `PUBKEY` (32B x-only secp256k1), `SIGNATURE` (64B Schnorr), `MAC` (16B). Extensions use TLV fields appended to messages; experimental range 0x4000–0x7fff. SRI currently defines extension **0x0002 "Worker-Specific Hashrate Tracking"** (referenced in all three config templates' `supported_extensions`).

**Channels:**
- *Standard channels* — header-only mining (HOM): device rolls only `version`/`nonce`/`nTime`; fixed merkle root; `NewMiningJob`.
- *Extended channels* — for proxies; adjustable extranonce (`extranonce_prefix` + locally-reserved + downstream-reserved); `NewExtendedMiningJob` carries `coinbase_tx_prefix`/`coinbase_tx_suffix` + `merkle_path` so the proxy can build per-device merkle roots.
- *Group channels* — broadcast grouping of channels (same full-extranonce size required).

**Key mining messages:** `SetupConnection` (flags REQUIRES_STANDARD_JOBS / REQUIRES_WORK_SELECTION / REQUIRES_VERSION_ROLLING), `OpenStandardMiningChannel`/`OpenExtendedMiningChannel` (`user_identity`, `nominal_hash_rate`, `max_target`, `min_extranonce_size`), `SetNewPrevHash`, `SubmitSharesStandard`/`SubmitSharesExtended`, `SetTarget` (server-driven vardiff).

**TDP messages:** client (pool/JDC) sends `CoinbaseOutputConstraints` (`coinbase_output_max_additional_size`, `..._max_additional_sigops`); server (TP) pushes `NewTemplate` (`template_id`, `coinbase_prefix`, `coinbase_tx_outputs`, `merkle_path`, `future_template`) and `SetNewPrevHash`; client can `RequestTransactionData`; solutions go back via `SubmitSolution` (TP assembles and propagates the block).

**JDP messages:** `AllocateMiningJobToken` → `DeclareMiningJob` (full-template txid list) → `ProvideMissingTransactions` → `PushSolution`; ties into Mining Protocol via `SetCustomMiningJob` to the pool. Token lifecycle (allocated → active, single-use) is documented in `sv2-apps/pool-apps/jd-server/README.md`.

---

## 4. Noise encryption & key management

From sv2-spec `04-Protocol-Security.md` and `sv2-apps/stratum-apps/src/key_utils/mod.rs`:

- **Handshake:** Noise **NX** + server authentication through a 2-level PKI. Curve secp256k1 with BIP324 ElligatorSwift x-only encoding (64B ephemeral keys on the wire); AEAD default **ChaCha20-Poly1305** (AES-GCM supported — both in `stratum/Cargo.toml` workspace deps); hash SHA-256.
- **Certificates:** server presents a `SIGNATURE_NOISE_MESSAGE` (74B: `version` U16, `valid_from` U32, `not_valid_after` U32, 64B Schnorr sig). The **authority keypair** signs `SHA-256(version‖valid_from‖not_valid_after‖server_static_pubkey)` (BIP340). Client verifies against the configured `authority_pubkey` and checks validity window.
- **Key encoding in configs:** Base58check with a 2-byte version prefix — e.g. `authority_public_key = "9auqWEzQDVyd2oe1JVGFLMLHZtCo2FFqZwtKA5gd9xbuEu7PH72"`. Parsing/serialization in `key_utils/mod.rs` (bs58 + secp256k1 x-only, Schnorr).
- **Operational facts:**
  - Every server-side role (pool, JDC-as-downstream-server) needs `authority_public_key` + `authority_secret_key` + `cert_validity_sec` (3600 in all templates). Certificates are re-signed on a rolling basis; **clock sync matters** — `sv2-apps/docker/README.md` explicitly warns a few seconds of drift can cause `InvalidCertificate` errors (NTP required).
  - Clients (translator upstreams, JDC upstreams) need only the server's public `authority_pubkey`.
  - **Hazard:** the well-known SRI dev keypair (`9auqWEzQ…` / `mkDLTBBR…`) is hardcoded in `sv2-apps/docker/config/*.template` *and* in `sv2-ui/server/src/config-generator.ts` (JDC section, including the *secret* key). Fine for a localhost-only JDC↔translator hop, but a Heartwood pool serving remote crew members must generate its own authority keypair. No keygen binary ships in sv2-apps (`stratum-apps/src/bin/` contains only `generate-openapi.rs`); the `key-utils` crate (crates.io 1.2.0) provides the primitives — Heartwood would generate keys itself (small Rust util or reimplement base58check+secp256k1 in Node).

---

## 5. Role-by-role breakdown

### 5.1 `pool_sv2` (SV2 Pool, with embedded JDS)
- **Source:** `sv2-apps/pool-apps/pool/` (binary; `src/main.rs`, `config.rs`, `pool_runtime.rs`, handlers incl. `template_distribution_message_handler.rs`).
- **Ports:** SV2 mining listen **3333** (`listen_address = "0.0.0.0:3333"`); embedded JDS listen **3334** (`[jds] listen_address = "0.0.0.0:3334"`); monitoring HTTP **9090**.
- **Config:** `pool-config.toml` — see §9.1. Coinbase payout as a descriptor (`coinbase_reward_script = "addr(<address>)"`; musig unsupported, combo never), `server_id` (unique search-space allocation across pool servers), `pool_signature` (coinbase tag string), `shares_per_minute`, `share_batch_size`, extensions lists, monitoring, and a `template_provider_type` — either `BitcoinCoreIpc` (§7) or `Sv2Tp`.
- **Maturity:** alpha (repo-wide). Actively released; v0.6.0 notes cite "runtime architecture modernization" and expanded Core version support.

### 5.2 `jd_client_sv2` (Job Declarator Client)
- **Source:** `sv2-apps/miner-apps/jd-client/`.
- **Ports:** SV2 listen for downstream translator **34265**; monitoring HTTP **9091**.
- **Config:** `jdc-config.toml` — see §9.2. Modes: `FULLTEMPLATE`, `COINBASEONLY`, and (per `sv2-ui/server/src/config-generator.ts`) `SOLOMINING`. Is itself a Noise *server* toward the translator (has authority keys); is a client toward pool + JDS + Template Provider. `[[upstreams]]` entries carry `authority_pubkey`, `pool_address`, `pool_port`, `jds_address`, `jds_port`, `user_identity`; solo mode uses `upstreams = []` and mines to its own `coinbase_reward_script`, with pools (if any) as fallback.
- **Requires** a Template Provider (`[template_provider_type.BitcoinCoreIpc]`).

### 5.3 `translator_sv2` (Translator Proxy) — see deep-dive §6
- **Ports:** SV1 downstream listen **34255**; monitoring HTTP **9092**.

### 5.4 `jd-server` (JDS)
- Library crate only (`sv2-apps/pool-apps/jd-server/`: `Cargo.toml`, `README.md`, `src/`, no config-examples). Runs embedded in the pool when `[jds]` is present; inherits authority keys / cert validity / coinbase script from the pool config; requires `template_provider_type = BitcoinCoreIpc` ("engine_config derived from it" — comment in `pool-jds-config.toml.template`). Validation engine is trait-based (`JobValidationEngine`) with the initial impl on Core IPC.

### 5.5 `sv2-tp` (TCP Template Provider sidecar)
- Separate repo `stratum-mining/sv2-tp` (MIT, ≤ v1.1.1). Serves TDP over TCP (**8442** by convention; own `authority`-style pubkey in `[template_provider_type.Sv2Tp] public_key`), consuming Core's Mining IPC interface. SRI hosts a community instance (`75.119.150.111:8442` in `pool-config-hosted-sv2-tp-example.toml`). Only needed if the TDP client can't reach `node.sock` directly (e.g. cross-host).

### 5.6 Monitoring API (all three binaries)
Shared implementation `sv2-apps/stratum-apps/src/monitoring/` (axum). Routes (`routes.rs`): `/` (endpoint listing), **`/metrics` (Prometheus)**, `/swagger-ui`, `/api-docs/openapi.json`, and under **`/api/v1`**: `/health`, `/global`, `/server`, `/server/channels`, `/clients`, `/clients/{id}`, `/clients/{id}/channels`, and translator-specific `/sv1/clients`, `/sv1/clients/{id}`. Config keys: `monitoring_address`, `monitoring_cache_refresh_secs` (15 in all templates). sv2-ui consumes these through its Express backend (normalization layer; contract doc `sv2-ui/docs/monitoring-api-compatibility.md`; types generated from `sv2-ui/shared/openapi.json`).

---

## 6. Translator Proxy deep-dive (the piece that serves Bitaxes)

**What it is:** a bridge that presents a plain **Stratum V1 pool server** to unmodified SV1 ASICs and holds **one Noise-encrypted SV2 connection** (or one per miner) to an upstream SV2 endpoint (pool directly, or local JDC).

**What it translates** (source: `sv2-apps/miner-apps/translator/src/lib/`):
- Downstream (`sv1/sv1_server/`): full SV1 session — `mining.subscribe`, `mining.authorize`, `mining.notify`, `mining.set_difficulty`, `mining.submit` (`downstream_message_handler.rs`), plus its own **vardiff** per miner (`difficulty_manager.rs`).
- Upstream (`sv2/upstream/`, `sv2/channel_manager/`): opens an **extended channel** (or aggregated channel), receives `NewExtendedMiningJob` + `SetNewPrevHash`, slices the extranonce space per SV1 miner, rebuilds SV1 `mining.notify` jobs, converts accepted SV1 submits into `SubmitSharesExtended`, honors upstream `SetTarget`.
- **State held:** SV1 client registry (id ↔ channel/extranonce slice), job-id maps (SV1 job ↔ SV2 job/template), per-miner difficulty state, upstream channel state. All in-memory; restart = miners reconnect (SV1 miners auto-reconnect).

**Config it needs** (complete field list in §9.3): SV1 listen (`downstream_address`/`downstream_port` 34255), `downstream_extranonce2_size` (2–8; CGMiner max 8; default 4), `aggregate_channels` (true = all miners share one upstream channel — sv2-ui forces true for Braiins, `sv2-ui/shared/src/pools.ts`), `verify_payout` (solo/donation identities only: tproxy checks upstream coinbase outputs actually pay the address encoded in `user_identity`, formats `sri/solo/<address>/<worker>`, `sri/donate/<pct>/<address>/<worker>`, or legacy `<address>[.worker]`), `[downstream_difficulty_config]` (`min_individual_miner_hashrate`, `shares_per_minute` — default 6.0, `enable_vardiff` — disable when JDC handles vardiff, `job_keepalive_interval_secs` 60), and `[[upstreams]]` (`address`, `port`, `authority_pubkey`, `user_identity`) — multiple entries = ordered fallback.

**For a Bitaxe:** point it at `stratum+tcp://<heartwood-host>:34255`, username = pool username or solo address identity. Nothing else changes on the device. (Side note: Bitaxe firmware is gaining native SV2 — `bitaxeorg/ESP-Miner` PR #1553 — but translator remains the compatibility path.)

---

## 7. Template Provider situation (current state, and the Heartwood blocker)

**History:** SRI used to require a patched Bitcoin Core fork (Sjors' sv2 branch) speaking TDP over TCP on 8442. **That fork is dead as a requirement.** Bitcoin Core upstreamed a generic **Mining IPC interface** (multiprocess, Cap'n Proto over UNIX socket; PRs #29432 lineage, #30440, #31981, etc.).

**Current state (as of the repos, 2026-07):**
- Core **v30.x and v31.x** expose the Mining interface when run as the multiprocess binary with IPC enabled: `bitcoin -m node -ipcbind=unix` (per `sv2-apps/docker/README.md`). Socket paths: mainnet `~/.bitcoin/node.sock`, testnet4 `~/.bitcoin/testnet4/node.sock`, signet `~/.bitcoin/signet/node.sock`.
- `sv2-apps/bitcoin-core-sv2/` translates that IPC into TDP (and JDP validation) in-process: `runtime_api::template_distribution_protocol::new(version, …)` with per-version capnp bindings (`unix_capnp/v30x/`, `v31x/`, `v31x_v30x/`). Version is a **config field**, not autodetected: `[template_provider_type.BitcoinCoreIpc] version = 30|31`. Requires `capnproto` at build time; runs inside a `tokio::task::LocalSet` (non-Send).
- Template tuning knobs: `fee_threshold` (sats of mempool fee delta before a new `NewTemplate`) and `min_interval` (min secs between templates; new-tip updates always immediate).
- Fallback for nodes you can't run IPC against on the same host: `[template_provider_type.Sv2Tp]` with `address`/`public_key` → the `sv2-tp` sidecar (which itself needs IPC to a v30+ multiprocess Core wherever *it* runs).
- sv2-ui validates the socket by bind-mounting it into a probe container (`sv2-ui/server/src/docker.ts`, `bitcoin-socket-validator.ts`) and notes **Windows unsupported** for IPC (README).

**Heartwood implication (the blocker):** every solo topology needs a Core v30+ **multiprocess** node with `-ipcbind=unix`. On Umbrel, Heartwood uses the Umbrel Bitcoin app's bitcoind, which (a) may be < v30, (b) is the monolithic binary, (c) is not started with `-ipcbind`, and (d) its `node.sock` (if enabled) would live inside another app's container/volume. Options to scope: request/config-inject `-ipcbind=unix` in the Umbrel bitcoin app (it supports advanced custom args — needs verification), bundle sv2-tp next to the node, or bundle our own pruned template node (heavy). **Without solving this, only the "external V2 pool via translator (no-JD)" topology works on Umbrel.** Note this constraint does *not* apply to Heartwood's existing V1 solo pool (which uses `getblocktemplate` RPC) — SV2 pool/JDC roles simply don't speak RPC for templates.

---

## 8. Minimal process topologies

### (a) Solo mining with operator's own Core (two variants)
1. **Sovereign solo (pool-less, what sv2-ui ships):** `translator_sv2` + `jd_client_sv2` (mode `SOLOMINING`, `upstreams = []`, `coinbase_reward_script = addr(<user address>)`) + Core v30+ IPC. **2 processes** + node. Miner → :34255 → translator → :34265 → JDC → node.sock. Block found ⇒ submitted via IPC directly. No pool_sv2 at all.
2. **Own SV2 solo pool (multi-user, closer to Heartwood's current product):** `pool_sv2` (embedded JDS optional; `BitcoinCoreIpc` TP) + `translator_sv2` for V1 ASICs. **2 processes** + node. Native SV2 miners connect straight to :3333, V1 miners via :34255. Per-user payout requires pool-side accounting — SRI pool pays `coinbase_reward_script` (single descriptor), so Heartwood's per-connection-coinbase model maps more naturally onto variant 1 run per-user, or onto keeping share accounting in Heartwood (see Proposed beads).

### (b) Connecting to an external V2 pool
1. **No-JD (pool's templates):** `translator_sv2` only. **1 process, no node dependency.** Upstream = pool address/port + authority pubkey (e.g. Braiins `stratum.braiins.com`, key `9awtMD5KQgvRUh2yFbjVeT7b6hjipWcAsQHd6wEhgtDT9soosna` — `sv2-ui/shared/src/pools.ts`).
2. **JD (own templates, pool accounting):** `translator_sv2` + `jd_client_sv2` (mode `FULLTEMPLATE`, upstreams = pool + its JDS, e.g. `jds_port = 3334`) + Core v30+ IPC. **2 processes** + node.

### sv2-ui's own orchestration (pattern reference)
`sv2-ui/server/src/docker.ts` (Dockerode): creates network `sv2-network`, volume `sv2-config`, containers `sv2-translator` / `sv2-jdc`; writes generated TOMLs into the shared volume; container-name DNS for upstream addressing (`address = "sv2-jdc"`); `stop_signal` SIGINT; graceful shutdown stops children. Wizard step flow (`sv2-ui/src/components/setup/SetupWizard.tsx` `computeSteps()`): mining-mode → template-mode → [bitcoin-prereq → bitcoin | pool] → hashrate → [identity] → review. Bitcoin readiness probes run in throwaway `node:20-bookworm-slim` containers that bind-mount the datadir/socket (RPC probe via host loopback or `host.docker.internal`).

---

## 9. Config file reference (actual files)

### 9.1 Pool — `pool-config.toml`
Template: `sv2-apps/docker/config/pool-jds-config.toml.template`; examples: `sv2-apps/pool-apps/pool/config-examples/{mainnet,testnet4,signet}/` (`pool-config-bitcoin-core-ipc-example.toml`, `pool-config-hosted-sv2-tp-example.toml`, `pool-config-local-sv2-tp-example.toml`, `pool-jds-config-bitcoin-core-ipc-example.toml`).

```toml
authority_public_key = "<base58check>"      # Noise authority (server identity)
authority_secret_key = "<base58check>"
cert_validity_sec = 3600
listen_address = "0.0.0.0:3333"             # SV2 mining protocol
coinbase_reward_script = "addr(bc1q...)"    # BIP380 descriptor; no musig/combo
server_id = 1                               # unique search-space id across pool servers
pool_signature = "Stratum V2 SRI Pool"      # coinbase tag
shares_per_minute = 6.0
share_batch_size = 10
supported_extensions = [ ] # e.g. 0x0002 worker-specific hashrate tracking
required_extensions = [ ]
monitoring_address = "0.0.0.0:9090"
monitoring_cache_refresh_secs = 15
# log_file = "./pool.log"

[template_provider_type.BitcoinCoreIpc]     # ...or [template_provider_type.Sv2Tp]
version = 31                                # 30 | 31
network = "mainnet"                         # mainnet | testnet4 | signet
fee_threshold = 1000                        # sats delta before new template
min_interval = 5                            # secs between templates

# [template_provider_type.Sv2Tp]
# address = "127.0.0.1:8442"                # or hosted "tp.example.com:8442"
# public_key = "<base58check>"              # sv2-tp's authority key (hosted variant)

[jds]                                       # optional embedded Job Declarator Server
listen_address = "0.0.0.0:3334"
```

### 9.2 JD Client — `jdc-config.toml`
Template: `sv2-apps/docker/config/jdc-config.toml.template`; examples: `sv2-apps/miner-apps/jd-client/config-examples/<network>/`; sv2-ui generation: `sv2-ui/server/src/config-generator.ts::generateJdcConfig`.

```toml
listening_address = "0.0.0.0:34265"         # SV2 server for downstream translator
max_supported_version = 2
min_supported_version = 2
authority_public_key = "<base58check>"      # JDC's own Noise identity (server side)
authority_secret_key = "<base58check>"
cert_validity_sec = 3600
shares_per_minute = 6.0
share_batch_size = 5
mode = "FULLTEMPLATE"                       # FULLTEMPLATE | COINBASEONLY | SOLOMINING
jdc_signature = "solo_miner"                # coinbase scriptSig tag
coinbase_reward_script = "addr(bc1q...)"    # payout for solo / pool-fallback-exhausted
supported_extensions = [ ]
monitoring_address = "0.0.0.0:9091"
monitoring_cache_refresh_secs = 15

upstreams = []                              # SOLOMINING; else repeated tables:
# [[upstreams]]                             # ordered fallback list
# authority_pubkey = "<pool authority>"
# pool_address = "pool.example.com"
# pool_port = 3333
# jds_address = "pool.example.com"          # JDS often embedded in pool
# jds_port = 3334
# user_identity = "username"

[template_provider_type.BitcoinCoreIpc]
version = 31
network = "mainnet"
fee_threshold = 1000
min_interval = 5
```

### 9.3 Translator — `tproxy-config.toml`
Template: `sv2-apps/docker/config/translator-proxy-config.toml.template`; examples: `sv2-apps/miner-apps/translator/config-examples/<network>/` (`tproxy-config-hosted-pool-example.toml`, `tproxy-config-local-jdc-example.toml`, `tproxy-config-local-pool-example.toml`); sv2-ui generation: `config-generator.ts::generateTranslatorConfig`.

```toml
downstream_address = "0.0.0.0"
downstream_port = 34255                     # SV1 miners connect here
max_supported_version = 2
min_supported_version = 2
downstream_extranonce2_size = 4             # min 2, CGMiner max 8
verify_payout = false                       # true only for sri/solo|sri/donate|<addr> identities
aggregate_channels = false                  # true = one shared upstream channel (Braiins)
supported_extensions = [ 0x0002 ]           # worker-specific hashrate tracking
required_extensions = [ ]
monitoring_address = "0.0.0.0:9092"
monitoring_cache_refresh_secs = 15
# log_file = "./tproxy.log"

[downstream_difficulty_config]
min_individual_miner_hashrate = 10_000_000_000_000.0   # weakest expected miner, H/s
shares_per_minute = 6.0
enable_vardiff = true                       # false when JDC manages vardiff
job_keepalive_interval_secs = 60            # 0 disables

[[upstreams]]                               # repeatable; ordered fallback
address = "sv2-jdc"                         # hostname/IP (container DNS ok)
port = 34265                                # 3333 when pointing at a pool directly
authority_pubkey = "<base58check>"
user_identity = "username-or-solo-identity"
```

### 9.4 `docker_env` (compose variable sheet)
`sv2-apps/docker/docker_env.example` — single env file feeding all templates via `envsubst`: `BITCOIN_SOCKET_PATH`, `POOL_COINBASE_REWARD_SCRIPT`, `POOL_SIGNATURE`, `POOL_SHARES_PER_MINUTE`, `POOL_SHARE_BATCH_SIZE`, `POOL_FEE_THRESHOLD`, `POOL_MIN_INTERVAL`, `POOL_BITCOIN_CORE_IPC_VERSION`, `JDC_*` equivalents (+ `JDC_UPSTREAM_AUTHORITY_PUBKEY`, `JDC_POOL_ADDRESS/PORT`, `JDC_UPSTREAM_JDS_ADDRESS/PORT`), `TPROXY_USER_IDENTITY`, `TPROXY_VERIFY_PAYOUT`, `TPROXY_AGGREGATE_CHANNELS`, `TPROXY_MIN_INDIVIDUAL_MINER_HASHRATE`, `TPROXY_SHARES_PER_MINUTE`, `TPROXY_ENABLE_VARDIFF`, `TPROXY_UPSTREAM_ADDRESS/PORT/AUTHORITY_PUBKEY`.

---

## 10. Docker image & binary inventory

**Docker Hub (`stratumv2/` org), all amd64+arm64:**
| Image | Tags | Role |
|---|---|---|
| `stratumv2/pool_sv2` | `v0.1.0`…`v0.6.0`, `main` | Pool (+embedded JDS) |
| `stratumv2/jd_client_sv2` | same series | JDC |
| `stratumv2/translator_sv2` | same series (`v0.6.0` 2026-07-08; `main` rebuilt 2026-07-19) | Translator |
| `stratumv2/sv2-ui` | `main` | Wizard/dashboard (needs docker.sock) |

Compose reference: `sv2-apps/docker/docker-compose.yml` — profiles `pool_apps`, `miner_apps`, `tproxy`, `pool_and_miner_apps`, `pool_and_miner_apps_no_jd`; `stop_signal: SIGINT`; configs rendered by `envsubst` at container start; `node.sock` bind-mounted to `/root/.bitcoin/node.sock`; pool monitoring bound `127.0.0.1:9090` on host.

**Prebuilt native binaries:** every sv2-apps GitHub release attaches `miner-apps` and `pool-apps` archives for **x86_64/aarch64 linux-musl** (static — good for bundling into a Heartwood/Umbrel image without a Rust toolchain) and darwin. Alternatively `cargo build` (MSRV 1.88, `capnproto` needed for bitcoin-core-sv2).

**Port map (defaults) vs Heartwood:**
| Port | SRI use | Heartwood conflict? |
|---|---|---|
| 3333 | pool_sv2 SV2 listen | **Yes — Heartwood V1 stratum runs on 3333** |
| 3334 | embedded JDS | **Yes — Heartwood second ASIC port 3334** |
| 34255 | translator SV1 listen | free |
| 34265 | JDC SV2 listen | free |
| 8442 | sv2-tp TDP | free |
| 9090/9091/9092 | pool/JDC/translator monitoring | free (keep LAN-only) |
| 34254 | `DEFAULT_POOL_PORT` in sv2-ui constants | free |

---

## 11. sv2-ui monitoring/UX approach (pattern to mirror)

- Express backend proxies the roles' `/api/v1/*` endpoints and normalizes shapes before React sees them (insulation contract: `sv2-ui/docs/monitoring-api-compatibility.md`); TS types generated from `sv2-ui/shared/openapi.json` (endpoints listed in §5.6).
- Dashboard (`src/pages/UnifiedDashboard.tsx` + `src/components/data/`): pool connection status incl. active-upstream/fallback tracking (`server/src/active-pool.ts`), total hashrate, active workers (from translator `/api/v1/sv1/clients`), shares to pool, hashrate history chart (client-side accumulation, `usePersistentDashboardMetrics.ts`), per-container log panels with parsed diagnostics (`server/src/logs/parsers.ts`, `diagnostics.ts` — pattern-matches known failure signatures like cert errors and socket failures).
- Setup wizard collects: mining mode (solo/pool) → template mode (JD/no-JD) → pool choice (curated list with authority keys baked in) or Bitcoin node setup (OS → datadir → socket path autocompute → dockerized socket/RPC validation) → expected hashrate (initial difficulty) → identity (username / solo address; `miningIdentity.ts` builds `sri/solo/<addr>` style identities) → review/start.

---

## 12. Licensing

| Component | License |
|---|---|
| `stratum` (protocol crates) | MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`) |
| `sv2-apps` (pool/JDC/translator/bitcoin-core-sv2) | MIT OR Apache-2.0 (`sv2-apps/README.md` §License) |
| `sv2-ui` | MIT OR Apache-2.0 (`sv2-ui/LICENSE.md`) |
| `sv2-tp` | MIT (GitHub license API) |

All permissive; bundling binaries or images in Heartwood (GPL-3.0 app with Tessera lineage) is compatible — permissive→GPL direction is fine. Attribution files should ship alongside bundled binaries.

---

## 13. Open questions & risks

1. **Umbrel Core IPC gap (highest).** All template-sourcing topologies need Core v30+ multiprocess with `-ipcbind=unix`. Unverified: Umbrel bitcoin app's Core version/build flavor, whether custom args can enable IPC, and whether its `node.sock` can be shared across app containers (socket permissions + cross-app volume mounts are restricted on Umbrel). Until resolved, only translator→external-pool works out of the box.
2. **Alpha-status roles.** sv2-apps self-declares alpha; monitoring API explicitly unstable (sv2-ui maintains a compatibility contract for churn). Pin exact tags (`v0.6.0`), never `main`.
3. **Port collisions.** SRI pool wants 3333 (Heartwood's V1 stratum) and embedded JDS wants 3334 (Heartwood's ASIC port). Both are configurable — but defaults in docs/wizards must be reconciled, and a migration story is needed if the V1 pool keeps 3333.
4. **Per-user payout model mismatch.** Heartwood's V1 solo pool does per-connection coinbase; SRI pool_sv2 pays one `coinbase_reward_script` per instance. Multi-user SOLO semantics need either per-user JDC/translator stacks, multiple pool instances (`server_id` exists for search-space separation), or keeping Heartwood's engine authoritative and treating SV2 as an additional front door.
5. **Authority key management.** Dev keypair is hardcoded in upstream templates/generators; Heartwood must generate and store per-instance Noise authority keys (no upstream keygen binary; `key-utils` crate has the primitives) and surface the pubkey to remote miners. Cert validation is clock-sensitive (NTP).
6. **Windows dev environment.** Core IPC is Linux/macOS only per sv2-ui; local dev/QA of the JD path on the Windows box will need WSL2/containers.
7. **Vardiff double-management.** Translator vardiff must be disabled when JDC manages difficulty (`enable_vardiff` comment in template) — easy misconfiguration.
8. **`aggregate_channels` semantics per pool.** sv2-ui hardcodes aggregated channels for Braiins specifically; per-pool behavioral quirks exist and the curated pool list (address + authority key + rules) is maintained by hand (`sv2-ui/shared/src/pools.ts`, `src/components/setup/poolRules.ts`).

---

## 14. Proposed beads

*(For orchestrator to file — titles + descriptions + suggested priority.)*

1. **Verify Umbrel Bitcoin app IPC capability (`-ipcbind=unix`)** — Determine Umbrel bitcoin app Core version/build (multiprocess?), whether advanced settings can pass `-ipcbind=unix`, and whether `node.sock` is reachable from another app's container. Gates every solo-SV2 topology. **P1 (scoping gate).**
2. **Decide SV2 integration topology for Heartwood** — Adjudicate: translator-only front door (external pools) vs sovereign-solo (translator+JDC) vs full pool_sv2 replacement vs SV2-alongside-Tessera-V1. Includes the per-user coinbase mismatch (risk 4). **P1 (architecture decision).**
3. **Port allocation plan for SV2 roles** — Reconcile SRI defaults (3333/3334/34255/34265/9090-9092) with Heartwood's existing 3333/3334; pick non-colliding defaults and document in MANUAL.md. **P2.**
4. **Noise authority keypair generation + storage** — Per-instance base58check secp256k1 authority keys (key-utils-compatible), stored via instance_secrets, pubkey surfaced in UI for remote miners; cert_validity + NTP-drift guidance. **P2.**
5. **Translator-first MVP: bundle `translator_sv2` behind Heartwood UI** — Ship pinned translator (binary or image), generate `tproxy-config.toml` from wizard input (upstream pool + authority key + identity), expose 34255, proxy `/api/v1/*` + `/metrics` from :9092 into Heartwood's dashboard. No node dependency; works on Umbrel today. **P2 (first buildable increment).**
6. **Curated SV2 pool directory** — Maintain pool list (name, address, port, authority pubkey, aggregate_channels rule, identity format) mirroring `sv2-ui/shared/src/pools.ts`; include Braiins entry. **P3.**
7. **Monitoring normalization layer** — Adopt sv2-ui's contract pattern: backend normalizes role monitoring responses before UI; fixture tests against pinned-version payloads (upstream API is declared unstable). **P3.**
8. **Native binary vs Docker delivery decision for Umbrel** — Evaluate shipping static musl binaries inside the Heartwood image (matches current in-process Tessera pool; avoids docker.sock privileges that sv2-ui requires) vs sidecar containers in the Umbrel compose. **P2.**
9. **Prototype sovereign-solo stack on regtest (spike)** — translator+JDC(SOLOMINING)+Core v31 `-ipcbind=unix` on the dev box (WSL2/container due to Windows IPC gap); verify Bitaxe-class SV1 flow end-to-end and block submission via IPC. **P2 (de-risking spike).**
10. **Track Bitaxe native SV2 firmware** — ESP-Miner PR #1553 adds native SV2; if it lands broadly, direct-to-pool_sv2 (3333) connections bypass the translator; keep both paths in scope docs. **P3.**
