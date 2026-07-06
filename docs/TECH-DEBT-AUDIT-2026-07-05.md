# Cairn Tech-Debt Audit — 2026-07-05

Full read-only audit of the test suite, error handling, logging, and general tech debt across `src/`. Scope: 212 `.ts` files (51 `*.test.ts`), 91 API routes under `src/routes/**/+server.ts`, `src/lib/server/**` (bitcoin, chain, channels, electrum, wallets), `src/lib/hw/**` (hardware wallet drivers), `src/hooks.server.ts`.

**Headline:** Cairn's baseline quality is materially above average for a project this size — a deliberate error-status taxonomy, a thoughtful `handleError` hook, specific domain error messages on the highest-stakes paths (PSBT construction/signing/broadcast), a clean dependency tree, zero dead test files, and no `console.*` calls anywhere in `src/`. The real findings cluster into a fairly small number of concrete issues, most of them **silent failure paths**: a chain-RPC hiccup that can silently bypass coinbase-maturity enforcement, an Electrum client that goes quiet on reconnect/resubscribe failures, security-relevant events (failed logins, rate-limit trips) that never reach the structured log, and a notification pipeline that can drop an external alert after the in-app copy already succeeded. None of these are exotic — they're all "the unhappy path returns a fallback value and says nothing," repeated across otherwise well-built modules.

Everything below is classified **Cut** (remove, dead weight), **Fix** (wrong/harmful, fix now), **Refactor** (works, should be cleaned up), or **Note** (worth knowing, not actionable now). All **Fix** items have been filed as beads (see the end of this doc).

---

## 1. Tests

Scope: all 51 `*.test.ts` files (~13,250 lines).

### 1.1 Coverage map

- **Bitcoin core** (`src/lib/bitcoin.ts`, `src/lib/server/bitcoin/*`, `src/lib/server/electrum/*`): strong. SPV header/merkle verification cross-checked against an independent reference implementation; xpub parsing/derivation against real BIP vectors; descriptor round-trips against the Bastion reference; PSBT construction byte-cross-checked against `btc-signer`'s own codec; multisig sign→combine→finalize lifecycle including SIGHASH restriction (cairn-srte) and foreign-signature rejection; signing-mass/UTXO-tiering logic.
- **Hardware wallets** (`src/lib/hw/*`): pure logic (path derivation, policy/descriptor building, signature merge-back, error classification) is thoroughly covered for all four drivers (Ledger, Trezor, BitBox02, Jade). BitBox02's registration-before-signing flow — the exact regression class fixed in `93f6ff4` — has a dedicated test.
- **Wallet/multisig lifecycle**: draft build, broadcast (with atomic-claim race, forged-txid rejection cairn-ziwm), quorum-gated signing, ColdCard/Caravan export/import against golden fixtures, CSV/PDF export, RBF fee-bump (BIP-125 rule 4).
- **Notifications/channels/auth/security**: per-channel send/test logic (real NIP-44 crypto for Nostr, real SMTP wire protocol + PGP round-trip for email, HMAC signing + SSRF/DNS-rebinding guard for webhook), queue retry/backoff/dead-lettering, registration/password/passkey/session auth, anti-enumeration recovery flow, instance backup crypto + secret-exclusion (cairn-cpb5), rate limiting.
- **Misc utilities**: formatting, mempool-visualization invariants, coinbase-maturity math.

### 1.2 Redundant tests — Refactor / Note

- **Refactor** — `src/lib/server/bitcoin/multisig.test.ts:156-162` (`is deterministic across calls`) — near-tautological for a pure function, adds little beyond equality assertions already in the file.
- **Refactor** — `src/lib/server/bitcoin/psbt.test.ts:327,453,565` — three near-identical "build → sign → finalize → assert txid" round-trips (taproot destination, batch, send-max) that could collapse to one parametrized case.
- **Note** — Broadcast-integrity checks (already-sent guard, forged-txid rejection, atomic-claim race) are intentionally duplicated across `transactions.test.ts`, `multisigTransactions.test.ts`, and `stateless.test.ts` — appropriate given three distinct code paths share the property, but a parallel-maintenance burden if that logic is ever unified.
- **Note** — The five channel test files (`email`, `nostr`, `ntfy`, `telegram`, `webhook`) share an almost identical `isConfigured`/`send` skeleton (not-configured → non-retryable, network error → retryable, status-code classification). Each also asserts channel-specific logic (PGP, NIP-44, HTML escaping, HMAC/SSRF), so this is necessary parallel structure, not pure waste.
- **Note** — A handful of mock-call-shape assertions (`search.test.ts:65-66,80`, `email.test.ts:150-159`, `bitbox02.test.ts:406`, `ledger.test.ts:606-607`) inspect internal call args rather than pure output, but in each case the call itself (network-avoidance, routing, device-call order) *is* the behavior under test — justified, not a smell.

### 1.3 Flaky / order-dependent tests — Fix / Refactor

