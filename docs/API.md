# Cairn JSON API

Reference for the HTTP API under `/api`. All endpoints return JSON unless noted.

## Authentication

The API is **same-origin, session-based**. There are no API tokens or keys yet.

- `POST /api/auth/login` (or `/api/auth/register`) sets an httpOnly, `SameSite=Lax`
  session cookie named `cairn_session`, valid for 30 days.
- Every other endpoint (except `/api/health`) requires that cookie and returns
  **401** `{ "message": "Authentication required" }` without it.
- `/api/admin/*` additionally requires an admin account and returns **403**
  `{ "message": "Admin access required" }` otherwise.
- There is no `/api/auth/logout`; the web app signs out via the `POST /logout`
  page action, which clears the same cookie.

**Rate limits** (fixed 15-minute windows, in-memory, per process): 5 failed
logins per email and 20 per IP; 10 invalid invite codes per IP on registration;
20 contact requests per user and 60 per IP on `POST /api/contacts` (every
request counts, not just failures — it blunts account enumeration). Exceeding a
limit returns **429** with `{ "error": "Too many attempts. …", "code": "rate_limited" }`
(auth endpoints also set a `retry-after` header in seconds).

**Common error statuses**

| Status | Meaning |
| --- | --- |
| 400 | Invalid JSON body or bad parameter — `{ "error": "…" }` (auth errors include a `code`) |
| 401 | Not signed in |
| 403 | Not an admin (admin endpoints) |
| 404 | Malformed or unknown block / tx / address / wallet id |
| 429 | Auth rate limit hit |
| 502 | Upstream chain data source (Electrum / Esplora) unreachable — `{ "error": "…" }` |

---

## Auth

### POST /api/auth/register/password

No auth. Body: `{ email, password, displayName, inviteCode? }` (`inviteCode`
required when the instance is in invite-only mode; registration may be closed).

Passkey (WebAuthn) registration is a separate two-step ceremony:
`POST /api/auth/register/options` then `POST /api/auth/register/verify`.

- 201 `{ "user": { "id", "email", "displayName", "isAdmin" } }` + session cookie
- 400 `{ "error", "code" }` — codes: `invalid_email`, `weak_password` (min 8 chars),
  `invalid_name`, `email_taken`, `closed`, `invite_required`, `bad_invite`
- 429 on repeated bad invite codes

### POST /api/auth/login

No auth. Body: `{ email, password }`.

- 200 `{ "user": { "id", "email", "displayName", "isAdmin" } }` + session cookie
- 401 `{ "error", "code" }` — `bad_credentials` or `disabled`
- 429 after repeated failures

### GET /api/auth/me

- 200 `{ "user": { "id", "email", "displayName", "isAdmin" } }`
- 401 when not signed in

---

## Chain data

### GET /api/blocks

Query: `limit` (1–50, default 10), `before` (height; returns blocks strictly
below it, newest first).

- 200 `{ "blocks": [ { "height", "hash", "time", "txCount", "size", "weight", "medianFee", "feeRange", "miner"? } ] }`
- 400 invalid `before` · 502 chain unavailable

### GET /api/blocks/[id]

