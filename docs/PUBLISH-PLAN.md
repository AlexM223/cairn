# Publish Plan — Cairn → GitHub → Umbrel App Store

Status: **EXECUTED for the community-store path, 2026-07-06.** What shipped
(differences from the plan below are called out inline):

- Public repo live at `github.com/AlexM223/cairn` (squashed
  "Initial public release" commit from HEAD `e331056`, tag `v0.1.0`, include
  list per §1 — none of §2 shipped). §3's new community files
  (CONTRIBUTING/SECURITY/CODE_OF_CONDUCT/templates/.env.example) are still
  TODO before any official-store submission.
- Multi-arch image at `ghcr.io/alexm223/cairn` built by
  `.github/workflows/release.yml` (native amd64+arm64 runners, push-by-digest
  + manifest-list merge) on every `v*` tag.
- §5 log-path bug fixed in the Dockerfile (`ENV CAIRN_LOG_FILE=/data/logs/cairn.log`),
  plus two fixes the plan missed: the `cairn` user is now pinned to UID/GID
  1000 (Umbrel app-data ownership), and the baked `ENV ADDRESS_HEADER` was
  REMOVED — adapter-node throws on `getClientAddress()` when the header is
  absent, so it 500'd login on unproxied deployments ("harmless" in §6 was
  wrong). Umbrel's compose sets it instead.
- §5's "do not wire Umbrel's APP_PASSWORD" decision was **superseded** (per
  docs/SOLO-MODE-UMBREL-AUTOADMIN-PLAN.md): the community-store package sets
  `CAIRN_ADMIN_PASSWORD: ${APP_PASSWORD}` (compose interpolation — the
  container env never contains a var literally named APP_PASSWORD, so the
  naming collision §5 worried about never materializes) and the manifest uses
  `defaultUsername: admin@cairn.local` + `deterministicPassword: true`.
- §7 targeted the official `getumbrel/umbrel-apps` store; what shipped first
  is Alex's own community store (`github.com/AlexM223/umbrel-community-app-store`,
  app id `caravan-store-cairn`, port 3211, icon/gallery served from the public
  repo — community stores DO commit/reference their own assets). The official
  submission remains future work and §7's guidance still applies to it.
- Prod build fixed on the branch (vite build.target 'esnext', dropped
  vite-plugin-top-level-await) — the §7.2 arm64 concern about the `usb`
  native addon was real but is handled by native arm64 CI runners.

The original plan follows.

---

This is the concrete checklist for taking the private
working tree at `C:\dev\cairn` public and then submitting it to the Umbrel
App Store.

---

## 1. Files to INCLUDE in the public repo

Everything needed to build, run, test, and understand Cairn:

- **Source**: `src/` in full — `src/lib` (components, server, hw, shared,
  styles, assets), `src/routes`, `src/tests`, `src/app.css`, `src/app.d.ts`,
  `src/app.html`, `src/hooks.server.ts`
- **Static assets**: `static/robots.txt` (and any future public assets)
- **Config**: `package.json`, `package-lock.json`, `tsconfig.json`,
  `vite.config.ts`, `vitest.config.ts`, `.npmrc`, `.gitattributes`
- **Docker**: `Dockerfile`, `docker-compose.yml`, `.dockerignore`
- **Scripts**: `scripts/reset-password.mjs`. Drop `scripts/vault-e2e/`
  entirely (see §2 — it's hardware-emulator test scaffolding with captured
  secrets, not a shippable operator script).
- **Docs to keep as-is**: `docs/API.md`, `docs/RECOVERY.md`,
  `docs/screenshots/*.png` (used by README)
- **Root docs**: `README.md`, `LICENSE`, `DISCLAIMER.md`
- **CI**: `.github/workflows/ci.yml`
- **VS Code**: `.vscode/extensions.json` only (already the only tracked file
  there)

## 2. Files to EXCLUDE — must NOT be in the public repo

Delete or leave untracked before publishing. Grouped by why:

**Issue tracker / internal planning**
- `.beads/` — entire directory (`issues.jsonl`, `beads.db*`, `config.yaml`,
  `.br_history`, `.sync.lock`, `.write.lock`, `last-touched`,
  `metadata.json`). This is Alex's private backlog, not open-source issue
  tracking.
- `.claude/` — entire directory (`launch.json`, `scheduled_tasks.lock`,
  `worktrees/`). Local agent tooling config.
- `.ms-signer.mjs` — untracked scratch script at repo root, no place in a
  clean history.

