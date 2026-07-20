# Stratum V2 on Umbrel — Packaging & UX Design (SCOPING)

> **Status: scoping doc, no implementation.** Written 2026-07-19 (Session 3: Umbrel Packaging & UX).
> Companion docs (written concurrently, cross-check before build): `docs/SV2-PROTOCOL-RESEARCH.md`,
> `docs/SV2-INTEGRATION-ARCHITECTURE.md`. Design doctrine honored throughout:
> `docs/DESIGN-MANIFESTO.md` (frozen evergreen identity) and `docs/UX-REDESIGN-SPEC.md`
> (7 principles; plain language, one primary action, `<Term>` for jargon).

## 0. Executive verdict

1. **sv2-ui's orchestration model cannot ship on Umbrel.** sv2-ui mounts the host
   `/var/run/docker.sock` and spawns Translator/JDC containers at runtime (dockerode in
   `server/src/docker.ts`). Umbrel App Store rules prohibit host-socket access outright
   (it is host-root). The pattern must be **inverted**: SRI roles become *static compose
   services* in `heartwood-bitcoin/docker-compose.yml`; Heartwood *generates config files*
   onto the shared `${APP_DATA_DIR}` volume instead of managing containers.
2. **Image strategy is a non-issue.** Docker Hub `stratumv2/` publishes `translator_sv2`,
   `jd_client_sv2`, and `pool_sv2` as multi-arch (amd64 + arm64) images with semver tags
   (`v0.1.0`…`v0.6.0`, checked 2026-07-19). No build burden; pin
   `stratumv2/translator_sv2:v0.6.0@sha256:<index-digest>` per Umbrel image rules. Never
   ship the moving `main` tag sv2-ui defaults to.
3. **Phase the modes by what Umbrel can actually feed with block templates.**
   - **Ship now — "Mine to a pool" (external V2 pool):** Translator Proxy only. V1 miners
     (every Bitaxe today) keep speaking Stratum V1 to a local port; the translator carries
     their work to the pool over encrypted SV2. Needs *no* node capability at all.
   - **Keep as-is — "Mine on your own" (solo):** the existing in-process V1 engine
     (`src/lib/server/mining/`, ports 3333/3334, Core RPC `getblocktemplate`). It works
     today and stays the solo path.
   - **Parked — V2-native solo (JDC SOLOMINING or hosted `pool_sv2`):** both need an SV2
     Template Provider — Bitcoin Core v30/31 with the IPC mining interface (`-ipcbind`
     unix socket; sv2-ui supports exactly Core 30/31, Linux/macOS sockets). Umbrel's
     `bitcoin` app (`ghcr.io/getumbrel/umbrel-bitcoin:v1.3.0`) exposes RPC/ZMQ but **no
     IPC socket**, and cross-app unix-socket mounts aren't a sanctioned Umbrel pattern.
     Revisit when the Umbrel bitcoin app enables multiprocess IPC.

This keeps the user story coherent: *solo stays solo (unchanged), and SV2 arrives first as
"point your miners at a real pool without touching their firmware."*

---

## 1. What sv2-ui actually does (read: what we adapt vs. reject)

Studied from a clone of `github.com/stratum-mining/sv2-ui` (Node/React + Express server).