`id` is a height or a 64-hex block hash.
Query: `txpage` (0-based; when present the response also pages the block's transactions).

- 200 `{ "block": { …BlockSummary, "prevHash", "merkleRoot", "nonce", "bits", "difficulty", "version", "totalFees", "reward" } }`
  — with `txpage`: `{ "block", "txs", "total" }`
- 404 malformed id or unknown block · 502

### GET /api/tx/[txid]

`txid` is a 64-hex transaction id.

- 200 `{ "tx": { "txid", "confirmed", "blockHeight", "blockHash", "blockTime", "confirmations", "size", "vsize", "weight", "fee", "feeRate", "locktime", "version", "segwit", "rbf", "vin": [...], "vout": [...] } }`
- 404 malformed or unknown txid · 502

### GET /api/address/[address]

- 200 `{ "address": { "address", "scriptType", "confirmedBalance", "unconfirmedBalance", "txCount", "totalReceived", "totalSent", "used" }, "txs": [ { "txid", "height", "time", "fee", "delta" } ] }`
- With `?after=<txid>` (cursor: last confirmed txid of the previous page):
  200 `{ "txs": [...] }` — next page only, no address summary.
- 400 malformed `after` · 404 invalid address · 502

### GET /api/search

Query: `q` — a block height, block hash, txid, or address.

- 200 `{ "type": "block-height" | "block-hash" | "tx" | "address" | "unknown", "redirect": "/explorer/…" | null, "query": "<normalized q>" }`
  — ambiguous 64-hex strings are resolved by querying the backend. Always 200;
  unrecognized input yields `type: "unknown"`, `redirect: null`.

### Mempool

- `GET /api/mempool/summary` → 200 `{ "txCount", "vsize", "totalFees" }` · 502
- `GET /api/mempool/fees` → 200 `{ "fastest", "halfHour", "hour", "economy" }` (sat/vB) · 502
- `GET /api/mempool/projected` → 200 `{ "projected": [ { "nTx", "vsize", "totalFees", "medianFee", "feeRange" } ], "histogram": [ [feeRate, vsize], … ], "tipHeight" }` · 502

---

## Wallets (watch-only, per-user)

### GET /api/wallets

- 200 `{ "wallets": [ { "id", "name", "type": "xpub", "scriptType", "xpub", "createdAt", "balance", "unconfirmed", "lastActivity" } ], "errors": { … } }`
  (`errors` maps wallet ids to scan failures, if any)

### POST /api/wallets

Body: `{ xpub, name? }` — accepts xpub/ypub/zpub.

- 201 `{ "wallet": WalletSummary }` · 400 `{ "error" }` invalid or duplicate xpub

### GET /api/wallets/[id]

Full scan of one wallet.

- 200 `{ "wallet": WalletSummary, "addresses": [ { "address", "derivationPath", "index", "change", "used", "balance", "txCount" } ], "txs": [ { "txid", "height", "time", "delta", "fee" } ], "confirmed", "unconfirmed" }`
- 404 not the caller's wallet · 502 scan failed

### DELETE /api/wallets/[id]

- 200 `{ "ok": true }` · 404

### GET /api/wallets/[id]/addresses

- 200 `{ "addresses": [...] }` (same shape as above) · 404 · 502

### GET /api/wallets/[id]/transactions

- 200 `{ "txs": [...] }` newest first · 404 · 502

### POST /api/wallets/[id]/receive

Advances the receive cursor and returns the next unused address.

- 200 `{ "address", "derivationPath", "index" }` · 404 · 502

### GET /api/portfolio

Aggregate across all of the caller's wallets (scans run concurrently, cached per xpub).

- 200 `{ "portfolio": { "walletCount", "scannedCount", "confirmed", "unconfirmed" } }`
  — or `{ "portfolio": null }` when the user has no wallets.

---

## Multisig wallets (per-user)

Multisig wallets live under `/api/wallets/multisig/` and are watch-only in the
same sense as single-sig wallets: Cairn holds only extended **public** keys and
coordinates signing (PSBT construction, quorum tracking, broadcast). All
endpoints require the session cookie and are scoped to the caller; `[id]` that
isn't the caller's returns **404**. Creating/importing is gated by the
`multisig_create` / `wallet_config_import` feature flags (**403** with the flag's
message when disabled).

### GET /api/wallets/multisig

- 200 `{ "multisigs": [ MultisigSummary ] }` — the caller's multisigs (owned and
  shared with them), each with quorum, script type, balance and last activity.

### POST /api/wallets/multisig

Body: `{ name, threshold, scriptType?, keys }` — create a multisig. All
cryptographic validation happens in `createMultisig` (a real address is derived
before anything is stored); `MultisigError` messages surface verbatim.