- **Fix** — `src/lib/server/notifications.test.ts:65-78,101-110` — mutates the shared exported `DEFAULT_PREFERENCES['tx_received']` object in place and restores it manually with no `try/finally`/`afterEach` guard. If an assertion between mutation and restore throws, the object stays permanently mutated for the rest of the run, silently affecting other files that import it (e.g. `notificationQueue.test.ts`). **Bead filed.**
- **Fix** — `src/lib/server/electrum/client.test.ts:151-162` — timeout test uses real `Date.now()` and a real 200ms timer with a `150ms–1500ms` assertion window — classic CI-flake shape. Should use `vi.useFakeTimers()`. Related real-timer waits at lines 168, 239. **Bead filed.**
- **Refactor** — `src/lib/server/wallets-multisig.test.ts:109-120` — real `setTimeout(r, 5)` wall-clock wait for a "timestamp only moves forward" check; low risk but no test file in the suite uses fake timers for this pattern.
- **Note (good pattern, cite for consistency)** — `notificationQueue.test.ts:53-55` explicitly clears a module-level singleton in `beforeEach` with a comment explaining the leak it prevents, and forces `next_attempt_at` into the past rather than waiting on real backoff — exactly the right approach, worth applying to the two Fix items above.

### 1.4 Over-mocked tests

None found where the function under test's own logic is mocked into a trivial pass-through — a genuine strength. Every channel/queue/PSBT test mocks only the network/transport edge (fetch, nodemailer, relay pool, Electrum RPC) while running real business logic (crypto, HTML-escaping, quorum math, DB writes) unmocked.

### 1.5 Coverage gaps — Fix / Note

**Security-relevant, currently zero coverage:**
- **Fix** — Electrum TLS certificate validation (`tls.connect`, `tlsInsecure` option in `src/lib/server/electrum/client.ts`) has no test at all — a MITM-relevant knob with no regression protection. **Bead filed** (combined with the resubscribe-logging fix below).
- **Fix** — Electrum reconnect/backoff/resubscribe path (`onDisconnect()`, `resubscribe()`) — the code that runs after every real-world network blip — is completely untested.
- **Fix** — No end-to-end multisig PSBT test at M=1 or M=N (unanimous) quorum. All multisig tests use strict M<N (2-of-3, 3-of-5); off-by-one threshold bugs live exactly at these boundaries. **Bead filed.**
- **Fix** — Ledger's hand-rolled BIP-388 wire protocol (`serializeMultisigPolicy`, `makeDeviceWalletPolicy`, `exchangeInterruptible`, `primeInterpreterWithPolicy`) — the most protocol-fragile custom code in any HW driver — has zero unit tests. **Bead filed.**
- **Note** — Admin route surface is a systemic blind spot: zero test files under `src/routes/api/admin/`. This directly explains why **cairn-vbnq** (P1 admin SMTP port crash) shipped undetected — the equivalent *per-user* SMTP validation route has a passing test; the admin-wide equivalent has none.
- **Note** — **cairn-evp9** (backup events unwired) is structurally uncatchable by the current test design: `backups.ts`'s `markBackedUp` calls `recordActivity()` directly, bypassing `notify()` entirely, so no test asserting against `notify()`'s contract would ever exercise the missing wiring. Confirms the existing bead's framing.
- **Note** — `src/lib/server/multisigShares.ts` (collaborative-custody share/revoke) has no test file at any layer, and neither do its two routes — a real access-control gap given it governs viewer/cosigner grants.
- **Note** — `src/lib/server/chain/` (the Esplora/mempool facade behind `api/mempool/*`, `api/tx/*`, `api/address/*`, `api/blocks/*`) has no test file distinct from the lower-level `electrum/client.test.ts` — every mempool/address/tx/block route is untested at the lib layer.

**Bitcoin-critical boundary conditions (Note, lower urgency than above):**
- Legacy p2pkh / p2sh-p2wpkh are never tested as the *source* wallet type in `psbt.test.ts` (only as destinations) — the `nonWitnessUtxo`-required and `redeemScript`-attachment branches for spending from these types are unexercised.
- `describe.runIf(scriptTypeReady(...))` in `multisigPsbt.test.ts:665-748` is a silent-skip trap door — if p2sh/p2sh-p2wsh multisig support regresses, ~50 lines of tests vanish with zero failures instead of failing loudly.
- Single-sig `buildDraft`/coin-control (`wallets.ts`) has zero coverage — `wallets.test.ts` only covers tx-labels; `createWallet`, `listWallets`, `getWalletDetail`, `nextReceiveAddress` are untested anywhere.
- SPV verification exercises only 4 of 6 `InclusionResult` reason codes.

