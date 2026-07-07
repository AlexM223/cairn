# Start9 (StartOS) Packaging — Scoping Plan

Status: **scoping only, nothing built.** This is the Start9 analog of
`docs/PUBLISH-PLAN.md` (Umbrel, executed 2026-07-06). Read that doc first —
this one assumes the public repo (`github.com/AlexM223/cairn`), the
multi-arch `ghcr.io/alexm223/cairn` image, and the env-var contract it
established already exist and are reused here, not redone.

**The single most important fact in this doc**: StartOS packaging went
through a complete, incompatible rewrite. There are two generations of
documentation and they describe two different systems. Anything found by
casual search that isn't explicitly labeled with a version could be either
one. This plan targets **StartOS 0.4.0.x** (current, in beta as of
2026-07 — confirmed via `github.com/Start9Labs/start-os/releases` and the
dedicated `docs.start9.com/packaging/0.4.0.x/` doc book), not the legacy
`0.3.5.x`/embassyOS-era system. The two are cross-incompatible: a 0.3.5.x
package cannot run on 0.4.0, and a 0.3.5.x backup cannot restore onto 0.4.0.

| | Legacy (StartOS ≤0.3.5.x / embassyOS) | Current (StartOS 0.4.0.x) |
|---|---|---|
| Manifest | `manifest.yaml`, kebab-case fields | `startos/manifest/index.ts`, TypeScript, `setupManifest()` |
| Container orchestration | `Dockerfile` + `docker_entrypoint.sh`, one Dockerfile per project | `startos/main.ts`, `sdk.Daemons.of(effects).addDaemon()` — no Dockerfile needed if using a pre-built image tag |
| Config | `config_rules`/`getConfig`/`setConfig`, rendered as a JSON-schema-like form | Gone. Replaced by `startos/actions/` (arbitrary forms, re-triggerable) |
| Properties (generated passwords/URLs) | dedicated `properties.yaml` | Gone. Folded into Action results |
| Dependencies | `config.rules` cross-service validation, could block install | `startos/dependencies.ts` — UI warning only, does not block startup |
| Package format | `.s9pk`, tar-based | `.s9pk`, BLAKE3-hashed + Ed25519-signed, supports partial-download verification |
| Networking addressing | one `.local` address **per service** | one `.local` address per **server**, services on distinct ports |
| CLI | `start-sdk pack` / `start-sdk verify` | `start-cli` (host tool) + `@start9labs/start-sdk` (npm, imported in-project) + `make` (wraps SDK's `s9pk.mk`) |

Sources: [Update to StartOS 0.4.0](https://docs.start9.com/start-os/0.4.0.x/update-040.html),
[Packaging Guide (0.4.0.x)](https://docs.start9.com/packaging/0.4.0.x/quick-start.html),
[Manifest (0.4.0.x)](https://docs.start9.com/packaging/0.4.0.x/manifest.html),
[Service Packaging (0.3.5.x, legacy)](https://docs.start9.com/0.3.5.x/developer-docs/packaging.html).

---

## 1. Package file structure (current, 0.4.0.x)

Confirmed directly against `Start9Labs/hello-world-startos` (the official
template repo) and three real Bitcoin-app wrapper repos (`mempool-startos`,
`btcpayserver-startos`, `ride-the-lightning-startos`), which all share one
generated scaffold:

```text
cairn-startos/
├── .github/workflows/
├── assets/
│   └── ABOUT.md              # required — build fails with zero assets
├── startos/
│   ├── actions/               # index.ts + one file per user-triggered action
│   ├── fileModels/            # typed config-file read/write models (unused if no config file)
│   ├── i18n/
│   │   ├── index.ts
│   │   └── dictionaries/
│   ├── init/                  # one-time setup hooks (init.ts / initializeService.ts)
│   ├── manifest/
│   │   ├── index.ts           # setupManifest() call — id, images, volumes, dependencies
│   │   └── i18n.ts
│   ├── versions/               # version graph (no-op for v1: one version, no migrations)
│   ├── backups.ts              # setupBackups() — which volumes to back up
│   ├── dependencies.ts         # setupDependencies() — empty for v1, see §6
│   ├── index.ts                # "Plumbing. DO NOT EDIT." — wires the above together
│   ├── interfaces.ts           # setupInterfaces() — the web UI port/host
│   ├── main.ts                 # setupMain() — the one daemon (Cairn's node process) + health check
│   ├── sdk.ts                  # `export const sdk = utils.createSdk(manifest)`
│   └── utils.ts                # constants: port, mount paths
├── icon.svg
├── instructions.md              # user-facing help text, shown in StartOS UI
├── LICENSE
├── Makefile                     # thin — `include node_modules/@start9labs/start-sdk/s9pk.mk`
├── package.json / package-lock.json
├── README.md
├── tsconfig.json
└── AGENTS.md / CLAUDE.md        # present in every real repo checked — see §8
```

Notably **no Dockerfile is required** if the package references a pre-built
image tag (this is what `mempool-startos` does — `manifest/index.ts`
declares `images.cairn.source = { dockerTag: 'ghcr.io/alexm223/cairn:0.1.3' }`
and StartOS re-packages that tag directly). Since the Umbrel work already
produces exactly this image, **the entire Docker build/publish pipeline is
reusable as-is** — Start9 packaging adds a wrapper repo around the existing
image, it does not need its own Dockerfile or CI build.

No `docker-compose.yml` equivalent exists — Cairn is a single-container app
(embedded SQLite, no sidecar DB), so this is a non-issue; `main.ts` declares
exactly one daemon.

Sources: [Project Structure](https://docs.start9.com/packaging/0.4.0.x/project-structure.html),
[Manifest reference](https://docs.start9.com/packaging/0.4.0.x/manifest.html),
[Start9Labs/hello-world-startos](https://github.com/Start9Labs/hello-world-startos),
[Start9Labs/mempool-startos](https://github.com/Start9Labs/mempool-startos).

### Draft `startos/manifest/index.ts`

```typescript
import { setupManifest } from '@start9labs/start-sdk'
import { long, short } from './i18n'

export const manifest = setupManifest({
  id: 'cairn',
  title: 'Cairn',
  license: 'MIT',
  packageRepo: 'https://github.com/AlexM223/cairn-startos',
  upstreamRepo: 'https://github.com/AlexM223/cairn',
  marketingUrl: 'https://github.com/AlexM223/cairn',
  donationUrl: null,
  description: { short, long },
  volumes: ['main'],
  images: {
    cairn: {
      source: { dockerTag: 'ghcr.io/alexm223/cairn:0.1.3' },
      arch: ['x86_64', 'aarch64'],
    },
  },
  alerts: { install: null, update: null, uninstall: null, restore: null, start: null, stop: null },
  dependencies: {},
})
```

`arch: ['x86_64', 'aarch64']` (no `riscv64`) matches what Umbrel packaging
already requires and tests — the existing multi-arch CI job covers this
without change.

---

## 2. Lifecycle: `main.ts`, health checks, actions

`setupMain()` declares the one running daemon and its readiness check.
StartOS provides built-in health-check helpers (`checkPortListening`,
`checkWebUrl`, `runHealthScript`) — `checkWebUrl` maps directly onto
Cairn's existing `/api/health` endpoint
([src/routes/api/health/+server.ts](../src/routes/api/health/+server.ts)),
so **no new health-check code is needed**, just a pointer to the existing
route:

```typescript
export const main = sdk.setupMain(async ({ effects }) => {
  return sdk.Daemons.of(effects)
    .addDaemon('cairn', {
      subcontainer: sdk.SubContainer.of(effects, sdk.Volumes.of({ main: '/data' })),
      exec: { command: ['node', 'build'], env: { PORT: '3000', CAIRN_DB: '/data/cairn.db' } },
      ready: {
        display: 'Web interface',
        fn: () => sdk.healthCheck.checkWebUrl(effects, 'http://localhost:3000/api/health'),
      },
    })
    .build()
})
```

**Actions** replace both the old "config" step and "properties" display.
Cairn has one clear use for this: an admin-password-reset action,
mirroring the pattern already used by `ride-the-lightning-startos`
(`startos/actions/resetPassword.ts` — generates a random password, writes
it, displays it once as masked+copyable) and `btcpayserver-startos`
(`startos/actions/resetAdminPassword.ts`). Cairn already has the server-side
primitive this would call: `bootstrapAdminFromEnv()`
([auth.ts:237](../src/lib/server/auth.ts:237)), the same one the
[Umbrel solo-mode/auto-admin plan](SOLO-MODE-UMBREL-AUTOADMIN-PLAN.md)
builds on. A `Reset Admin Password` action wrapping that function is the
single biggest reusable piece of this section.

Sources: [main.ts reference](https://docs.start9.com/packaging/0.4.0.x/main.html),
[Actions reference](https://docs.start9.com/packaging/0.4.0.x/actions.html),
[ride-the-lightning-startos](https://github.com/Start9Labs/ride-the-lightning-startos),
[btcpayserver-startos](https://github.com/Start9Labs/btcpayserver-startos).

---

## 3. Auth — no platform SSO; keep Cairn's own login (same conclusion as Umbrel, for a different reason)

**StartOS has no Umbrel-style `APP_PASSWORD`/reverse-proxy password wall
that a package gets "for free."** Every service is expected to implement
its own login. Confirmed via `filebrowser-startos`'s `instructions.md`
(users run a "Set Admin Password" action, then log into File Browser's own
login screen) and the Sparrow-in-a-webtop package, which relies on plain
HTTP Basic Auth at the container layer instead of an app login.

The one platform primitive that comes close is **edge Basic/Bearer auth**:
a package can set `addSsl.auth` on its bound HTTP port so StartOS's own
reverse proxy prompts for a browser-native Basic Auth credential *before*
the request reaches the container — package-configured, not a shared
platform session. This is optional and not a substitute for Cairn's real
login (a native browser credential prompt is a worse UX than Cairn's
existing login form, and doesn't compose with WebAuthn/passkeys at all).
**Recommendation: don't use it** — same outcome as Umbrel, keep Cairn's own
email+password login as the only auth layer.

**This is the one place Start9 might structurally beat Umbrel**, and it's
worth flagging prominently: StartOS issues each server its own root CA
(the "Start9 CA"), which the user downloads once and trusts on their client
device/browser, after which **LAN access to every service — not just the
StartOS dashboard — is genuine HTTPS**, not the plain
`http://<device>.local` that Umbrel's `app_proxy` serves by default.
Umbrel's plain-HTTP LAN origin is the root cause of bead **cairn-4b2b**
(WebUSB/WebHID/WebAuthn/hardware-signing all require a browser "secure
context," which plain HTTP is not) — if Start9's LAN HTTPS genuinely
produces `window.isSecureContext === true` for a trusted-CA `.local`
origin, in-browser hardware-wallet signing (Trezor Connect, Ledger/BitBox02
WebHID, Jade WebSerial) could work out of the box on Start9 where it
currently cannot on stock Umbrel. **Flagged, not confirmed** — I found this
via `docs.start9.com`'s CA-trust guides and networking docs, not by
verifying `isSecureContext` in an actual StartOS browser session. Verify
this directly against a real StartOS test instance (see §9) before
advertising it — it's the kind of claim that needs a green checkmark from
`window.isSecureContext` in the devtools console, not an inference from
docs.

Sources: [Trusting Your Root CA](https://docs.start9.com/start-os/0.4.0.x/trust-ca.html),
[Interfaces reference (`addSsl.auth`)](https://docs.start9.com/packaging/0.4.0.x/interfaces.html),
[filebrowser-startos instructions.md](https://github.com/Start9Labs/filebrowser-startos/blob/master/instructions.md),
[cairn-v013-hw-emu-qa memory](../.beads/issues.jsonl) (bead cairn-4b2b).

---

## 4. Config UI — Actions replace the old Config spec

There is no more "fill out a form at install time" step. The 0.4.0 docs
state this directly: *"The SDK provides no dedicated initial setup wizard.
Instead, the watcher/action pattern surfaces setup tasks through the action
system."* For Cairn, this composes cleanly with what's already planned for
Umbrel: `sdk.setupOnInit()` can register a **critical task** (blocks
service start until resolved) pointing at a hidden action, which is exactly
the shape of the not-yet-built "first-login forced password reset" from
[SOLO-MODE-UMBREL-AUTOADMIN-PLAN.md](SOLO-MODE-UMBREL-AUTOADMIN-PLAN.md)
Part 1 step 3 — if that gets built for Umbrel, the same
`must_reset_password` flag and forced-reset route are directly reusable
here, just triggered by a StartOS critical task instead of an Umbrel
install-card flow.

For v1, simplest option: **no init-time action at all** — Cairn already
boots to a self-serve email+password signup page with zero required
config, satisfying whatever "must come up before user configures anything"
gate StartOS's own submission testing checks for (see §7).

Sources: [Actions reference](https://docs.start9.com/packaging/0.4.0.x/actions.html),
[Recipe: Require Setup Before Starting](https://docs.start9.com/packaging/0.4.0.x/recipe-require-setup.html).

---

## 5. Backup/restore

`startos/backups.ts` in the current SDK is a thin declarative-or-imperative
wrapper: `sdk.setupBackups(['main'])` for the simple case, or an async
factory returning a `Backups` builder (`.ofVolumes()`, `.setPreBackup()`,
etc.) for anything needing pre/post hooks (e.g. a `pg_dump` for a Postgres
sidecar — not applicable to Cairn's embedded SQLite). For Cairn:

```typescript
import { sdk } from './sdk'

export const { createBackup, restoreInit } = sdk.setupBackups(
  async ({ effects }) => sdk.Backups.ofVolumes('main'),
)
```

This backs up the entire `main` volume — i.e. everything under `/data`:
`cairn.db*`, `instance.key`, `logs/*`. Same guidance as the Umbrel plan
([PUBLISH-PLAN.md §7.5](PUBLISH-PLAN.md)) applies: logs are regenerable
and could be excluded if the SDK exposes a path-exclusion option (not
confirmed for the current SDK — the legacy `.backupignore` mechanism from
0.3.5.x may or may not have a 0.4.0 equivalent), but `cairn.db*` and
especially `instance.key` must never be excluded — losing `instance.key`
makes DB-encrypted secrets (SMTP creds, session tokens) permanently
unrecoverable.

One hard platform constraint to flag: **restore only works into a fresh
install**, not an already-running instance — a long-standing StartOS
limitation, still an open feature request as of this research
([start-os#2172](https://github.com/Start9Labs/start-os/issues/2172)).
Also: **0.3.5.x and 0.4.0 backups are mutually incompatible** — irrelevant
for a new 0.4.0-targeted package, but worth knowing if testing against an
older StartOS device.

Sources: `Start9Labs/start-os` `projects/start-sdk/lib/backup/{Backups.ts,setupBackups.ts}`,
[bitcoin-core-startos/startos/backups.ts](https://github.com/Start9Labs/bitcoin-core-startos),
[Backup Restore (0.3.5.x, legacy)](https://docs.start9.com/0.3.5.x/user-manual/backups/backup-restore.html).

---

## 6. Dependencies — same "no hard dependency" decision as Umbrel, with a networking caveat

`startos/dependencies.ts` in 0.4.0 declares dependencies as **UI warnings
only** — unlike the legacy `config.rules` system, they never block
install or startup. This actually strengthens the case already made for
Umbrel ([PUBLISH-PLAN.md §6](PUBLISH-PLAN.md)): Cairn has no baked-in
Bitcoin Core/Electrum dependency (Electrum host:port is a runtime DB
setting, changeable from `/admin/settings`), so `dependencies: {}` in the
manifest is correct for v1, matching the Umbrel `dependencies: []`
decision exactly.

**Open question, not resolved by this research**: how a Cairn instance
would actually *reach* a StartOS-hosted Electrum/Fulcrum/Electrs package
if the user wants to point at one instead of a public server. Whether
inter-service traffic on StartOS resolves via a private Docker network
(Umbrel-style) or is Tor-routed by default was flagged as an undocumented
gap by every research pass — the "Service-to-Service Networking" doc page
referenced by `docs.start9.com/packaging/0.4.0.x/dependencies.html`
returned 404 during this research. If a future session wants to add
`electrs`/`fulcrum` as an optional dependency (matching `mempool-startos`,
which does exactly this), **resolve that networking question first** —
don't assume it works like Umbrel's shared bridge network.

Sources: [Dependencies reference](https://docs.start9.com/packaging/0.4.0.x/dependencies.html),
[mempool-startos manifest](https://github.com/Start9Labs/mempool-startos) (electrs/fulcrum as optional deps).

---

## 7. Submission — three distinct paths, and the one the user asked about

Unlike Umbrel (single path: PR to `getumbrel/umbrel-apps`), Start9 has
three tiers:

1. **Official/Community Registry (Start9-run)** — email-based, not a
   GitHub PR. Send a link to the public wrapper repo to
   `submissions@start9labs.com`. Start9 snapshots the repo, does a
   completeness/malicious-code scan (**explicitly not a security audit or
   quality judgment of the service itself**), builds it on their own Debian
   box (*"Start9 will not spend time fighting build errors"* — must build
   clean first try), installs and functionally tests it against ~12
   criteria (install/uninstall, actions, health checks, dependency
   resolution, backup/restore, Raspberry Pi resource compatibility), then
   publishes to a **Community Beta Registry**. Developer requests
   promotion to production after a community soak period. No PR review
   cycle like Umbrel's — a build/functional gate instead.
2. **Sideloading, zero registry** — `System → Sideload a Service`, upload
   a raw `.s9pk` file directly. No registry involved at all; this is how
   Start9 itself instructs users to install packages straight from a
   GitHub Releases page when no registry listing exists yet.
3. **Self-hosted custom registry** — this is Start9's direct analog of
   Cairn's existing Umbrel community-store approach
   (`github.com/AlexM223/umbrel-community-app-store`) and is almost
   certainly the right first move here, for the same reason it was for
   Umbrel: **publish without waiting on anyone else's review queue.**

### 7.1 What hosting a custom registry actually requires

A StartOS user adds any third-party registry via
`Marketplace → Change → "Add custom registry"`, pasting a URL — no special
client-side trust ceremony beyond that.

On the hosting side, there are two tiers of effort:

- **Bare-minimum ("basic registry")**: Start9's own docs describe simply
  uploading `.s9pk` files to any static file host (they suggest File
  Browser or Nextcloud running on a Start9 server, served over
  **Start9 Pages** via Tor) — i.e., this can be a plain static file server,
  no registry *software* required, but it's not addable as a proper
  Marketplace registry URL this way — it's closer to tier-2 sideloading
  with extra steps, not a real listed registry.
- **Real registry ("Alternative Registry" in current UI copy, addable via
  the Marketplace UI)**: requires running actual registry server software
  — a real indexing/RPC server, not a static file host. Two
  implementations exist and **only one is current**:
  - `Start9Labs/registry` (Haskell + PostgreSQL) — last commit
    2024-07-11, effectively **dormant**. Its README describes the old
    submission/build flow; don't build against this.
  - `projects/start-registry` inside the `Start9Labs/start-os` monorepo —
    the **actively maintained** registry server (Rust; compiles to a
    single multi-call binary `registrybox`, dispatching as `start-registryd`
    server or `start-registry` CLI depending on invocation name). Real
    logic lives in `shared-libs/crates/start-core/src/registry/`. Serves a
    package index + OS-version index over JSON-RPC/HTTP/WebSocket, storing
    state in a PatchDB (`registry.db`) + SQLite metrics DB. This is what
    to build against.
  - **Easiest deployment path**: `start-registry` is itself installable as
    a one-click StartOS service from the Marketplace ("Install the
    'StartOS Registry' service ... and follow instructions" per the
    current alt-registries docs) — i.e. running a Start9 server yourself
    is sufficient, no separate Debian/systemd/Cargo build required for the
    common case. The from-scratch deployment path (Debian package + apt
    repo + systemd unit, or `cargo build -p start-registry --bin
    registrybox`) exists for anyone not already running a Start9 server,
    but isn't the expected path here.
  - The 0.4.0-era registry protocol **separates indexing from hosting**:
    a registry is "a curated list of services that reference package
    binaries hosted on GitHub or elsewhere" — meaning the actual `.s9pk`
    files can keep living on GitHub Releases (exactly like Cairn's
    existing Umbrel image-hosting pattern on GHCR), while the registry
    server itself only serves a validated index pointing at them. This is
    a meaningfully lighter hosting burden than running the Haskell
    registry's full stack.

**Real precedent for exactly this pattern**: an independent developer
("PaulsCode," who also runs a personal Umbrel community store) hosts his
own StartOS registry at `start9.paulscode.com`, consolidating his
custom-built services so users don't have to sideload manually — added by
users the same way, `Marketplace → Switch → Add custom registry → paste
URL`. Separately, Start9's own Community Registry already distributes at
least one independent Bitcoin app this way: **DATUM Gateway**, a mining-pool
gateway by OCEAN (`github.com/OCEAN-xyz/datum-gateway-startos`), viewable
at `marketplace.start9.com/datum?api=community-registry.start9.com`.

### 7.2 Signing — confirmed, no Start9-issued key needed

Package integrity in the 0.4.0 format is **Blake3-commitment + signed** —
and trust is fully self-sovereign, per-registry, with **no Start9-issued
key or CA involved anywhere in the chain**:

- The developer generates their own signing key
  (`~/.startos/developer.key.pem` via `start-cli init-key`). Confirmed
  directly from `Start9Labs/shared-workflows` (the official GitHub Actions
  used by every `-startos` wrapper repo): a `DEV_KEY` secret holds this
  key, and the workflow **auto-generates one if absent** — there is no
  step where the key is submitted to or approved by Start9.
- Trust is enforced **at the registry**, not globally: each registry
  maintains its own `admins` and `signers` list
  (`start-core/src/registry/admin.rs` — `registry signer add`, an
  `AcceptSigners` enum of `Signer(key)` / `Any([...])` / `All([...])`).
  Whoever runs a registry decides which signer keys it accepts. A
  self-hosted registry operator adds their own key as the sole trusted
  signer, with zero Start9 involvement.
- The StartOS client verifies packages against whichever registry's own
  `signers` list is in effect, not a hardcoded Start9 root of trust.

Net effect: functionally identical in spirit to Umbrel's model (developer-
controlled, no vetting gate), just with a more formal signer/admin API
instead of "trust the git repo."

### 7.3 Recommendation

Mirror the Umbrel playbook directly: install the `start-registry` service
on a Start9 server already under Alex's control, generate a developer key
via `start-cli init-key`, and self-publish the `cairn` package there first
— against the same public `github.com/AlexM223/cairn` repo and
`ghcr.io/alexm223/cairn` image already published for Umbrel — same
reasoning as the Umbrel community store (fast, no external review gate,
identical underlying artifacts). Pursue the official Start9
Registry/Community Registry submission (§7's tier 1) as later, optional,
fast-follow work, exactly as the official `getumbrel/umbrel-apps`
submission is fast-follow work in `PUBLISH-PLAN.md` §7.6.

Sources: [Alternative Registries (0.4.0.x)](https://docs.start9.com/start-os/0.4.0.x/alternative-registries.html),
[Default Registries (0.4.0.x)](https://docs.start9.com/start-os/0.4.0.x/default-registries.html),
[Managing Service Registries (0.3.5.x, legacy)](https://docs.start9.com/0.3.5.x/user-manual/alt-registries),
[Community Submission Process (0.3.5.x)](https://docs.start9.com/0.3.5.x/developer-docs/submission.html),
`Start9Labs/registry` (dormant Haskell repo),
`Start9Labs/start-os` monorepo `projects/start-registry` (current) and
`shared-libs/crates/start-core/src/registry/{admin,signer}.rs`,
`Start9Labs/shared-workflows` (`DEV_KEY`/`start-cli init-key` auto-gen),
[PaulsCode's StartOS registry](https://paulscode.com/t/my-official-start9-registry/1121),
[OCEAN-xyz/datum-gateway-startos](https://github.com/OCEAN-xyz/datum-gateway-startos) via Community Registry.

---

## 8. Tooling and the AI-assisted packaging angle

`start-cli` (host-installed via `curl -fsSL https://start9.com/start-cli/install.sh | sh`)
scaffolds everything: `start-cli s9pk init-workspace` creates a workspace
with `AGENTS.md`/`CLAUDE.md` files baked in, and
`start-cli s9pk init-package "Cairn"` scaffolds the wrapper repo from the
`hello-world-startos` template, running `npm install` automatically. Every
real Bitcoin-app wrapper repo checked (mempool, BTCPay, RTL) carries its
own `CLAUDE.md`/`AGENTS.md` — Start9's own packaging docs explicitly
frame this as **AI-assisted by design**: *"You do not need to be an expert
TypeScript developer – you need to understand what your service requires
and let the AI handle how to implement it,"* naming Claude Code specifically
as the recommended tool. Practical upshot: scaffolding + first-draft
`main.ts`/`manifest/index.ts`/`interfaces.ts` for Cairn is a good candidate
to have Claude Code do directly against the real SDK docs/types once a
workspace exists, rather than hand-writing from this plan's illustrative
snippets (which are best-effort reconstructions from docs/search, not
copy-pasted from a verified build).

Build prerequisites: Docker, Node 22 LTS, `make`, and `squashfs-tools` (the
0.4.0 `.s9pk` format is squashfs-backed, not plain tar). `make` (default
target) builds all configured arches; `make install` sideloads to a dev
StartOS box for testing.

Sources: [Environment Setup](https://docs.start9.com/packaging/0.4.0.x/environment-setup.html),
[Quick Start](https://docs.start9.com/packaging/0.4.0.x/quick-start.html),
[Makefile reference](https://docs.start9.com/packaging/0.4.0.x/makefile.html).

---

## 9. What's reusable from the Umbrel work vs. Start9-specific

| Artifact | Reusable? |
|---|---|
| Public `github.com/AlexM223/cairn` repo | Yes, as-is — it's the `upstreamRepo` |
| Multi-arch `ghcr.io/alexm223/cairn` image + release workflow | Yes, as-is — referenced directly via `dockerTag`, no rebuild needed |
| `/api/health` endpoint | Yes, as-is — wired via `checkWebUrl` instead of a Docker `HEALTHCHECK` |
| `.env`/env-var contract (`CAIRN_DB`, `CAIRN_LOG_FILE`, etc.) | Yes, as-is — same env vars passed via `main.ts`'s `exec.env` |
| `/data` volume layout (`cairn.db`, `instance.key`, `logs/`) | Yes, as-is — same `sdk.Volumes.of({ main: '/data' })` mapping |
| `bootstrapAdminFromEnv()` / forced-reset plan | Yes, once built for Umbrel — becomes a StartOS Action + critical-task instead of an install-card flow |
| Decision not to wire platform password-derivation into Cairn's login | Same decision, same reasoning, different platform primitive (`addSsl.auth` instead of `APP_PASSWORD`) |
| `Dockerfile` itself | **No** — 0.4.0 packages reference the already-published image tag directly; no Start9-side Dockerfile needed |
| `docker-compose.yml` | **No equivalent concept** — replaced by `main.ts` daemon declarations |
| `umbrel-app.yml` manifest | **No** — replaced by TypeScript `startos/manifest/index.ts`, structurally different fields |
| Community app store repo pattern | **Conceptually reusable, technically distinct** — same idea (self-hosted, no review gate) but needs `start-registry` software running, not a static manifest+compose repo like Umbrel's |

---

## 10. Open items before building anything

1. **Verify the LAN-HTTPS/secure-context claim (§3) against a real StartOS
   instance** — this is the one finding that could materially change
   Cairn's hardware-wallet-signing story on Start9 versus Umbrel, and it
   was inferred from docs, not confirmed with `window.isSecureContext` in
   an actual browser session.
2. **Resolve the service-to-service networking question (§6)** before
   adding any Electrum/Bitcoin Core soft dependency — undocumented gap,
   don't assume Umbrel-style shared bridge networking.
3. **Confirm current submission-process specifics for 0.4.0.x** — the
   detailed submission checklist (§7) is sourced from 0.3.5.x docs; no
   0.4.0-specific submission page was found, so the 12-point testing
   criteria may have shifted.
4. **Stand up a real `start-cli s9pk init-workspace`** and scaffold a
   throwaway package before writing production `startos/*.ts` files — the
   code snippets in this doc are illustrative reconstructions from
   documentation and comparable real packages, not verified against an
   actual build.
5. Once 1-4 are resolved, this doc's §1-8 becomes the basis for a
   `START9-PLAN.md` "Status: EXECUTED" rewrite, matching how
   `PUBLISH-PLAN.md` tracks what actually shipped versus what was
   originally planned.