| sv2-ui behavior | Verdict for Heartwood/Umbrel |
|---|---|
| Mounts host docker.sock, pulls `stratumv2/*:main`, creates/starts/stops Translator + JDC containers at runtime | **Reject.** Prohibited on Umbrel. Roles become static compose services. |
| Generates `translator-config.toml` / `jdc-config.toml` from wizard answers (`server/src/config-generator.ts`) into a config volume | **Adopt.** Heartwood renders the same TOML from its settings kv into `${APP_DATA_DIR}/data/sv2/`. |
| Wizard: mining-mode → template-mode → pool (or bitcoin-node) → hashrate → identity → review | **Adopt shape,** re-voiced in Heartwood plain language and rebuilt on the `wizardProgress.ts` sessionStorage pattern. |
| Hardcodes a *well-known* JDC authority keypair (secret key literally in source, `cert_validity_sec = 3600`) for the local JDC↔translator hop | **Reject for anything Heartwood hosts.** Fine upstream because that hop is localhost-only in their model; Heartwood generates real per-install keys (§3). |
| Monitoring: polls the translator's built-in HTTP monitoring server (`monitoring_address = 0.0.0.0:9092`, cache refresh 15 s); treats the response shape as an evolving integration contract (`docs/monitoring-api-compatibility.md`) | **Adopt.** Heartwood's server polls `http://<translator-container>:9092` over the app's Docker network and normalizes at the boundary — never let raw SRI shapes reach Svelte components. Pin the image version to the contract we tested. |
| Pool directory with known pools + authority pubkeys (Braiins etc., `shared/src/pools.ts`) | **Adopt.** Ship a small built-in directory so most users never see a raw authority key. |
| Config knobs: `min_hashrate` (default 100 TH/s), `shares_per_minute` (vardiff target), `aggregate_channels`, `downstream_extranonce2_size`, fallback pools, solo `verify_payout` | **Adopt selectively.** Expose hashrate + pool choice in the wizard; the rest defaults, under Advanced. `verify_payout`-style honesty is a keeper. |

---

## 2. Umbrel packaging plan

### 2.1 How multi-container apps work on Umbrel (rules recap)

- One app = one `docker-compose.yml` with multiple services. **No Docker-in-Docker, no
  docker.sock, no runtime container management.** Umbrel patches the file (injects
  container names `<app-id>_<service>_1`, joins all services to `umbrel_main_network`).
- `app_proxy` fronts **only the web UI** (manifest `port: 3217` → `APP_PORT: 3000` on
  `heartwood-bitcoin_web_1`). Raw TCP protocol ports (stratum) are published directly
  with explicit `ports:` mappings — they bypass app_proxy entirely (already the pattern
  for HW-signing HTTPS `5588:3443`).
- Persistent state lives under `${APP_DATA_DIR}/data/...` bind mounts; containers are
  recreated on every restart/update. Heartwood already mounts `${APP_DATA_DIR}/data:/data`.
- All images pinned `repo:tag@sha256:<multi-arch index digest>`, amd64 + arm64.
- Cross-service traffic uses Docker DNS (injected container names) on the shared network —
  which is **untrusted** (every other Umbrel app sits on it); anything listening needs auth
  or must tolerate exposure (§2.4, §3).

### 2.2 Proposed compose topology (target state, "Mine to a pool" phase)

```yaml
services:
  app_proxy:
    environment:
      APP_HOST: heartwood-bitcoin_web_1
      APP_PORT: 3000

  web:                            # existing Heartwood container — unchanged role, new duties:
    image: ghcr.io/alexm223/cairn:<ver>@sha256:…
    ports:
      - "5588:3443"               # HW signing HTTPS (existing)
      - "3333:3333"               # V1 solo engine, small miners (in pending store PR)
      - "3334:3334"               # V1 solo engine, ASIC port (in pending store PR)
    volumes:
      - ${APP_DATA_DIR}/data:/data
    # new duties: render /data/sv2/translator.toml, poll translator monitoring,
    # own all keys/secrets (instance.key seam)

  sv2-translator:                 # NEW — SRI Translator Proxy (V1 miners -> V2 pool)
    image: stratumv2/translator_sv2:v0.6.0@sha256:<index-digest>
    restart: on-failure
    ports:
      - "3335:3335"               # V1 downstream listener ("bridge port", §2.3)
    volumes:
      - ${APP_DATA_DIR}/data/sv2:/config:ro
    # monitoring_address 0.0.0.0:9092 stays UNPUBLISHED — internal Docker network only,
    # polled by web. NOTE 9092-on-shared-network exposure, §2.4.
    command: <config-gate wrapper — see §2.5>
```