**Hardware wallet signing flows (Note):** pure logic is excellent across all four drivers, but the actual device-interaction entry points (`signPsbtWithLedger`, `signPsbtWithTrezor`, Jade's full sign flow including its PIN-server HTTP relay) are largely untested beyond BitBox02's registration-order case. Jade is weakest — essentially untested beyond pure path/descriptor helpers.

**HTTP/API layer (Note):** of 88 `+server.ts` routes, only 2 have a direct route-level test. Most business logic is covered indirectly via `lib/server` unit tests, but the HTTP wiring itself (status codes, auth-gate presence, request parsing) is untested end-to-end for nearly the whole API surface, including wallet creation, PSBT sign/broadcast, and key/backup export. This is a large practical gap (see §1.6/Route coverage) but lower severity since the underlying logic is tested — a route wired incorrectly onto tested logic (wrong status, missing auth check, swallowed error) wouldn't be caught.

### 1.6 Route-level delegation coverage (supplementary pass)

A route-by-route pass over the API surface, cross-referencing each `+server.ts` against its `lib/server` test coverage, found:
- **Multisig sharing/collaboration** (`api/wallets/multisig/[id]/shares/*`) is the clearest UNCOVERED case — no test at any layer, real authorization logic behind it.
- **Electrum/chain proxy routes** (`api/mempool/*`, `api/tx/[txid]`, `api/address/[address]`, `api/blocks/*`) are the weakest cluster overall — the chain facade itself is untested, and most of these routes also carry their own untested parameter-parsing/pagination logic on top.
- **Coin-control/UTXO-mass routes** (`api/wallets/[id]/utxo-mass`, multisig equivalent) have a substantial bounded-concurrency fetch/cache orchestration layer that's local to the route and untested as an integrated flow (only the pure classification helpers are unit-tested).
- Most PSBT-build/broadcast/export routes are thin wrappers over well-tested library functions (LIKELY-COVERED-VIA-LIB) — lower priority.

### 1.7 Naming consistency

High quality overall. Most `it()` names read as behavior specs, and many embed the regression-bug ID inline (cairn-x54, cairn-srte, cairn-ziwm, cairn-cpb5) — excellent for traceability. **Note**: `backup.test.ts` (full-instance encrypted backup) vs. `backups.test.ts` (per-wallet backup-download reminder tracking) is a singular/plural naming collision risk for anyone grepping "backup" — worth a rename if either file is touched again.

### 1.8 Dead test files or commented-out tests

**None found.** Zero empty test files, zero `.skip`/`.only` usage, no commented-out test blocks across all 51 files. Clean, actively-maintained baseline.

---

## 2. Error Handling

Scope: all 91 API routes, `src/lib/server/**`, `src/lib/hw/**`, `src/hooks.server.ts`.

### 2.1 Bare/swallowing catch blocks

The majority of the ~200 empty-body catches found via full-tree grep are a deliberate, well-understood Bitcoin-library idiom: try format A, fall back to format B, convert failure into a `null`/`false` return or a rethrown domain error one or two lines later (e.g. `xpub.ts`, `psbt.ts`, `multisigPsbt.ts` parse-fallback sites). These are **Note**, not defects — the information isn't actually lost, just reshaped.

Genuinely concerning swallows:

- **Fix** — `src/lib/server/electrum/client.ts:243` (`resubscribe()`): catch body is only a comment (*"Resubscription failure will surface via the next disconnect/retry"*). Re-subscribing `blockchain.headers.subscribe` and every `scripthash.subscribe` after a reconnect can fail silently with zero log line — a self-hoster sees "nothing is updating" with no diagnostic trail. **Bead filed** (combined with the TLS/reconnect test gap above).
- **Fix (Bitcoin-critical, verified directly)** — `src/lib/server/bitcoin/coinbaseScan.ts:16-29` (`isCoinbaseTx`/`annotateCoinbase`): a chain-RPC failure while checking a UTXO's funding tx is caught and silently treated as "not a coinbase," with zero logging and no cache of the failure. This means the 100-block maturity check added in `1dcc5bd` can be silently bypassed for a UTXO purely because of a transient chain-source hiccup — the wallet would build (and let a user sign/attempt to broadcast) a transaction spending an immature coinbase output. **Bead filed, P1.**
- **Fix (verified)** — `src/lib/server/backup.ts` `restoreBackup()`, lines 241, 284, 305, 325: silently skip malformed/duplicate rows during restore with only a code comment, no log call. An admin running a break-glass restore has zero visibility into partial data loss. (The earlier catches at lines 105/126/132 are fine — they convert parse/decrypt failures into a clear `BackupError` for the caller, not a silent drop.) **Bead filed.**
- **Fix (verified)** — `src/lib/server/portfolio.ts:158-179`: `scanWallet(...).then(..., () => null)` / `scanMultisig(...).then(..., () => null)` — any rejection scanning a wallet for the dashboard is converted to `null` with **zero logging**, silently dropping that wallet from the portfolio total. A user could see a wrong (understated) balance with no error indicator and no log trail. **Bead filed.**
- **Fix** — `src/lib/hw/trezor.ts:1105-1129` (multisig-change-output fallback) and `:1242-1255` (`selectMultisigKeyForDevice` cosigner-xpub matching): exception during multisig-change verification or cosigner-key xpub parsing is silently discarded — a genuine "policy doesn't match" bug and a benign "unrelated recipient" case are indistinguishable, and a malformed stored xpub surfaces only as a generic `wrong_device` error, misleading the user into thinking they plugged in the wrong hardware wallet. Consistent with a systemic gap: **no `console.error`/`console.warn` exists anywhere in `src/lib/hw/*`**, so even best-effort cleanup swallows leave zero trace if they fail unexpectedly. **Bead filed.**
- **Note** — `src/lib/server/logger.ts` (`RotatingFileStream`, several sites): empty catches are intentional and correctly commented ("never let a log write crash a request"). Correct design, but there's no secondary signal (e.g. a one-time stderr write) if file-logging silently dies — an operator relying solely on `/admin/logs` would see nothing and no reason why.
- **Note** — `src/lib/server/addressWatcher.ts`: 7 empty/lightly-commented catches in a background watcher that drives real user notifications (`tx_received`, `key_health_due`); worth a follow-up pass confirming each failure path logs at least at `warn` somewhere up its call chain.
- **Note** — `chain/index.ts`'s `fetchPublicBtcUsdPrice`: catches a public price-fetch failure and sets `usd = null` with no log at all (not even debug) — a persistent outage would be invisible; low stakes (display-only).

### 2.2 Caught-but-not-logged-or-rethrown

Covered inline above (electrum resubscribe, coinbaseScan, backup restore, portfolio scans are the load-bearing findings). Additional verified findings from a deeper follow-up pass over all 92 files in `src/lib/server`:

- **Fix** — `src/lib/server/notifications.ts` `notify()` (lines ~172-206): the outer try/catch wraps both the in-app activity write and the entire external-channel enqueue loop. If the DB insert throws partway through enqueueing external channels, the in-app record has already succeeded but **no external channel ever receives the alert** — visible only as a single generic `log.error` line. `notify()` returns `void`, so callers for `tx_large`, `security_failed_login`, `admin_restore`, `backup_missing`, and `key_health_due` have no way to detect a partial failure. Compounded by `rateLimit.ts`'s `noteLoginFailure()` calling `notify()` with no local guard of its own. **Bead filed, P1** (this is the alerting path for security events — a `security_failed_login` notification silently vanishing is a real gap).
- **Fix (verified)** — `src/routes/api/wallets/[id]/transactions/[txId]/broadcast/+server.ts:19` and `src/routes/api/wallets/multisig/[id]/transactions/[txId]/broadcast/+server.ts:23` both do `await readJson<{psbt?: string}>(event).catch(() => ({psbt: undefined}))`. `readJson` is specifically designed to turn a malformed JSON body into a `400 Invalid JSON body` response — but here that thrown error is caught and discarded, so a malformed request body on the **broadcast** endpoint (the most irreversible action in the app) silently proceeds as "no PSBT attached" instead of surfacing a clear 400. **Bead filed.**
- **Note** — `src/lib/server/bitcoin/*` (9 files: `psbt.ts`, `multisigPsbt.ts`, `multisig.ts`, `xpub.ts`, `spv.ts`, `coinbaseScan.ts`, `walletScan.ts`, `signingMass.ts`, `wallets/multisig.ts`) — the module tree that does the actual PSBT construction, multisig math, and wallet scanning — has **zero logging integration of any kind** (no `childLogger`/`logger` import in any of the nine files). Every one of its ~22 catch blocks either rethrows a hand-authored typed error (discarding the original cause) or swallows to a fallback value with nothing ever reaching pino. Consistent with §3.6's "library layer has no safety net" observation, but confirmed here to be total, not partial, across the highest-stakes module in the codebase.
- **Note** — `src/lib/server/multisigScan.ts`'s `collectMultisigTxs` silently drops undecodable addresses and failed tx-detail fetches from a multisig's computed transaction history/balance deltas, unlogged — could understate a multisig's reported balance/history during a partial chain-data outage with no accompanying indicator.
- **Note** — `src/lib/server/webauthn.ts:181` `parseCookie()` returns `null` on a malformed WebAuthn challenge cookie — indistinguishable from "no cookie sent," with no audit trail of a possible tampering attempt.
- **Note** — `src/lib/server/secretKey.ts`'s `decryptSecret()` and `src/lib/server/backup.ts`'s `decryptBackup()` both correctly rethrow typed errors rather than swallowing, but neither logs the underlying GCM auth-tag failure — a tampered ciphertext or wrong-passphrase event against key material or a downloaded backup currently leaves no server-side audit trail, which would help if repeated failures indicated a brute-force attempt.
- **Note** — `src/lib/server/db.ts` has ~30 unguarded schema-migration statements at module-load time, with pino used exactly once in the whole file — consistent with §2.4's "fail fast on a corrupt DB" framing, listed here as confirmation of scope. Similarly, `auth.ts`, `admin.ts`, `addressBook.ts`, `contacts.ts`, `disclosures.ts`, `settings.ts`, `rateLimit.ts`, `multisigShares.ts`, `multisigRegistrations.ts`, and `backups.ts` have no or almost no try/catch, relying entirely on route-level handling — likely an intentional layering choice, but it means none of these modules can attach structured context (a row id, a user id) to a failure before it's logged one layer up.

### 2.3 Inconsistent error response formats

Dominant pattern (large majority of routes) is mature and consistent: `json({ error, code? }, { status })` with a deliberate status-code taxonomy (400 validation, 401 auth, 403 privilege, 404 missing, 409 conflict, 429 rate-limit, 500 server, and a correctly-modeled 502 for upstream chain-source failures in the PSBT-build route).

- **Refactor** — `src/lib/server/api.ts`'s shared `requireUser`/`requireAdmin`/`readJson` helpers throw SvelteKit's native `error()`, producing `{ message: string }`, while every hand-written route error uses `{ error: string }` via `json()`. Since every route uses at least one of these helpers, this is the single most-repeated inconsistency in the codebase — a client checking only `body.error` gets `undefined` for the very common 401/403/400 cases these helpers produce. Confirmed by direct grep: 64 of 91 route files use `json({error: ...})`, zero use `json({message: ...})` on their own business logic — the `{message}` shape appears *only* via the three shared guard helpers. Worth normalizing.
- **Fix (verified)** — `MultisigError` is mapped to HTTP **400** in `wallets/multisig/+server.ts`, `wallets/multisig/[id]/address-detail/+server.ts`, and `wallets/multisig/import/+server.ts`, but to HTTP **500** in `wallets/multisig/[id]/caravan/+server.ts`, `wallets/multisig/[id]/coldcard/+server.ts`, and `wallets/multisig/[id]/descriptor/+server.ts` — the identical typed validation error is a client error in some export routes and a server error in others. Similarly, the generic upstream-failure fallback is **502** in the large majority of scan/broadcast/build routes but **500** in `wallets/[id]/transactions/[txId]/bump/+server.ts` for the equivalent case, and `api/address/[address]/+server.ts` maps "not a valid Bitcoin address" (a validation error) to **404** rather than the 400 every other input-validation path uses. **Bead filed** (fold into the response-envelope normalization work).
- **Note** — SMTP test routes intentionally return HTTP 200 with `{ ok: false, error }` bodies rather than 4xx/5xx (the result is a domain outcome, not an HTTP failure) — internally consistent, just a deliberate deviation worth documenting as such rather than an oversight.
- **Note** — `api/health` uses `{ status: 'ok'|'degraded' }` — justified for an infra liveness probe.

### 2.4 Missing try/catch around async operations

- **Note** — `email.ts`'s `readInstanceSmtpConfig()`/`smtpIsAvailable()` call `getSetting()` with no local try/catch; a throw there is caught one layer up in the notification queue's generic handler, but gets misclassified as a retryable SMTP failure instead of a distinguishable settings-read error — low practical impact, contained blast radius.
- **Note** — `src/lib/server/db.ts`'s startup-time schema migrations have no surrounding try/catch — arguably correct (fail fast on a corrupt DB rather than run half-migrated), but produces a raw Node stack trace in `docker logs` with no operator-friendly framing for a self-hosting non-expert.
- **Note** — `src/routes/api/events/+server.ts`'s heartbeat `setInterval` callback doesn't guard against `getChain()` itself throwing — low risk, but an uncaught throw inside a Node `setInterval` callback crashes the process by default.

### 2.5 Leaking internal details to users

- **Fix** — `src/routes/api/notifications/channels/email/test-smtp/+server.ts:100-103` and `src/routes/api/admin/notifications/test-smtp/+server.ts:23-26`: both return raw `err.message` from an uncaught SMTP-connection exception verbatim to the client. The user-facing test-SMTP route in particular accepts unsaved, user-typed host/port with no SSRF guard (unlike `webhook.ts`), so raw connection-error text could function as a mild internal-network reconnaissance oracle. **Bead filed.**
- **Fix (verified)** — `src/lib/server/wallets.ts:160-165` (`createWallet`): catches a DB insert failure, converts a UNIQUE-constraint violation to a friendly message, but `throw e` (raw) for any other cause — which `src/routes/api/wallets/+server.ts:19-24` then forwards verbatim as `e.message` at 400. A `NOT NULL constraint failed: wallets.script_type`-style or disk-full driver error would reach the client unfiltered. **Bead filed** (fold into the same fix as the SMTP leaks — "stop forwarding raw driver/exception text on unrecognized error paths").
- **Note** — The four `src/routes/api/stateless/*` routes (which accept untrusted, pasted PSBT/Caravan/descriptor text) fall back to raw `e.message` at 502 for any exception not matching one of four known domain-error classes — the highest-exposure instance of this pattern given the input is attacker-influenced, though PSBT/descriptor parser exceptions are unlikely to contain sensitive data. Same root cause as the SMTP/wallets.ts leaks above; worth including in the same cleanup.
- **Note** — `wallets/[id]/psbt/+server.ts:80`'s final fallback (`e instanceof Error ? e.message : ...`) is a narrower version of the same class — only hit for genuinely unrecognized exceptions (already logged first), but worth tightening since "unexpected" exceptions are exactly the ones most likely to contain something sensitive. The same pattern recurs across most scan/build routes via inline checks and the shared `chainErrorMessage()`/`statelessErrorInfo()` helpers — consolidating to one reviewed "safe-to-forward" classifier instead of ~50 independent call sites would close this class of finding in one place rather than piecemeal.
- **Note (strength)** — Everywhere else sampled, the codebase deliberately maps errors to hand-written, reviewed messages rather than forwarding `.message`. No SQL fragments were found leaking anywhere.
- **Note (strength)** — The `handleError` hook itself returns only a fixed `{ message: 'Something went wrong', errorId }` in all environments — the safety net does not leak; the leaks above happen in application code before reaching it.

### 2.6 The SvelteKit error hook (`src/hooks.server.ts`)

Read in full — a genuine strength of the codebase. Scoped correctly to 5xx only, generates a short `errorId` for support correlation, logs the full error with a **redacted** request path (txids/addresses truncated before hitting logs — a thoughtful privacy design for a Bitcoin app), and never varies its client-facing message by environment (no dev/prod stack-trace asymmetry).

- **Note** — `bootstrapAdminFromEnv()` failures at startup (lines 15-19 area) log via `errLog.error` but the app continues running with no admin bootstrapped and no signal beyond a log line an Umbrel/Docker operator may never check — for a self-hosted app, "operator can't log in at all" is a total-lockout failure mode that arguably deserves louder surfacing (startup banner, `/health` degradation flag) than an ordinary log line.

### 2.7 Unhelpful user-facing error messages

The codebase's hand-written domain messages (PSBT/signing/backup/auth) are notably specific and good — well above median. The generic-message problem is concentrated in a small number of client-side Svelte fallbacks:

- **Fix** — `src/routes/(app)/wallets/multisig/new/+page.svelte:294-298`'s `callAction()` helper backs three distinct operations (adding a cosigner key, importing a Caravan config, previewing an address) with one shared `'Something went wrong — try again.'` fallback and no `errorId` — exactly the setup flow a self-hosting non-expert is most likely to get stuck in, with no path forward if retrying doesn't help. **Bead filed.**
- **Note** — Similar generic fallbacks (with no `errorId`) appear in the passkey-recovery flow (`src/lib/passkey.ts:36`, `src/routes/(auth)/recover/+page.svelte:95,132`) and two bare file-read catches (`send/+page.svelte:410`, `ColdCardSigner.svelte:74`) that don't extract `err.message` unlike their sibling `QrSigner.svelte`.
- **Note (deliberate, not a defect)** — `src/routes/(auth)/recover/+page.svelte`'s `GENERIC_FAILURE` message is a documented, correct anti-enumeration design (never reveals whether an email exists or which of phrase/code was wrong) — explicitly excluded from the findings above.

---

## 3. Logging

Scope: `src/lib/server/logger.ts` (pino), `src/lib/server/logStore.ts`, `src/hooks.server.ts`, all routes and `lib/server` subsystems.

### 3.1 Redaction — Fix

**No pino `redact` option is configured at all.** The only redaction anywhere is `redactPath()` in `src/hooks.server.ts`, which truncates txids/addresses/block-hashes embedded in **URL path segments** for the request-completion log line — unrelated to log-call metadata objects, which pass through completely unredacted. Nothing in `logger.ts` would stop a future `logger.error({ config }, ...)`-style call from writing a live SMTP password, xpub, PSBT, or recovery phrase straight into `data/logs/cairn.log`, which the `/admin/logs` viewer then serves back over HTTP. No current call site trips this (see 3.6), but the safety net is entirely absent for an app that handles xpubs, PSBTs, SMTP credentials, and recovery phrases. **Bead filed** — add a `redact` config covering standard secret-shaped paths (`*.password`, `*.pass`, `*.passEnc`, `*.token`, `*.secret`, `*.accessToken`, `*.xprv`, `*.mnemonic`, `*.phrase`, `*.psbt`, etc.) as defense-in-depth.

### 3.2 console.* usage

**Zero matches anywhere in `src/`**, including test files. Every server module consistently uses the pino `logger`/`childLogger`. Clean — no cleanup needed.

### 3.3 Log level correctness

Generally correct: 5xx→error, 4xx→warn, else→info in the request hook; delivery failures at `.warn` across all notification channels (consistent with "will retry" semantics); expected/transient conditions at `.debug` in `addressWatcher.ts`. No undersevere real errors found.

- **Note** — `src/routes/api/admin/restore/+server.ts:25` logs a *successful* restore at `.warn` (a deliberate, documented choice — "a restore is high-impact and social-engineerable, so it must be visible") but reads as a warning for a non-error event to anyone scanning severity; consider a dedicated audit tag instead of overloading `.warn`.

### 3.4 Chatty/noisy logging — Fix / Note

- **Fix** — `src/lib/server/electrum/client.ts` has **zero logging anywhere in the file** — no `logger` import at all. Reconnect attempts, resubscription failures (see §2.1), and per-request timeouts are completely invisible during a flaky Electrum server or network partition; an operator sees nothing in `/admin/logs` while the client silently cycles reconnects. Folded into the Electrum bead above.
- **Note** — `addressWatcher.ts`'s periodic refresh logs unconditionally at `.info` every tick regardless of whether anything changed — verify the refresh interval and consider gating on a delta if it's short.
- No per-iteration log-spam was found in any hot loop, notification queue tick, or polling path otherwise — the notification queue in particular only logs on error or once at startup, which is the right shape.

### 3.5 Request logging

`src/hooks.server.ts`'s `handle` hook logs every non-asset request exactly once with method, redacted path, status, duration, and userId, with severity scaled to status — complete and correct. Static-asset exclusion is a deliberate, reasonable noise-reduction choice.

- **Note** — No per-request correlation/trace ID exists to tie the request-completion log line to deeper log lines emitted during handling of that same request — a nice-to-have for cross-referencing, not a gap in what's captured today.

### 3.6 Missing context in log entries — Fix / Note

- **Fix** — `src/lib/server/auth.ts` and `src/lib/server/webauthn.ts` have **zero logging** at all. Failed login attempts and WebAuthn ceremony failures are invisible to the pino/`/admin/logs` pipeline entirely — for a wallet-custody app, this is exactly the kind of security-relevant event an operator needs visibility into. **Bead filed.**
- **Fix** — `src/lib/server/rateLimit.ts` (brute-force throttling for login/recovery/invites) has **zero logging** — trips are tracked only in an in-memory map and surfaced solely via in-app `notify()` to the affected user, never to the structured log. An operator watching `/admin/logs` during a credential-stuffing attempt would see nothing beyond generic 4xx request-log noise. **Bead filed** (combined with the auth.ts/webauthn.ts fix above — same root cause: security events invisible to structured logging).
- **Note** — `src/lib/server/{wallets,electrum,chain,bitcoin}/*.ts` have zero logging by design — all logging for wallet/PSBT/chain operations happens at the route layer. Likely intentional (pure library modules that throw for callers to handle), but means any new route must remember to log; there's no safety net at the library layer.
- **Note (strength)** — Everywhere logging *does* exist, context discipline is consistently good — `userId`, `multisigId`/`walletId`, and `channel`/`host` are included at nearly every call site. Only one bare-string log call with no metadata was found in the entire codebase (`nostr.ts:138`, a one-time low-stakes event) — not worth fixing.

---

## 4. Tech Debt

Scope: `src/` tree, `package.json`.

### 4.1 Dead code

The codebase is unusually clean. One real cluster:

- **Fix (decide, then act)** — `getRoster()`, `RosterMember`, `RosterStatus` in `src/lib/server/multisigRoster.ts:111,198-234`: doc comment says it's "what the sign-session view renders," but no route or page calls it — the only caller is its own test. `getSignableMultisig()` (`wallets/multisig.ts:167`) implements a different, simpler per-transaction gate against the same table instead. Looks like a sign-session roster UI that was built but never wired to a route. **Bead filed** — either wire it into the multisig sign-session page or delete it and its test.
- **Note** — `backup.ts` (full instance backup/restore) and `backups.ts` (per-wallet backup-download tracking) look like a naming collision but are legitimately distinct — not dead, just confusingly named (see §1.7).
- No orphaned `.svelte` components, and no other unused exported utilities were found in `lib/server` or `lib`.

### 4.2 TODO/FIXME/HACK/XXX comments

Exactly one genuine marker in the whole tree:

- **Note** — `src/lib/shared/signingMass.ts:131`: a well-scoped TODO to calibrate hand-tuned signing-time constants against real hardware once an e2e harness exists. Non-urgent, affects UI time estimates only, not fund safety. Worth a low-priority follow-up bead once that harness exists.
- (Four other regex hits were false positives — literal `XXXX` placeholder strings in invite-code/recovery-code format docs, not tech-debt markers.)

### 4.3 Duplicated logic — Refactor

- **Refactor** — Numeric route-param validation (`Number.isInteger(id) && id > 0`) is reimplemented near-identically in at least 7 route files. Extract a shared `parsePositiveIntParam()` into `src/lib/server/api.ts`.
- **Refactor** — PSBT recipient + coin-control (`onlyUtxos`) body-parsing is byte-for-byte identical across `wallets/[id]/psbt`, `wallets/multisig/[id]/psbt`, and `stateless/psbt` routes. Extract to a shared parser.
- **Refactor** — `BroadcastError`/`BumpError`/`PsbtError` code-to-HTTP-status mapping is inlined per-route in at least 2 places; a shared `mapErrorToStatus()` or a `code`→status map on each error class would remove the duplication.
- **Note** — Six-plus near-identical custom error classes (`PsbtError`, `BroadcastError`, `BumpError`, `InvalidPsbtError`, `AddressBookError`, `ContactError`) repeat the same boilerplate constructor — a shared base class would trim ~10 lines each, not urgent.
- **Note** — DB transaction BEGIN/COMMIT/ROLLBACK is duplicated in exactly 2 places today — worth a `withTransaction()` helper if a third shows up.

### 4.4 Inconsistent patterns across similar modules — Note

- Dominant API-route pattern (auth check → validation → business logic → typed-error response) is consistent across ~85-90% of sampled routes; some validate inline at the route, others push it into the business-layer function — no bug, just no documented convention.
- All 5 notification channels correctly implement the same `NotificationChannelPlugin`/`ChannelSendResult` interface with sensible per-channel retryable/terminal classification; only cosmetic naming/structure variance in internal config-reader helpers and `test()` payload construction.

### 4.5 Overly complex functions — Refactor

Ranked by risk — none contain a known correctness bug, but size/nesting raises audit cost on fund-moving code:

- **Refactor** — `constructPsbt()` (`src/lib/server/bitcoin/psbt.ts:191-588`, ~398 lines, 5+ nesting levels) — mixes UTXO filtering, coin-control, coinbase-maturity checks, send-max, and fee calculation in one function. Extract `computeSendMaxTransaction()`, `coinSelectNormal()`, `buildInputs()`.
- **Refactor** — `constructMultisigPsbt()` (`multisigPsbt.ts:224-586`, ~363 lines) — same shape of complexity for M-of-N spends.
- **Refactor** — `combineMultisigPsbts()` (`multisigPsbt.ts:616-685`) — contains the already-shipped SIGHASH_ALL enforcement fix (confirmed present in code); the surrounding function is dense enough that extracting `validateSighash()` as its own unit would reduce audit burden on future changes to this security-critical path.
- **Refactor** — `multisigPsbtProgress()` (`multisigPsbt.ts:789-852`) — a subtle finalization edge case (minimum-signature count "boosted" to threshold after finalize strips per-input data) deserves an explicit extracted function and comment, since a bug here shows wrong signer status to users.
- **Refactor** — `parseDescriptor()`/`parseKeyExpression()` (`multisig.ts:468-614`) and `ElectrumClient.ensureConnected()` (`electrum/client.ts:113-195`) — moderate priority; the latter shares one `settled` flag across nested Promise/callback layers, a plausible spot for a race condition if modified carelessly.
- **Note (acceptable as-is)** — `addressToScriptPubKey()`/`isExplorerAddress()` (`xpub.ts`) are 4-level-nested address-format dispatchers, but the complexity is inherent to Bitcoin's encoding rules and both are well-tested; refactoring would add indirection without much clarity gain.

### 4.6 Dependency health

**No unused packages and no duplicate-purpose packages.** Every dependency was confirmed either statically imported or lazily `import()`-ed (hardware-wallet vendor SDKs, correctly isolated). Lean, well-curated dependency surface.

### 4.7 In-flight work (git status)

The untracked/modified files from git status (`secretKey.ts`, `email.ts` SMTP changes, the `[channel]` route, `db.ts`'s `DB_PATH` export, `notificationQueue.ts`'s `_internals` addition) are all part of the in-progress per-user SMTP work (`docs/PER-USER-SMTP-PLAN.md` / `cairn-l512` epic) and are well-built and reasonably tested — no tech debt introduced. `.gitignore`'s removal of `.beads/` reflects the bead tracker now being committed, consistent with current practice.

**Bottom line:** dead code and dependency debt are near-zero. The two PSBT-construction functions are the standout maintainability risk given they're fund-moving and 350+ lines each; the route-level duplication is mechanical and low-risk to fix opportunistically. No dedicated cleanup sprint is warranted.

---

## Fixes filed as beads

| Priority | Bead | Summary |
|---|---|---|
| P1 | cairn-7fmd | Coinbase-maturity check can be silently bypassed on a chain-RPC hiccup (`coinbaseScan.ts`) |
| P1 | cairn-s0p5 | `notify()` can silently drop external-channel delivery for security/tx alerts after the in-app record succeeds |
| P1 | cairn-wbmu | `auth.ts`, `webauthn.ts`, `rateLimit.ts` have zero logging — failed logins, WebAuthn errors, and brute-force trips are invisible to `/admin/logs` |
| P2 | cairn-zjih | Electrum client: silent resubscribe failure, zero logging, zero test coverage for TLS/reconnect/backoff |
| P2 | cairn-6zo7 | No end-to-end test for M=1 / M=N (unanimous) multisig quorum boundary |
| P2 | cairn-swx1 | Ledger's custom BIP-388 wire protocol has zero unit tests |
| P2 | cairn-byoz | No pino `redact` config — add defense-in-depth redaction for secrets/xpubs/PSBTs/mnemonics |
| P2 | cairn-ednl | `portfolio.ts` silently drops failed wallet scans from dashboard totals, zero logging |
| P2 | cairn-sd3n | `backup.ts` `restoreBackup()` silently skips malformed/duplicate rows, zero logging |
| P2 | cairn-yaw1 | Trezor driver silently swallows multisig-change and cosigner-xpub parse failures; no logging anywhere in `src/lib/hw/*` |
| P2 | cairn-1yw7 | Broadcast routes silently swallow a malformed JSON body instead of returning 400 (`readJson(...).catch(() => ...)`) |
| P3 | cairn-6y98 | Raw driver/exception text leaks to clients on unrecognized error paths (SMTP test routes, `wallets.ts` createWallet, stateless routes) |
| P3 | cairn-8jc7 | Inconsistent HTTP status-code mapping for the same typed error across sibling routes (`MultisigError` 400 vs 500, etc.) |
| P3 | cairn-zme4 | `chain/` (Esplora) facade has zero logging anywhere |
| P3 | cairn-odq1 | Multisig-creation wizard collapses 3 distinct operations into one generic error message with no errorId |
| P3 | cairn-9hq7 | Test hygiene: `notifications.test.ts` mutates shared `DEFAULT_PREFERENCES` without try/finally |
| P3 | cairn-vp78 | Test hygiene: `electrum/client.test.ts` uses a real-timer timeout assertion (CI-flaky) |
| P3 | cairn-b9so | Orphaned sign-session roster code (`getRoster`, `RosterMember`, `RosterStatus`) — wire in or delete |

All 18 beads are tagged with the `audit-2026-07-05` label for easy lookup (`br search "audit-2026-07-05"` or `br list --labels audit-2026-07-05`).