- 201 `{ "multisig": MultisigSummary }` · 400 `{ "error", "code" }` · 403 (flag off)

### POST /api/wallets/multisig/import

Body: `{ descriptor | source, create?, name? }` — parse an existing multisig
definition (output descriptor **or** Caravan/Unchained wallet-config JSON, which
is also what Cairn's own JSON backup emits, so export→import round-trips).

- Default: 200 `{ "imported": <wizard prefill> }`
- With `create: true`: 201 `{ "multisig": MultisigSummary }`
- 400 `{ "error", "code" }` (malformed / private-key material refused) · 403

### GET /api/wallets/multisig/[id]

- 200 `{ "multisig": MultisigSummary, "keys": [...], "addresses": [...], "txs": [...], "confirmed", "unconfirmed" }` · 404 · 502 scan failed

### DELETE /api/wallets/multisig/[id]

- 200 `{ "ok": true }` · 404

### GET /api/wallets/multisig/[id]/receive

`?after=N` requests a fresh address strictly beyond the one on display, clamped
to the gap-limit window. Advances the receive cursor.

- 200 `{ "address", "derivationPath", "index" }` · 404 · 502

### GET /api/wallets/multisig/[id]/address-detail

Query: `chain` (0|1), `index`. Pure on-demand derivation (no network, nothing
stored) for one address's verification detail.

- 200 `{ "witnessScript"?, "redeemScript"?, "pubkeys": [...], "keys": [ { …path } ] }` · 404

### GET /api/wallets/multisig/[id]/utxo-mass

- 200 `{ "masses": [ { "txid", "vout", "parentVsize", "tier", "source" } ] }` —
  signing-mass classification for the current confirmed UTXOs (a coin whose
  parent can't be fetched is simply absent). · 404 · 502

### POST /api/wallets/multisig/[id]/psbt

Body: `{ recipients: [ { address, amount: sats | "max" } ], feeRate, onlyUtxos?: [ { txid, vout } ] }`.
Constructs an unsigned multisig PSBT and saves it as a draft.

- 200 `{ "transaction": SavedMultisigTransaction, "details": ConstructedMultisigPsbt, "progress": { …0 of M } }`
- 400 `{ "error", "code" }` · 404 · 502

### Transactions

- `GET /api/wallets/multisig/[id]/transactions` → 200 `{ "transactions": [...] }` newest first
- `GET  …/transactions/[txId]` → 200 `{ "transaction", "summary", "progress": { required, collected, complete, signedFingerprints, remainingFingerprints } }`
- `PATCH …/transactions/[txId]` — attach one signer's PSBT (merged into the stored
  draft; idempotent, same-tx guarded) → 200 `{ "transaction", "progress" }`; a
  `{ status }`-only body adjusts lifecycle state without touching the PSBT
- `DELETE …/transactions/[txId]` → 200 `{ "ok": true }`
- `GET  …/transactions/[txId]/file` → the current combined PSBT as a binary
  `.psbt` download (what ColdCard / Sparrow / Electrum read)
- `POST …/transactions/[txId]/broadcast` — finalize + broadcast a quorum-complete
  tx (optional last signed PSBT in the body). Refuses below quorum
  (`"X of M signatures collected"`) and refuses a tx that already carries a txid;
  the broadcast is claimed atomically so concurrent calls can't double-send →
  200 `{ "txid" }` · 400 · 404
- `POST …/transactions/[txId]/bump` — build an RBF replacement at a higher fee
  rate for a broadcast-but-unconfirmed tx (owner-only) → 200 `{ "transactionId" }`

### Exports / backups

Each of these counts as a config backup (`markBackedUp`) where noted:

- `GET /api/wallets/multisig/[id]/caravan` — Caravan/Sparrow-compatible JSON config
- `GET …/descriptor` — both checksummed descriptors as JSON; `?download=1` for a
  plain-text backup file
- `GET …/coldcard` — the ColdCard multisig registration file (also Passport /
  Keystone / SeedSigner)
- `GET …/backup-pdf` — the printable black-and-white "break glass" PDF (quorum,
  keys, receive descriptor, and a QR of the Caravan config)
- `GET …/history.csv` — transaction history as CSV (same columns as single-sig)

### Ledger BIP-388 policy registration

- `GET /api/wallets/multisig/[id]/ledger-registration` → 200 `{ "registrations": [...] }`;
  with `?fp=<masterFp>` → 200 `{ "registration": {...} | null }`
- `POST …/ledger-registration` body `{ masterFp, policyName, policyHmac, policyId? }` —
  persist an on-device registration (upsert per `(multisig, masterFp)`) → 200

### POST /api/wallets/multisig/[id]/keys/[keyId]/verified

Record a Casa-style key-health check. Body is one of:

- `{ method: "device", xpub, fingerprint }` — a live hardware re-read; the server
  compares it against the stored row (canonicalizing SLIP-132 aliases) →
  200 `{ verified: true, keyId, lastVerifiedAt }` on a match, or
  `{ verified: false, fingerprintMatch, xpubMatch, expectedFingerprint, deviceFingerprint }` on a mismatch
- `{ method: "manual" }` — a user-confirmed manual verification (ColdCard / QR /
  file keys Cairn can't re-read) → 200 `{ verified: true, keyId, lastVerifiedAt }`

### Sharing (collaborative custody)

- `GET /api/wallets/multisig/[id]/shares` → 200 `{ "shares": [...] }`
- `POST …/shares` body `{ contactUserId, role: "viewer"|"cosigner", keyIds?: number[] }` —
  share with an accepted contact → 200 · 400
- `PATCH …/shares/[shareId]` body `{ role?, keyIds? }` — change role / reassign keys → 200
- `DELETE …/shares/[shareId]` → 200 `{ "ok": true }`

---

## Events

### GET /api/events

Server-Sent Events stream (`Content-Type: text/event-stream`) of new-block
notifications. Requires the session cookie.

- `event: block` / `data: { "height": <n> }` — sent once on connect with the
  current tip, then on every new block.
- `event: error` / `data: { "message": "…" }` — the backend subscription
  failed; the stream then ends (EventSource will reconnect).
- Comment heartbeats (`: ping`) every 25 s keep proxies from idling the
  connection out.

---

## Admin (session cookie + admin account; 403 otherwise)

### /api/admin/users

- `GET` → 200 `{ "users": [ { "id", "email", "displayName", "isAdmin", "disabled", "createdAt", "lastLogin", "walletCount" } ] }`
- `POST` body `{ id, disabled?, isAdmin? }` — update flags → 200 `{ "users": [...] }` · 400 (e.g. demoting/disabling the last admin)
- `DELETE` body `{ id }` → 200 `{ "ok": true }` · 400 (missing id, or your own account)

### /api/admin/invites

- `GET` → 200 `{ "invites": [ { "id", "code", "label", "createdBy", "maxUses", "usedCount", "expiresAt", "createdAt", "status" } ] }`
- `POST` body `{ count?, label?, maxUses?, expiresDays? }` → 201 `{ "invites": [<created>] }`
- `DELETE` body `{ id }` — revoke → 200 `{ "ok": true }` · 400

### /api/admin/settings

- `GET` → 200 `{ "settings": { "registrationMode", "connectionMode", "electrumHost", "electrumPort", "electrumTls", "esploraUrl", "coreRpcUrl", "coreRpcUser", "coreRpcPass" } }`
  (`coreRpcPass` is never echoed back)
- `PUT` body: any subset of those keys → applies them, reconfigures the chain
  backend live, returns 200 `{ "settings": … }`. An empty `coreRpcPass` means
  "keep the stored password".

---

## Health

### GET /api/health

**Unauthenticated** (for orchestrators and reverse proxies). Discloses liveness only.

- 200 `{ "status": "ok" }` · 503 `{ "status": "degraded" }`