Committed scaffolding: `heartwood-bitcoin/data/sv2/.gitkeep` (Umbrel strips `.gitkeep`,
container sees an empty dir until Heartwood renders config). Future phases add
`sv2-jdc` / `sv2-pool` services the same way — same volume, own TOML files — *only* once a
template source exists on Umbrel (§0.3).

### 2.3 Ports

| Host port | Service | Purpose | Notes |
|---|---|---|---|
| 3217 | app_proxy | Web UI | existing manifest `port` |
| 5588 | web | HW-signing HTTPS | existing |
| 3333 | web | Stratum V1, solo engine (floor 0.5) | in pending store PR (store still lags at 0.2.41 without them — same PR should land these) |
| 3334 | web | Stratum V1, solo ASIC port (floor 65536) | in pending store PR |
| **3335** | sv2-translator | Stratum V1 in → SV2 out ("bridge port") | **new**; distinct because compose port publishing is static — both the solo engine and the translator exist in the compose file regardless of mode, so they can never share a host port. UI shows only the active mode's address (§5). |
| (9092) | sv2-translator | monitoring HTTP | **not** host-published; internal only |

Collision caution: other mining apps in the Umbrel ecosystem (e.g. public-pool) also camp
on 3333/3334-adjacent ports. Community stores get no cross-store linting; the connect
screen must always print the port rather than assume defaults.

### 2.4 Cross-container trust

- `/config` is mounted **read-only** into SRI containers; only `web` writes it.
- The translator's downstream stratum (3335) is intentionally public (LAN miners). Its
  monitoring port 9092 is unauthenticated HTTP reachable by *other Umbrel apps* on
  `umbrel_main_network`. Exposure is read-only stats (hashrate/shares) — acceptable, but
  document it; if SRI grows a monitoring auth token, wire it through the config.
- Nothing SRI-side ever sees Heartwood's DB, session secrets, or `instance.key`.

### 2.5 Config lifecycle without docker.sock (the one genuinely awkward bit)

Heartwood cannot start/stop/restart sibling containers. Two consequences:

1. **Cold start before configuration:** the translator container boots with an empty
   `/config`. A bare SRI binary would crash-loop. Mitigation: a config-gate `command`
   wrapper — `until [ -f /config/translator.toml ]; do sleep 5; done; exec …` — plus a
   watch loop that kills/re-execs the child when the file's mtime changes, giving us
   apply-on-save with ~seconds latency and no privileged anything.
   **Open question (verify before build):** whether `stratumv2/translator_sv2` images
   contain a shell. If distroless, we need a 5-line wrapper image (small but real build
   burden, multi-arch, re-introduces CI) **or** an `sv2-supervisor` sidecar image we own
   that shares the config volume and runs the binary from the SRI image via
   `command`-override — decide at implementation.
2. **Apply semantics in the UI:** "Save" = render TOML + wait for the wrapper to bounce
   the role (observable via monitoring poll). Copy must promise what we deliver:
   *"Saved. Your bridge restarts itself — miners reconnect automatically within a
   minute."* (Miners retry stratum connections forever; a bounce is invisible beyond a
   brief gap.) Never tell an Umbrel user to run a command — that violates both Umbrel
   gates and the Heartwood UX philosophy.

### 2.6 Manifest deltas

- `umbrel-app.yml`: version bump, releaseNotes, description gains one plain paragraph on
  pool mining ("connect your miners to a mining pool of your choice over an encrypted,
  modern protocol — no firmware changes needed"). No new `dependencies:` (chain backend
  stays user-configured in-app; translator mode needs no node at all).
- No new `permissions:`, no hooks expected (config dir ships as committed scaffolding;
  existing installs get it created by `web` on first render — verify update-path since
  update copies only whitelisted files; a `pre-start` hook `mkdir -p` is the fallback).
- `backupIgnore`: do **not** ignore `data/sv2/` (tiny, and keys/config are identity).

---

## 3. Noise-protocol key management

### 3.1 What actually needs keys, per mode

- **"Mine to a pool" (ships first): no Heartwood-held secrets at all.** The Noise
  handshake authenticates the *pool* to the translator. The only material is the pool's
  **authority public key** — public data, pasted or picked from the built-in directory.
  The translator holds no long-term secret. This is a genuinely pleasant property: phase 1
  ships with zero new key custody.
