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
logins per email and 20 per IP; 10 invalid invite codes per IP on registration.
Exceeding a limit returns **429** with a `retry-after` header (seconds) and
`{ "error": "Too many attempts. …", "code": "rate_limited" }`.

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

### POST /api/auth/register

No auth. Body: `{ email, password, displayName, inviteCode? }` (`inviteCode`
required when the instance is in invite-only mode; registration may be closed).

- 200 `{ "user": { "id", "email", "displayName", "isAdmin" } }` + session cookie
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