**Internal plan / audit / retrospective docs** (all of `docs/` except the
four keepers above)
- `docs/ARCHITECTURE-REVIEW-2026-07-06.md`
- `docs/BATCH-TRANSACTIONS-PLAN.md`
- `docs/BUILD-QUEUE.md`
- `docs/COLLABORATIVE-CUSTODY-PLAN.md`
- `docs/CPFP-UNCONFIRMED-PLAN.md`
- `docs/DATA-AUDIT-2026-07-06.md`
- `docs/FEATURE-FLAGS-PLAN.md`
- `docs/HARDWARE-PLAN.md`
- `docs/LOAD-TEST-RESULTS-2026-07-05.md`
- `docs/NOTIFICATION-PLAN.md`
- `docs/PER-USER-SMTP-PLAN.md`
- `docs/PROCESS-RETROSPECTIVE-2026-07-06.md`
- `docs/SECURITY-AUDIT-2026-07-05.md`
- `docs/TECH-DEBT-AUDIT-2026-07-05.md`
- `docs/PUBLISH-PLAN.md` itself (this file — internal, don't ship it)

These are working notes with dates, cost/perf numbers, and vulnerability
detail that shouldn't be public. If any content is worth keeping publicly
(e.g. a trimmed recovery/architecture explainer), rewrite it fresh into
`docs/API.md`/`docs/RECOVERY.md` or a new doc — don't publish the raw notes.

**Hardware emulator / manual test scaffolding**
- `.hw-emu-test/` — entire directory. Contains captured mnemonics
  (`e2e-coldcard-mnemonic.txt`, `e2e-v5-mnemonic-*.txt`), session tokens
  (`session-token.txt`, `e2e-session-token.txt`), signed PSBTs with real
  test-key material, Ledger/Trezor policy HMACs, proxy scripts, and ad-hoc
  `.mjs` probes. None of this is a maintained test suite — it's scratch
  output from manual emulator sessions. Even though the keys are
  test/regtest-only, this doesn't belong in a public history.
- `scripts/vault-e2e/` — same category: captured PSBTs, a package-lock for
  a throwaway harness, proxy.py, VERIFICATION.md notes. Exclude entirely.

**AI session artifacts**
- Any `CLAUDE.md`, agent transcripts, or session files if present outside
  `.claude/` — grep for them at publish time (`git status --ignored`) since
  new ones may appear before the cutover.

**Local runtime / generated / secret**
- `data/` — entire directory: `cairn.db*` (including timestamped
  `.bak-*` snapshots), `dev-fresh*.db*`, `notif-test.db*`, `instance.key`
  (the local secret-encryption key — regenerating this on every fresh
  install is correct behavior, it must never ship), `logs/*.log*`
- `.env`, `.env.*` (no `.env` currently present, but keep the rule — only
  ship `.env.example` if one is added)
- `node_modules/`, `.svelte-kit/`, `build/` — all generated
- `package-lock.json` for `scripts/vault-e2e/` (moot once the dir is
  dropped)

**Git identity / co-author trailers**
- The existing history has commits with `Co-Authored-By: Claude Fable 5
  <noreply@anthropic.com>` and `Co-Authored-By: Claude Opus 4.8
  <noreply@anthropic.com>` trailers. A fresh squashed history (§4) avoids
  carrying these forward — don't hand-strip trailers from 227+ commits,
  just don't bring the old commits at all.

**Already correctly ignored** (verify still true, no action needed):
`node_modules`, `.svelte-kit`, `build`, `data/`, `.beads` and `.claude` are
already in `.gitignore`/`.dockerignore`. The gap is that `.beads/`,
`.hw-emu-test/`, and the audit docs are *tracked* or *untracked-but-present*
in the working tree today, not that `.gitignore` is wrong — a fresh repo
(§4) sidesteps this by only adding what's on the include list.

## 3. Files to CREATE

- **`README.md`** — largely exists and is good; keep the features list and
  screenshots, but for the public cutover confirm/add:
  - Quickstart (docker-compose one-liner, and `npm install && npm run dev`)
  - Requirements (Node 22+, an Electrum server — self-hosted or public)
  - Link to `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`
  - Umbrel install badge/link once it's in the App Store (placeholder for
    now)
- **`LICENSE`** — already MIT and present, no change needed.
- **`CONTRIBUTING.md`** (new) — dev setup (`npm install`, `npm run dev`),
  how to run tests (`npm test`, `npm run check`), branch/PR conventions,
  where to discuss design changes before a big PR, code style notes
  (Svelte 5 runes, TypeScript strictness).