- **Future hosted roles (JDC / `pool_sv2`):** Heartwood must hold an authority keypair
  (secp256k1, SRI base58 encoding) whose secret lands in the role's TOML
  (`authority_secret_key`, `cert_validity_sec`). sv2-ui ducks this with a publicly-known
  keypair — acceptable for their localhost-only hop, unacceptable for anything reachable
  on the Umbrel network or LAN.

### 3.2 Design (extends the existing `secretKey.ts` seam)

- **Generation:** on first enable of a hosted role, generate the keypair in `web`
  (Node `secp256k1`; encode in SRI's expected base58 format).
- **Storage:** secret key encrypted at rest with `encryptSecret()` and stored in the
  `settings` kv — same envelope style as SMTP passwords. Prerequisite refactor:
  `secretKey.ts` hardcodes one HKDF domain label (`cairn:notification-smtp-pass`);
  generalize to per-domain labels (`cairn:sv2-authority-key`) so domains stay
  cryptographically separated. The instance key file (`instance.key`, 0600, colocated
  with the DB on the `/data` volume — deliberately outside the DB so a leaked `cairn.db`
  can't self-decrypt) is unchanged.
- **Injection into SRI containers:** decrypt-on-render — the plaintext secret exists only
  inside the rendered TOML at `${APP_DATA_DIR}/data/sv2/<role>.toml`, mode 0600, on the
  same volume that already holds `instance.key` (same trust domain; no regression).
  No env-var injection (compose env is static; Umbrel `derive_entropy` values are hex,
  not SRI-format keys, and exports.sh shouldn't mint protocol keys).
- **Rotation:** admin-triggered "get a new identity key" (§4.3). New keypair → re-render
  TOML → wrapper bounces role → anything pinned to the old pubkey fails its next
  handshake. Warning copy is mandatory (§4.3). No automatic rotation; `cert_validity_sec`
  (default 3600) already gives session-level freshness.
- **Backup/restore:** encrypted secret rides in the DB, `instance.key` rides on the
  volume — both inside Umbrel backups, so a restore preserves the pool identity miners
  have pinned. Regeneration is always available, merely disruptive.
- **What the miner pastes:** nothing secret, ever. V1 miners paste `host:3335` only.
  A V2-firmware miner pointing at an external pool pastes that pool's *public* authority
  key (from the pool's own docs or Heartwood's directory).

---

## 4. Admin UX (screen-by-screen)

Doctrine constraints applied: evergreen-ink surfaces, hairlines not boxes, slate-blue on
the single primary action only, green strictly = growth/health, gold = attention (never
red for expected states), Fraunces only for hero numerals, sats-first, `<Term>` tooltips
for unavoidable jargon, one primary action per screen.

### 4.1 `/admin/mining` — new "Where the work goes" section

Sits above the existing engine sections in `AdminPoolSettingsForm.svelte`'s page, using the
same form/label/hint grammar. A two-option choice (radio-card row, hairline-separated —
not a dropdown; two options with consequences deserve visible copy):

> **Where should your miners' work go?**
> ◉ **Mine on your own** — Your machines hunt for a whole block. You keep everything a
> block pays, but blocks are rare. *(Runs against your own node — this is what you have
> today.)*
> ○ **Mine with a pool** — Your machines join a bigger group and earn small, steady
> payouts from the pool. Heartwood carries their work to the pool over a modern encrypted
> connection *(<Term tip="Stratum V2, the successor to the protocol most miners speak.">Stratum V2</Term>)*
> — your miners don't need new firmware.

- Selecting **pool** with nothing configured routes into the wizard (§4.2). Once
  configured, this section shows the summary card: pool name, account, port 3335 status
  dot (sage green when the translator's upstream is connected, gold "attention" when
  configured-but-unreachable, muted when off) and an **Edit** ghost button.
- Mode is instance-wide and exclusive: enabling pool mode stops advertising the solo
  ports on `/mining` and vice versa (both listeners may physically exist; the UI shows
  one truth). A hairline hint under the selector says which ports are live.
- **Honesty rule (must ship with pool mode):** in pool mode, payouts go to the *pool
  account* configured here — Heartwood's per-user attribution (`hw_` mining IDs, payout
  wallets) applies to solo mode only. The section states this plainly:
  *"In pool mode, everyone's machines mine into this one pool account. The pool pays
  that account directly — Heartwood shows who contributed, but the pool does the paying."*

### 4.2 Pool setup wizard (new, `/admin/mining/pool-setup`)

Adapted from sv2-ui's flow, collapsed to three steps (Heartwood wizard doctrine: Key ·
Verify · Finish precedent), snapshotted via a new `wizardProgress.ts` sibling
(`cairn.pool-setup-wizard.v1`, sessionStorage, 60-min staleness — survives app_proxy's
mid-wizard reload, the exact failure the pattern was built for):

1. **Choose a pool.** Directory cards (name, fees line, region) sourced from a built-in
   list (adapt sv2-ui's `shared/src/pools.ts`), plus "Somewhere else…" revealing
   host / port / **pool identity key** / account fields.
   - Identity-key copy: *"**Pool identity key.** Every pool has a public identity key —
     like a fingerprint. Heartwood checks it on every connection so your miners are
     talking to the real pool, not an impostor. Paste it from the pool's setup page."*
   - Account field: *"**Your pool account.** Usually your payout address or the username
     from the pool's website. The pool pays this account."*
2. **How much mining power?** Single question ("Roughly how fast are your machines,
   all together?") with friendly presets — "One small miner (~1 TH/s)" / "A few small
   miners" / "One big machine (~100 TH/s)" / "Several big machines" / exact-number
   Advanced input. Maps to `min_hashrate` + difficulty so first shares arrive fast
   without flooding (mirrors sv2-ui's HashrateStep; our vardiff copy already explains
   the same idea in solo settings).
3. **Review & turn on.** Plain summary (pool, account, "your miners will point at
   `<host>:3335`"), one slate-blue primary **Turn on pool mining**. On submit: render
   TOML → wrapper starts translator → live status swaps to "Connected to <pool>" via
   monitoring poll. Failure states use gold attention copy ("We couldn't reach the pool —
   check the address, or the pool may be down"), never red (nothing broke destructively).

Advanced (collapsed, principle 1): fallback pool, shares-per-minute target, channel
aggregation, extranonce size. Defaults are sv2-ui's defaults.

### 4.3 Key management surface (ships only with hosted roles — later phase)

A "Pool identity" row in the admin mining page: pubkey shown truncated-mono with
CopyText, plus a **Get a new identity key** ghost button behind the standard two-step
reveal (the `MiningConnectionCard` regenerate-ID affordance pattern). Warning copy:

> *"Your pool has an identity key that connected miners trust. If you replace it, every
> V2 miner pointed at this pool must be given the new key before it can connect again —
> V1 miners on the bridge are unaffected. This does not touch any wallet or funds."*

Confirm button is **not** red (nothing is destroyed; funds untouched) — it's a normal
action after an attention-gold explainer.

### 4.4 Monitoring surfacing

No new pages (nav is frozen at 3 top-level destinations). Pool-mode data flows into the
existing surfaces via the boundary-normalized monitoring poll (§1):

- `/admin/mining`: `AdminPoolHero` gains an upstream line ("Connected to Braiins ·
  12 min"); `AdminEngineHealth` gains a "bridge" health row (translator up / upstream
  connected / last share forwarded). Reuse the liveHub SSE plumbing — poll SRI HTTP
  server-side (15 s cache, matching `monitoring_cache_refresh_secs`), push deltas to
  clients; no client ever talks to 9092.
- `/mining` (member view): same hero/workers/best-share components; "Earnings" is
  suppressed in pool mode in favor of "Sent to pool" share counts + the honesty line
  from §4.1 (odds panel and block celebration are solo-mode concepts; best-share
  celebration stays — a personal best is a personal best on any upstream).

---

## 5. Miner connection experience

`MiningConnectionCard` already derives `stratum+tcp://<host>:<port>` addresses with
CopyText and switches copy by enabled listeners. It grows a mode dimension:

### Solo mode (today's behavior — unchanged)

- Bitaxe/small (V1): `stratum+tcp://<host>:3333`, username `hw_xxxxxxxx[.workername]`,
  password `x`.
- Big ASICs (V1): same but `:3334` ("Higher starting difficulty, so a fast machine
  doesn't flood shares" — existing hint).
- V2-firmware miners: not supported solo (no local V2 endpoint yet — parked, §0.3). No
  UI lies: nothing advertises a V2 solo endpoint.

### Pool mode ("Mine with a pool")

Two plain tabs/rows on the connect card:

- **"Miner with standard firmware (most miners — Bitaxe, older ASICs)"**
  → `stratum+tcp://<host>:3335`, worker name = anything you like ("use a name you'll
  recognize, like `garage-bitaxe`"), password `x`.
  Copy: *"Point your miner here. Heartwood translates its work to the pool's modern
  protocol and encrypts the connection — the miner itself doesn't change."*
  (Per-connection `hw_` IDs are not required by the translator; worker names pass
  through to per-worker stats. Whether we *require* `hw_`-style names to map workers to
  Heartwood users for the contribution view is an open question — see §7.)
- **"Miner with Stratum V2 firmware (newest machines)"**
  → connect **directly to the pool** — show the pool's own endpoint + authority key from
  the wizard config, with copy: *"Your miner already speaks the pool's language — it
  connects straight to the pool, no bridge needed. Heartwood won't see this machine's
  shares; check its stats on the pool's site."* (Honesty over funnel: never proxy for
  the sake of dashboards.)

### First-share feedback

Keep the existing celebration mechanics: worker appears in `MiningWorkersList` on first
share (name + green "alive" state), `MiningBestShare` personal-best card and its
celebration fire identically in pool mode (share difficulty is upstream-independent). Add
one pool-mode-only moment: the first share *accepted by the pool* (visible in translator
monitoring) flips the hero status line to sage-green "Mining with <pool>" — growth-green
because it is genuinely a health/growth state, per doctrine.

---

## 6. Dev/QA notes

- Local dev (Windows, no Umbrel): compose file in-repo for the SRI translator against a
  public testnet4 V2 pool endpoint, or SRI's own test rigs; monitoring poller gets a
  fixture mode so `/admin/mining` renders pool-mode UI without containers (route-crawl QA
  must pass with SRI absent — degrade to gold "bridge not reachable", never crash).
- Visual QA per standing rule: built-in browser screenshots incl. 375x812 for the wizard,
  connect card (both modes), and admin section.
- Store-repo QA: `npm run lint:apps -- heartwood-bitcoin --check-images` + umbrel-test-app
  flow (fresh install, configure pool mode, restart, verify config + keys survive).

## 7. Risks & open questions

1. **SRI image entrypoint/shell unknown** — the config-gate wrapper (§2.5) assumes a
   shell in the image. If distroless: thin wrapper image or supervisor sidecar; small but
   it resurrects multi-arch build/CI burden. *Verify first, before any compose work.*
2. **No hot-reload contract in SRI roles** — restart-on-config-change is our wrapper's
   job; confirm translator handles SIGTERM cleanly and reconnecting V1 miners resume
   without manual intervention (they should; stratum clients retry forever).
3. **Monitoring API churn** — sv2-ui explicitly documents the SRI monitoring API as
   evolving. Mitigation: pin image digest; normalize at server boundary; fixture tests
   with captured payloads (their own approach).
4. **Multi-user attribution in pool mode** — one pool account per instance; per-user
   payout attribution (solo model) doesn't map. Options: worker-name convention
   (`hw_xxxx.worker`) parsed from monitoring stats for a contribution-only view, or
   declare pool mode "household mode" v1 and skip per-user accounting. Needs an Alex
   decision before the §4.1 honesty copy is finalized.
5. **Template provider gap on Umbrel** — V2 solo (JDC SOLOMINING) and hosted `pool_sv2`
   both blocked on Core v30/31 IPC absent from `umbrel-bitcoin`. Watch upstream; when it
   lands, phase 2 slots in as new compose services + a wizard branch, no re-architecture.
6. **Host-port collisions** — 3333/3334/3335 vs other community mining apps
   (public-pool et al.); no cross-store linting exists. UI always prints the port; docs
   note the collision possibility.
7. **Store lag** — published store compose (0.2.41) doesn't yet expose 3333/3334; the
   pending store PR (kgj7a) must land before any SV2 packaging stacks on top.
8. **Testnet4-only V2 pools for QA** — public V2 pool endpoints for regtest don't exist;
   e2e QA likely needs SRI's `pool_sv2` run locally on regtest as the "external pool"
   (dev-only compose, not shipped).

## 8. Proposed beads (for the orchestrator to file — none filed here)

| # | Title | Description | Priority |
|---|---|---|---|
| 1 | Verify SRI image internals (shell, entrypoint, SIGTERM, monitoring paths) | Pull `stratumv2/translator_sv2:v0.6.0`, inspect for shell/base, confirm config path + monitoring endpoints; decides wrapper-vs-sidecar (§2.5). Gate for all packaging beads. | P1 |
| 2 | Generalize `secretKey.ts` to per-domain HKDF labels | Refactor hardcoded `cairn:notification-smtp-pass` into a domain-label parameter with back-compat; prerequisite for any new encrypted secret class (§3.2). | P2 |
| 3 | SV2 config renderer (`/data/sv2/*.toml`) | Server module rendering translator TOML from settings kv (pool, account, hashrate, advanced knobs), 0600, atomic write + mtime bump; port sv2-ui's `config-generator.ts` semantics. | P1 |
| 4 | Translator compose service + config-gate wrapper in store repo | Add `sv2-translator` service (pinned digest, `/config:ro`, port 3335) with wait-for-config/watch-restart command; scaffold `data/sv2/`; lint + umbrel-test-app pass. Depends on #1, #3, store PR kgj7a. | P1 |
| 5 | Monitoring boundary client + liveHub integration | Server-side poller for translator monitoring (15 s, normalized types, fixture mode when absent), pushed over existing SSE; degrade gold-not-crash. | P2 |
| 6 | "Where the work goes" mode section on `/admin/mining` | Radio-card mode selector, summary card, exclusive-mode port advertising, honesty copy (§4.1). | P2 |
| 7 | Pool setup wizard (3 steps + sessionStorage progress) | `/admin/mining/pool-setup` per §4.2, incl. built-in pool directory and custom-pool fields with identity-key copy; new `wizardProgress` sibling. | P2 |
| 8 | Pool-mode connect card + first-pool-share moment | `MiningConnectionCard` mode dimension (V1 bridge row, V2 direct-to-pool row), `/mining` pool-mode suppressions (earnings/odds), sage "Mining with <pool>" flip (§5). | P2 |
| 9 | Decision: per-user contribution model in pool mode | Frame worker-name-convention vs household-mode options for Alex (risk #4); blocks final §4.1 copy. | P2 |
| 10 | Authority keypair custody for hosted roles | secp256k1 keygen in SRI base58 format, encrypted-at-rest storage, decrypt-on-render into role TOML, regenerate flow + warning copy (§3.2, §4.3). Parked until a hosted role ships. | P3 |
| 11 | Regtest SV2 QA rig | Dev-only compose: `pool_sv2` + template source on regtest as fake "external pool" for e2e translator QA (risk #8). | P3 |
| 12 | Watch: Umbrel bitcoin app IPC template provider | Track `umbrel-bitcoin` for Core v30/31 multiprocess `-ipcbind`; when available, scope phase-2 V2 solo (JDC SOLOMINING service + wizard branch). | P3 |