- **`SECURITY.md`** (new) — this is a Bitcoin custody app, take this
  seriously:
  - How to report a vulnerability privately (email or GitHub private
    security advisory — do not use public issues for key-handling bugs)
  - Scope: server never sees private keys (watch-only + hardware signing);
    what *is* sensitive server-side (SMTP creds, session tokens, the
    per-instance encryption key in `data/instance.key`)
  - Supported versions
- **`CODE_OF_CONDUCT.md`** (new) — standard Contributor Covenant v2.1.
- **`.github/ISSUE_TEMPLATE/bug_report.md`** and
  **`.github/ISSUE_TEMPLATE/feature_request.md`** (new)
- **`.github/PULL_REQUEST_TEMPLATE.md`** (new) — checklist: tests pass,
  `npm run check` clean, screenshots for UI changes.
- **`.github/workflows/ci.yml`** — already exists and is reasonable
  (checkout → setup-node@22 → npm ci → check → test). Consider adding a
  second job for `docker build .` to catch Dockerfile breaks before
  release, since Umbrel packaging depends on the image building cleanly.
- **`.env.example`** (new) — see §6 for the full env var contract to
  document.
- **`docs/PUBLISH-PLAN.md`** — this file; keep it out of the public repo
  (see §2) but keep it in the private working tree for tracking.

## 4. Git strategy

Do **not** push the existing commit history (it has AI co-author
trailers, and interleaves the audit/plan docs and `.hw-emu-test` captures
throughout). Instead:

1. Create a fresh directory, copy over only the include-list from §1
   (nothing from §2).
2. `git init`, add a clean `.gitignore` (existing one is close — just make
   sure `.hw-emu-test/`, `docs/*PLAN*.md`, `docs/*AUDIT*.md`,
   `docs/*REVIEW*.md`, `docs/*RESULTS*.md`, `docs/*RETROSPECTIVE*.md`,
   `.beads/`, `.ms-signer.mjs` are covered — moot if they're simply not
   copied into the new tree, but keep the ignore rules anyway as a
   guardrail against regressions).
3. One squashed initial commit: `git commit -m "Initial public release"` —
   no co-author trailer, authored by Alex.
4. Tag it `v0.1.0`.
5. Push to a new `github.com/<org>/cairn` repo, default branch `main`.
6. Going forward: normal PR workflow, no more squash-everything — the
   private `C:\dev\cairn` working tree with full history stays as the
   internal dev copy (or the public repo becomes the sole copy going
   forward, if preferred — decide before the first external contributor
   shows up, not after).

## 5. Pre-submission code fixes

Found while auditing the current `Dockerfile`/`src/lib/server` against
Umbrel's persistence rule ("anything the user expects to keep must be
bind-mounted from app data"):

- **Log file escapes the data volume.** [logger.ts:49](../src/lib/server/logger.ts:49)
  defaults `CAIRN_LOG_FILE` to `path.join(process.cwd(), 'data', 'logs',
  'cairn.log')`. `process.cwd()` in the container is `/app` (Dockerfile
  `WORKDIR /app`), so the real default path is `/app/data/logs/cairn.log`
  — **not** under the `/data` volume the Dockerfile declares and
  `docker-compose.yml`/Umbrel's compose mount. `CAIRN_DB` is fine because
  the Dockerfile explicitly sets `ENV CAIRN_DB=/data/cairn.db`, but there's
  no equivalent `ENV CAIRN_LOG_FILE=...` line. Net effect: on every
  container recreate (restart, update, or an Umbrel app-data reinstall),
  the rotating log file and the in-app admin log viewer's history are
  silently reset, and disk use accumulates in the container's writable
  layer instead of the mounted volume.
  - **Fix**: add `ENV CAIRN_LOG_FILE=/data/logs/cairn.log` to the
    `Dockerfile` runtime stage, next to the existing `ENV CAIRN_DB=...`
    line. This is a plain correctness fix independent of Umbrel — do it
    before the public cutover, not as Umbrel-specific glue.
- **`APP_PASSWORD` naming collision.** [auth.ts:238](../src/lib/server/auth.ts:238)
  and [recovery.ts:362](../src/lib/server/recovery.ts:362) read `APP_PASSWORD`
  as a legacy fallback for `CAIRN_ADMIN_PASSWORD` (the operator break-glass
  password, gated behind `CAIRN_ADMIN_RECOVERY=true`). Umbrel's own runtime
  convention *also* defines an `APP_PASSWORD` env var
  (`derive_entropy "app-<app-id>-seed-APP_PASSWORD"`), intended for apps
  that wire their primary login to it and set `deterministicPassword:
  true` in the manifest. These are unrelated concepts that happen to share
  a name. Decision for this plan: **do not** set `deterministicPassword`
  or wire Umbrel's `APP_PASSWORD` into Cairn — Cairn's real first-run flow
  is self-serve email+password signup through the web UI (see
  `cairn-auth-model` — Umbrel needs password mode, don't remove it), which
  already satisfies Umbrel's "no CLI/SSH setup" gate on its own. Just don't
  reference `${APP_PASSWORD}` in the Umbrel `docker-compose.yml`
  `environment:` block, so the two never collide in practice. If a future
  session wants an admin-recovery convenience for Umbrel installs, derive
  a *distinctly named* secret (e.g. `APP_CAIRN_ADMIN_RECOVERY_PASSWORD` via
  `exports.sh` + `derive_entropy`) rather than reusing Umbrel's
  `APP_PASSWORD`.
- **WebAuthn/passkeys over `.local` HTTP.** Umbrel's default LAN access is
  `http://<device>.local:<port>` (no TLS). Browsers only allow WebAuthn
  over HTTPS or `localhost` — passkey signup/login will not work through
  the plain-HTTP `.local` origin, only through Umbrel's HTTPS remote-access
  path (if configured) or literally on `localhost`. This isn't a Cairn bug
  — password auth is already the default and already required to work for
  Umbrel per prior guidance — but call it out once in the README/App Store
  description so users don't file "passkeys are broken" issues: *"Passkey
  login requires HTTPS; on a local `.local` address, use password login."*

## 6. Environment variable contract

Audited `src/lib/server` for every `process.env`/`$env/dynamic/private`
read (excluding test-only files). Use this table for `.env.example` and for
deciding what the Umbrel `docker-compose.yml` needs to set explicitly.

| Var | Default | Baked into `Dockerfile`? | Notes |
|---|---|---|---|
| `PORT` | `3000` | yes (`ENV PORT=3000`) | adapter-node listen port |
| `CAIRN_DB` | `./data/cairn.db` | yes → `/data/cairn.db` | SQLite path |
| `CAIRN_LOG_FILE` | `./data/logs/cairn.log` | **no — bug, see §5** | should be `/data/logs/cairn.log` |
| `CAIRN_LOG_TO_FILE` | `true` | no | set `false` to stdout-only |
| `CAIRN_LOG_MAX_SIZE` | `10485760` (10 MiB) | no | rotation threshold, bytes |
| `CAIRN_LOG_MAX_FILES` | `5` | no | rotation retention |
| `LOG_LEVEL` | `info` (prod) | no | `error`\|`warn`\|`info`\|`debug` |
| `ADDRESS_HEADER` | `x-forwarded-for` | yes | only correct behind a proxy that sets/overwrites it — true for both `docker-compose` (no proxy, harmless) and Umbrel (`app_proxy` sets it) |
| `NODE_ENV` | `production` | yes | |
| `CAIRN_ORIGIN` | request origin | no | absolute origin used in notification email links and as WebAuthn origin fallback; **set explicitly for Umbrel** to `http://${DEVICE_DOMAIN_NAME}:${APP_PROXY_PORT}` |
| `CAIRN_RP_ID` | request hostname | no | WebAuthn RP ID; leave unset, derives correctly from the request |
| `CAIRN_AUTH_MODE` | `password` (or DB setting) | no | leave unset — password mode is required for Umbrel |
| `CAIRN_ADMIN_EMAIL` | `admin@cairn.local` | no | only used with `CAIRN_ADMIN_RECOVERY` |
| `CAIRN_ADMIN_PASSWORD` / `APP_PASSWORD` (legacy alias) | unset | no | operator break-glass password; **do not set in the Umbrel package** (see §5 collision note) |
| `CAIRN_ADMIN_RECOVERY` | unset (`false`) | no | must be `true` to enable the above; leave unset for Umbrel |

No env var currently configures the Electrum server — that's a runtime
setting stored in the DB (`src/lib/server/settings.ts`, default
`electrum.blockstream.info:50002`), changeable from `/admin/settings` in
the web UI. This means Cairn boots and passes its health check with zero
required external network config, which satisfies Umbrel's "must come up
before the user configures anything" gate. It also means there's no hard
compose-level dependency on an Electrum app — see §7 for a possible future
`electrs` integration.

## 7. Umbrel App Store package

Reference: Umbrel apps live in a separate `getumbrel/umbrel-apps` repo (one
PR per app). That repo holds only a manifest + compose file per app — no
application code — and points at the already-published, already-public
Cairn Docker image and GitHub repo from §1-4. **Do this section only after
§1-6 are done and the public repo has a tagged release with a built,
pushed, multi-arch image** — the submission references a real image and a
real repo URL, not a future one.

### 7.1 Package layout (in `getumbrel/umbrel-apps`, not this repo)

```text
cairn/
  umbrel-app.yml
  docker-compose.yml
```

No `exports.sh`, `hooks/`, or templates are needed for v1 — Cairn has no
generated per-install secrets it needs Umbrel to derive (see the
`APP_PASSWORD` decision in §5) and no config file that needs
env-substitution at install time.

### 7.2 Image requirements before submission

- Build and push a **multi-arch** (`linux/amd64` + `linux/arm64`) image —
  Umbrel devices (Raspberry Pi 4/5, Umbrel Home) are arm64. The current
  `Dockerfile`'s build stage installs `python3 make g++ linux-headers
  eudev-dev` for the native `usb` addon; confirm these Alpine packages and
  `npm ci` all work under emulated/native arm64 builds (`docker buildx
  build --platform linux/amd64,linux/arm64`) — the `usb`/`node-gyp` step is
  the most likely arm64 breakage point, worth a dedicated CI job.
- Publish to `ghcr.io/<org>/cairn` (GHCR is simplest given the repo already
  lives on GitHub) via a release workflow triggered on `v*` tags.
- Pin the image in the Umbrel compose as `ghcr.io/<org>/cairn:0.1.0@sha256:<digest>`
  — tag *and* digest together, not `latest`, not digest-only. Verify both
  platforms are present in the tag with
  `docker buildx imagetools inspect ghcr.io/<org>/cairn:0.1.0`.

### 7.3 Draft `umbrel-app.yml`

```yaml
manifestVersion: 1
id: cairn
category: bitcoin
name: Cairn
version: "0.1.0"
tagline: Self-hosted Bitcoin command center
description: >-
  Cairn is a self-hosted, watch-only Bitcoin wallet navigator and block
  explorer you run yourself. It never touches your private keys — signing
  happens on your hardware wallet (Trezor, Ledger, BitBox02, Jade,
  Coldcard) or is coordinated as a multisig quorum.


  First-run setup is entirely in the browser: create the first account
  with an email and password, then add a watch-only wallet from an xpub or
  a Caravan multisig config. No SSH or config-file editing required.


  Passkey login requires HTTPS — on Umbrel's default `.local` address, use
  password login instead.
releaseNotes: ""

developer: Alex Martinez
website: https://github.com/<org>/cairn
dependencies: []
repo: https://github.com/<org>/cairn
support: https://github.com/<org>/cairn/issues

port: 3211
gallery: []
path: ""

defaultUsername: ""
defaultPassword: ""

submitter: Alex Martinez
submission: https://github.com/getumbrel/umbrel-apps/pull/<TBD>
```

Notes on fields left as placeholders/TBD:
- `port: 3211` is a guess in an unused-looking range — **must be verified
  against the current `getumbrel/umbrel-apps` repo at submission time**
  (grep all `umbrel-app.yml` `port:` values for collisions); do not ship
  this value without checking.
- `gallery: []` and no `icon:` field is deliberate, not an omission — for
  official App Store submissions, the Umbrel team hosts and adds gallery
  screenshots and the app icon themselves in a separate assets repo after
  the PR is opened. Provide the app logo/source and 3-5 screenshots *in
  the PR description* (reusing/refreshing `docs/screenshots/*.png`), not
  as committed files in the package directory. (An earlier draft of this
  plan assumed icon/gallery assets belonged in the app repo — that's only
  true for community app stores, not the official one; corrected here.)
- `dependencies: []` — no hard dependency on an Umbrel-hosted Electrum
  server, since Cairn defaults to a public Electrum server and lets the
  user reconfigure it from Settings. **Possible future enhancement**: if
  Umbrel's `electrs` app is installed, prefill Cairn's Electrum setting
  from its exported `APP_ELECTRS_NODE_IP`/`APP_ELECTRS_NODE_PORT` contract
  instead of the public default — this would need `electrs` added as a
  soft/optional dependency and a small settings-bootstrap change in
  Cairn itself. Out of scope for the v1 submission; note as a fast-follow.
- `category: bitcoin` — confirm this is still the exact category slug the
  App Store uses at submission time (taxonomy can shift between Umbrel
  releases).

### 7.4 Draft `docker-compose.yml`

```yaml
services:
  app_proxy:
    environment:
      APP_HOST: cairn_web_1
      APP_PORT: 3000

  web:
    image: ghcr.io/<org>/cairn:0.1.0@sha256:<digest>
    user: "1000:1000"
    restart: on-failure
    environment:
      CAIRN_ORIGIN: "http://${DEVICE_DOMAIN_NAME}:${APP_PROXY_PORT}"
    volumes:
      - ${APP_DATA_DIR}/data:/data
```

Why each piece:
- `app_proxy` fronts the app — no raw `ports:` on `web`, since Cairn is a
  plain HTTP web app with no companion-client or protocol port to expose.
- `APP_HOST: cairn_web_1` matches Umbrel's injected container-name pattern
  `<app-id>_<service-name>_1` for a service named `web`.
- `APP_PORT: 3000` is the Dockerfile's internal listen port (`EXPOSE
  3000`), distinct from the manifest's public-facing `port:`.
- `user: "1000:1000"` is safe here: the Dockerfile already creates a
  non-root `cairn` user and `chown`s `/data` at build time, but Umbrel
  bind-mounts a *host* directory at `${APP_DATA_DIR}/data` owned by
  `1000:1000` — matching the container's UID avoids permission mismatches
  between the image's baked-in UID and Umbrel's host-side ownership.
  Verify the image's `cairn` user is actually UID 1000 (Alpine
  `adduser -S` assigns the next free UID, not necessarily 1000 — pin it
  explicitly in the Dockerfile with `adduser -S -u 1000 cairn` if not,
  otherwise the bind mount will be unwritable).
- `CAIRN_ORIGIN` is the one env var worth setting explicitly (see §5/§6) —
  without it, notification emails would embed whatever origin the
  triggering request happened to have, which is less predictable behind
  Umbrel's proxy than declaring it.
- `restart: on-failure`, not `unless-stopped` — Umbrel manages app
  lifecycle; matches the skill's default guidance for long-running
  services.
- No top-level `networks:` block — Umbrel injects `umbrel_main_network` as
  `default` at runtime.

### 7.5 Persistence and backups

- All persistent state (`cairn.db*`, `instance.key`, rotating logs once
  §5's fix lands) lives under one bind mount, `${APP_DATA_DIR}/data:/data`
  — matches the existing `docker-compose.yml`'s `./data:/data` pattern, so
  no new persistence design is needed, just the path rewrite to
  `${APP_DATA_DIR}`.
- Add `backupIgnore: - data/logs/*` to `umbrel-app.yml` — rotated log
  files are regenerable operational noise, not user data; excluding them
  keeps backups smaller. Do **not** ignore `cairn.db*` or `instance.key` —
  those are exactly the "would reset the app to a blank state" files
  backups exist to protect, especially `instance.key` (losing it makes
  any DB-encrypted secrets — SMTP creds, session tokens — unrecoverable).

### 7.6 Submission process

1. Finish §1-6 (public repo live, tagged `v0.1.0`, image built/pushed
   multi-arch to `ghcr.io/<org>/cairn`).
2. Fork `getumbrel/umbrel-apps`, add the `cairn/` directory from §7.1,
   confirm the real free `port:` value.
3. Run `npm run lint:apps -- cairn --check-images` in that repo and fix
   all reported errors (manifest shape, port collisions, image
   pinning/pullability/multi-arch, compose wiring, `app_proxy` basics,
   persistence paths).
4. Test through an actual Umbrel device or umbrelOS VM (see the
   `umbrel-test-app` skill/workflow): fresh install → opens in browser →
   complete first-run signup → create a watch-only wallet → restart the
   app → confirm data persisted → simulate an update (bump `version:`,
   reinstall) → confirm data still persists → uninstall/reinstall clean.
5. Open the PR to `getumbrel/umbrel-apps` with: app name/version, upstream
   repo URL, image source (`ghcr.io/<org>/cairn:0.1.0@sha256:...`),
   screenshots (from `docs/screenshots/`) and the app logo pasted into the
   PR body (not committed to the package dir — see §7.3), a summary of
   what Cairn does, and the testing performed in step 4. No host access,
   no elevated permissions, no `dependencies:` to call out.
6. Expect a review round-trip on manifest wording, port assignment, and
   image tagging conventions — this is normal, budget for at least one
   revision cycle before merge.
