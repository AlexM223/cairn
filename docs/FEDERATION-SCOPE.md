# Heartwood Federation — Scoping Document

**Instance-to-instance PSBT coordination for non-custodial collaborative multisig.**

Status: SCOPING (2026-07-13)
Epic: cairn-cz3q

---

## 1. Summary & Scope

Federation is the ability for one Heartwood instance to send a PSBT to another Heartwood instance — a cosigner's own instance — for signing, over the network, with real-time in-app notification. It replaces email, file transfer, and QR-code sneakernet as the way collaborative-multisig participants exchange partially-signed transactions.

**Federation is non-custodial.** Each instance holds only its own keys. PSBTs travel between instances for signing; funds never do. Nobody holds anyone else's money. There is no e-cash, no Fedimint, no Chaumian mint, and no Lightning gateway involved anywhere in this design.

> **Note on scope history:** this document supersedes an earlier framing of "federation" built around Fedimint-style custodial e-cash. As of 2026-07-13 the scope has changed to sovereign multisig coordination — instances coordinating signatures over PSBTs they each independently verify, with no shared custody at any point. See [Section 11](#11-alternatives-considered-brief) for why the e-cash framing was rejected.

**Reference model:** [Bastion](C:\dev\bastion)'s federation protocol is our starting point. Bastion is an audited, 63-live-test peer-to-peer PSBT coordination system for on-chain multisig. It has no Fedimint or e-cash code anywhere — its "federation" is exactly this same PSBT-coordination problem, already solved and battle-tested. Section 2 summarizes what it gives us.

**Hard design constraint: UI-first.** Federation ships with a complete GUI from day one. Bastion shipped its federation as a complete backend protocol with **zero** end-user UI — only an admin on/off toggle and a read-only peer table — and is now stuck retrofitting UX onto a protocol that was never designed with a user journey in mind. Heartwood must not repeat that mistake. Every unit of backend work in this plan is paired with the UI that makes it usable (see [Section 6](#6-user-journeys-ux-first)).

---

## 2. Reference: What Bastion Provides (the proven model)

Bastion's federation protocol is the proven starting point. Summary:

**Identity.** Each instance has an ed25519 keypair derived from a persisted seed (`getOrCreateSecret('federation_seed')`). `instanceId = sha256(pubkey)[:16 hex]`. The public key travels base64url-encoded wherever peers need to reference each other.

**Handshake.** `POST /handshake` is the *only* tokenless endpoint, and it is rate-limited. It exchanges a signed nonce and mints per-direction bearer tokens — each side mints the token the *other* side must present on subsequent requests. A re-handshake rotates both tokens. Every other request authenticates via `X-Federation-Instance` + `X-Federation-Token` headers, compared in constant time.

**Invites.** The inviting party picks one of their own keys (fingerprint + xpub + label — **never** a derivation path; there is structurally no path column). The invite code is 24 bytes, stored as a sha256 hash only (never in plaintext), and shipped to the invitee as a portable base64url blob. Redemption is atomic and single-use, and results in a reciprocal key exchange.

**Vault build.** The multisig vault is a `sortedmulti` descriptor using fingerprint-only origins (`[xfp]xpub/0/*`), checksummed with a pure-JS BIP-380 implementation that has been Core-verified. Critically, there is **no peer-to-peer vault push** in Bastion — each side independently rebuilds the identical descriptor from the keys it has, and the two sides are correlated only by the resulting descriptor bytes matching.

**PSBT sessions.** A coordinator opens a session and pushes the PSBT to every peer holding a key in the vault. A receiver stores it and — in Bastion — can relay it onward multi-hop. Signing is a structural combine via bitcoinjs. "Collected" signatures = the minimum partial-signature count across all inputs; reaching quorum flips the session to complete. Bastion's fix for its own IDOR bug was to dedupe sessions on byte-identical unsigned PSBTs.

**Security posture worth inheriting as a checklist:**
- 404, never 403, on anything that could leak existence (no peer/session/resource enumeration)
- Constant-time token comparison
- Self-peer handshake rejection
- Blocked-peer requests refused outright
- Fingerprints redacted from logs
- Rate limits always on, independent of any regtest/security auto-disable switch
- Protocol version gate on major-version mismatch
- Descriptor exchange omits derivation paths
- Key/invite sharing is contacts-gated
- Every protocol action writes an audit log entry

**Bastion's own gaps — do not inherit these:**
- `broadcast` and `cancelled` session statuses exist in the schema but no code path ever sets them
- Local same-instance cosigning and federation cosigning are two entirely disconnected systems with zero cross-references between them
- Notification fan-out only fires on `/sign`, never at session creation — so the *first* cosigner in a chain is never notified that a signature is even wanted
- No application-layer encryption — a relaying instance in a multi-hop chain sees PSBTs in cleartext

---

## 3. Cairn/Heartwood Integration Map

| Area | Where it lives today | How federation plugs in |
|---|---|---|
| **Routes / nav** | Feature areas are siblings under `src/routes/(app)/`; nav is a flag-gated `$derived` array in `+layout.svelte:29-44`; `MobileTabRow` caps at 4 tabs. | Federation is **not** a 5th tab. Peer setup lives at `settings/federation`. Custody UX lives inside the existing `wallets/multisig/[id]` subtree. Incoming signature requests surface via the notification/activity feed and deep-link into the vault. This sidesteps the mobile-tab cap and — deliberately — forces the UI to unify with existing multisig screens rather than fork a parallel one. |
| **Wallet architecture** | Single-sig (`wallets/[id]`) and multisig (`wallets/multisig/[id]`) are deliberate parallel stacks (`db.ts:322`); every cross-cutting surface hardcodes `'wallet'\|'multisig'` (`portfolio.ts:549`, `backup.ts:37-49`, `accountData.ts`, `balance_snapshots.wallet_kind`). | Federation extends the **multisig** stack only. It is not a third wallet kind. |
| **Schema** | `db.ts` is one file; idempotent `CREATE TABLE IF NOT EXISTS` at boot; no migration framework (one-shot migration modules run from `hooks.server.ts` init when needed). | New federation tables follow the same idiom (Section 5.2). |
| **Feature flags** | `registry.ts` is a one-line-append registry; flags **must** ship `defaultEnabled: true` (flags can never ship pre-disabled); `requireFeature(event, key)` in `api.ts:99` gates endpoints. | Because the flag can't ship disabled, the `federation` flag governs **UI visibility only**. A separate admin opt-in setting, `federation_enabled` (default **OFF**), gates all actual networking. This split is load-bearing — see Security F15. |
| **Secrets** | `secretKey.ts` does AES-256-GCM + HKDF-labeled derivation; `instance_secrets` is a global k/v store; the per-scope-secret template is `deviceKeys.ts` (`UNIQUE(user_id, fingerprint, purpose)`). | `federation_seed` lives in `instance_secrets` via `getOrCreateSecret`; per-peer bearer tokens need their own encrypted-at-rest treatment (Security F16). |
| **Background services** | `hooks.server.ts` `init()` starts watchers that are try/catch-isolated, unref'd, and idempotent; the template is `addressWatcher.ts` (best-effort, never throws, dedupe table). Umbrel sibling-app probing precedent: `umbrelProbe.ts` / `umbrelCoreProbe.ts`. | `federationWatcher.ts` follows the same template (Section 5.4). |
| **Notifications** | `notify()` writes an `events` row and emits on `notifyBus` (EventEmitter) → SSE at `/api/notifications/stream` → outbound channels per user prefs. Event types are a flat string union + `DEFAULT_PREFERENCES`. The activity feed reads the `events` table automatically. | **Real-time delivery is free.** Federation events ride this existing bus; no new transport needed for in-app notification. |
| **Backup / restore** | `backup.ts`'s `BackupData` has a hardcoded table allowlist and excludes `instance_secrets`; restore is additive and email-keyed. | New federation tables and multisig columns get added to the allowlist; tokens (bearer secrets) need encryption + re-handshake messaging on restore; `federation_seed` stays excluded like other instance secrets. |
| **Packaging** | Single Node 22 process, no child-process/sidecar precedent, ports 3000/3443, `/data` volume, `server.mjs` binds fast and inits slow. Umbrel package `heartwood-bitcoin` (ports 3217/5588) lives in the `heartwood-app-store` repo. | Federation must fit inside the existing single-process model — no new sidecar. |
| **Reusable UI** | `Amount.svelte` handles sats/BTC/fiat display. | Reused directly in the remote-review screen (J5) and cosigner status strip (D3). |
| **PSBT verification seam** | `src/lib/server/bitcoin/psbt.ts` already has `summarizePsbt()` and `validateRecipientsAndFeeRate()`, with an existing `hostilePsbts.test.ts`. | This is the load-bearing seam for cosigner-side independent verification (Security F1) — reuse, don't reinvent. |
| **Lightning** | None exists. | Not in scope; greenfield, nothing to reuse and nothing to worry about breaking. |

---

## 4. Transport Decision

| Option | Works behind NAT/CGNAT | Zero-config | Latency | Dependency | Verdict |
|---|---|---|---|---|---|
| **Tor hidden service** | Yes, NAT/CGNAT-immune | Near-zero on Umbrel (Tor already shipped) | High (500ms+/msg, multi-second cold starts, periodic outages) | Tor daemon, already present | **MVP default.** Precedent: BTCPay Server and Start9 both use onion services for instance reachability. |
| **Tailscale / WireGuard** | Yes | No — every household needs accounts + a shared tailnet (heavy setup ritual) | Low | Tailscale/WireGuard client | Advanced/unsupported fallback only. |
| **Manual clearnet** (port-forward / DDNS) | No — CGNAT blocks many residential users outright | No | Low | None beyond router config | Escape hatch only; also directly exposes a wallet instance to the internet. |
| **Iroh** | Yes (QUIC hole-punching, dial-by-key) | Mostly | Low | Node bindings `@number0/iroh` exist but unverified parity with the 1.0 release (June 2026); native dependency; wants a self-hosted relay | Defer to Phase 2+. Notably, this is what Fedimint itself uses for the same home-NAT topology. |
| **Nostr** | Yes (relay-mediated) | Yes | Variable, unreliable for payloads | Public relay network | Bad as a PSBT pipe: relays commonly cap events at 128KB, base64 + encryption inflates PSBT size further, there's no standard chunking scheme, and no delivery guarantee. Good only as a signaling/wakeup channel. Phase 2 at most. |
| **mDNS / LAN discovery** | No | Yes, same-LAN only | Low | None | Skip — Docker's bridge networking blocks multicast, and this only ever covers same-household peers anyway. |

**Key design point:** peer `baseUrl` is modeled as an opaque URL, so the same push-model code works unmodified over `.onion` or any future URL scheme. However, **MVP must hard-refuse any non-`.onion` baseUrl** (see Security F12 and F17) — the encryption posture and rate-limiting posture below are both predicated on Tor being the only transport in play.

**Ship-blocker spike:** whether umbrelOS 1.x still exposes a per-app `.onion` address (`APP_*_HIDDEN_SERVICE` via `exports.sh`) is **unverified** and must be confirmed before committing to Tor as the default transport. See [Open Question 1](#9-open-questions-for-alex).

**Phasing precedent:** this matches an existing internal decision (from Alex's own debate log on this feature class) to phase gradually — Phase 1 is Tor-only, experimental, and rate-limited; recovery design work happens before any clearnet or real-fund exposure is considered.

---

## 5. Architecture

### 5.1 Protocol deltas from Bastion

| ID | Bastion | Heartwood | Why |
|---|---|---|---|
| **D1** | Multi-hop relay: a coordinator's push can be relayed onward through intermediate peers. | Drop relay entirely; direct **star topology** — the coordinator pushes to each peer directly, and each peer returns exactly one hop. | Family vaults top out at ~4 directly-connected parties. Relay adds a cleartext-relay privacy problem and a forged-`relayPath` attack surface for zero benefit at this scale. This also eliminates Bastion's transitive-trust surface, where an intermediary instance can see PSBTs belonging to other participants. |
| **D2** | No application-layer encryption; relies on transport alone. | Skip app-layer encryption **in MVP only** — justified *only* because MVP is Tor-only (`.onion` is itself an E2E-encrypted transport) combined with star topology (no untrusted relay ever sees a PSBT it isn't a party to). | Becomes **mandatory** the moment any supported clearnet transport ships (Phase 2): libsodium box addressed to each peer's ed25519 key. This decision is contingent on the onion-availability spike (Security F12) — if Tor isn't available, this delta is void. |
| **D3** | Vault descriptors are never pushed; each side silently rebuilds and correlates by descriptor bytes. | **Add a vault-manifest push.** The coordinator pushes a manifest so the cosigner's instance auto-creates the matching multisig row (`origin='remote'`) and raises a notification. | Cosigner must explicitly accept, and only from an already-handshaked peer, with the resulting descriptor byte-identical and BIP-380-checksum-verified on both sides. This is the single biggest UX win over Bastion's silent-rebuild model — the user is never asked to manually verify a raw descriptor. |
| **D4** | `broadcast`/`cancelled` statuses exist in schema but are dead code. | Wire them up: broadcast fans out a notification to all peers in the vault; cancel is a real, reachable state. | Closes a known Bastion gap rather than porting it forward. |
| **D5** | Local same-instance signing and federation signing are two disconnected systems. | **Unify** local and remote cosigning into one spend flow. | This is the core structural ask of the whole feature — see 5.3. |

### 5.2 Data model

Follows the existing `db.ts` idiom — idempotent `CREATE TABLE IF NOT EXISTS` at boot, no migration framework.

```sql
-- Peer registry
CREATE TABLE IF NOT EXISTS federation_peers (
  instance_id       TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  base_url          TEXT NOT NULL,       -- opaque; .onion only in MVP
  public_key        TEXT NOT NULL,       -- base64url ed25519 pubkey
  protocol_version  INTEGER NOT NULL,
  local_token       TEXT,                -- token WE present to THEM — encrypted at rest (F16)
  peer_token        TEXT,                -- token THEY present to US — encrypted at rest (F16)
  status            TEXT NOT NULL,       -- pending | active | blocked | tombstoned
  last_seen         INTEGER,
  created_at        INTEGER NOT NULL
);

-- Keys a peer has shared with us (their side of shared vaults)
CREATE TABLE IF NOT EXISTS federation_peer_keys (
  peer_id   TEXT NOT NULL REFERENCES federation_peers(instance_id),
  xfp       TEXT NOT NULL,
  xpub      TEXT NOT NULL,
  label     TEXT,
  PRIMARY KEY (peer_id, xfp)
);

-- Shared invite engine
CREATE TABLE IF NOT EXISTS federation_invites (
  code_hash   TEXT PRIMARY KEY,   -- sha256 of the invite code; code itself never stored
  xfp         TEXT NOT NULL,
  xpub        TEXT NOT NULL,
  label       TEXT,
  max_uses    INTEGER NOT NULL DEFAULT 1,
  uses        INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Audit log
CREATE TABLE IF NOT EXISTS federation_audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  direction TEXT NOT NULL,     -- inbound | outbound
  peer_id   TEXT,
  action    TEXT NOT NULL,
  result    TEXT NOT NULL,
  detail    TEXT
);

-- PSBT coordination sessions
CREATE TABLE IF NOT EXISTS federation_psbt_sessions (
  session_uuid       TEXT PRIMARY KEY,
  origin             TEXT NOT NULL,   -- local | remote
  origin_peer_id     TEXT,
  origin_ref         TEXT,            -- e.g. local multisig_transactions.id
  unsigned_psbt      TEXT NOT NULL,
  combined_psbt      TEXT,
  status             TEXT NOT NULL,   -- open | complete | broadcast | cancelled | expired
  required_signers   INTEGER NOT NULL,
  collected_signers  INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL  -- drives federationWatcher cleanup
);

-- Extends existing multisig_keys — the unification keystone (5.3)
ALTER TABLE multisig_keys ADD COLUMN holder_type TEXT;        -- 'self' | 'local_user' | 'remote_peer'
ALTER TABLE multisig_keys ADD COLUMN holder_local_user_id TEXT;
ALTER TABLE multisig_keys ADD COLUMN holder_peer_id TEXT;

-- Extends existing multisig_transactions
ALTER TABLE multisig_transactions ADD COLUMN origin TEXT;                 -- 'local' | 'remote'
ALTER TABLE multisig_transactions ADD COLUMN origin_peer_id TEXT;
ALTER TABLE multisig_transactions ADD COLUMN origin_ref TEXT;
ALTER TABLE multisig_transactions ADD COLUMN federation_session_uuid TEXT;
-- status column widened to include: broadcast, cancelled
```

Identity seed continues to live in `instance_secrets` via `getOrCreateSecret('federation_seed')`, using a new HKDF label consistent with the `secretKey.ts` scheme.

### 5.3 Unification (one spend flow)

Bastion's fatal structural gap is that local same-instance cosigning and federation cosigning are two disconnected systems that never reference each other. Heartwood collapses them at a single seam: `multisig_keys.holder_type` / `holder_local_user_id` / `holder_peer_id`. This is the **single source of truth** for who holds each key in a vault, and it drives both the cosigner status strip (UI) and PSBT routing (backend).

**One spend flow.** The existing `wallets/multisig/[id]` → Send → sign path iterates the vault's keys:
- `holder_type = 'self'` → sign locally with the connected device
- `holder_type = 'local_user'` → in-app notify, reusing the existing `multisig_shares` cosigner ACL
- `holder_type = 'remote_peer'` → federation push to `holder_peer_id`

**One collection path.** Every signature — local or remote — lands as a partial signature in the same PSBT. The authoritative signature count comes from parsing the PSBT's partial sigs (minimum count across all inputs, counting **only** signatures matching a descriptor cosigner per Security F9). Any attribution rows (who signed, from where) are display-only metadata layered on top — never the source of truth for quorum.

**One review UI** serves both local and remote signers.

Remote peers **never** enter `multisig_shares` — a peer is an instance, not a local user row, and mixing those models would reintroduce exactly the kind of split Bastion has today.

### 5.4 Where it lives in Cairn

- **Endpoints:** `src/routes/api/federation/` — `handshake`, `invite`, `share-key`, `psbt/submit`, `psbt/[id]`, `psbt/[id]/sign`, `vault/manifest`. Peer-token auth mirrors Bastion's per-direction bearer scheme; local control-plane calls use the existing app JWT.
- **Services:** `src/lib/server/federation/` — `identity.ts`, `handshake.ts`, `invites.ts`, `peers.ts`, `psbtSession.ts`, `transport.ts`.
- **Watcher:** `federationWatcher.ts`, started from `hooks.server.ts` `init()` following the `addressWatcher.ts` template — retries queued pushes with backoff, bumps `last_seen`, expires stale sessions, and raises `federation.peer_offline`.
- **Notify event types** (append to the existing flat union + `DEFAULT_PREFERENCES`): `federation.invite_accepted`, `federation.vault_invite`, `federation.vault_ready`, `federation.signature_requested`, `federation.signature_received`, `federation.declined`, `federation.broadcast`, `federation.peer_offline`.
- **Flag/setting split:** feature flag `federation` (`defaultEnabled: true`, UI-visibility only) + setting `federation_enabled` (default **OFF**, gates all networking). See Security F15.
- **Backup:** add `federation_peers`, `federation_peer_keys`, `federation_invites`, and the new `multisig_*` columns to `BackupData`. Bearer tokens are secrets — encrypt them and require re-handshake messaging on restore. `federation_seed` stays excluded, consistent with other instance secrets.

---

## 6. User Journeys (UX-first)

- **J0 — Enable Federation** (admin). `settings/federation`. A transport-picker wizard (Tor by default) provisions identity and shows an identity card with the instance's `.onion` address and key fingerprint as a QR code.

- **J1 — Invite a cosigner.** Pick which of your keys to offer, set max uses / expiry, and get back a portable blob + QR code. Copy: "send this however you like" — invites are transport-agnostic by design.

- **J2 — Accept invite / add peer.** Paste the blob; handshake happens automatically; keys are exchanged reciprocally. **Mandatory** out-of-band fingerprint confirmation before the peer is trusted (Security F3) — this is a required step in the UI, not optional.

- **J3 — Build a shared vault.** Extends the *existing* multisig wizard with a cosigner-source picker: connected peer / my own key / paste an xpub. Vault-manifest push (D3) plus explicit accept on the receiving side. Includes a **non-skippable Recovery Kit gate**: Caravan-format JSON export, a key-holder map, and a "what to do if a cosigner disappears" document, all generated before the wizard can complete.

- **J4 — Request a signature.** The existing Send flow, plus a new cosigner status strip: "You ✅ · Bob ⏳ waiting".

- **J5 — Sign as a remote cosigner.** An SSE-driven live toast plus an activity feed item. A plain-language review screen renders amount, destination, and fee **from decoded PSBT bytes only** (Security F1) — never trusting whatever the coordinator claims. Sign or Decline.

- **J6 — Monitor & broadcast.** The status strip updates live as signatures arrive. Broadcast sets the transaction status and fans a notification out to all peers in the vault.

- **J7 — Failure states.** Peer offline → queued + retried, with a sneakernet fallback offered. Declined → a signed decline record. Cosigner disappeared → an N-day banner, escalating to a guided Recovery Kit migration flow.

**Every step in this journey has a "send this manually instead" sneakernet fallback** — federation is additive, never a hard dependency for getting a transaction signed.

---

## 7. Security Model & Requirements

### 7.1 Findings

| ID | Severity | Attack | Required fix |
|---|---|---|---|
| **F1** | P0 | Blind signing — a malicious coordinator pushes a drain PSBT with an arbitrary descriptor; a naive cosigner just signs whatever it's handed. | Cosigner instance independently verifies each PSBT input against its own **locally-held** vault descriptor, classifies outputs as vault-change vs. external using its own keys, renders amount/fee purely from the decoded PSBT, and caps the fee. Reuse `psbt.ts::summarizePsbt` + `validateRecipientsAndFeeRate`, extend `hostilePsbts.test.ts`. |
| **F4** | P0 | Auto-active strangers — Bastion's `/handshake` requires no invite or approval, so anyone who can reach the onion address becomes an active peer. | Inbound handshake lands as `pending` unless it matches an invite you actually issued; explicit local approval is required to promote a peer to `active`. |
| **F12** | P0 | The no-encryption decision (D2) rests on an *unverified* onion transport plus a live clearnet code path users could still reach. | MVP hard-refuses any non-`.onion` `baseUrl` (reject `http://` and any clearnet host; loopback allowed for tests only). Resolve the onion-availability spike **first**. If it fails, application-layer encryption moves into MVP scope. |
| **F2** | P1 | Invite blobs don't bind the inviter's ed25519 pubkey — opens a TOFU/MITM window. | Embed the inviter's pubkey (or its sha256) in the invite blob; pin it on accept. |
| **F3** | P1 | Invite interception enables contact substitution. | Mandatory out-of-band fingerprint confirmation in the accept UX, plus single-use codes with a short TTL. |
| **F5** | P1 | Hard-deleting a peer allows a silent re-handshake later (no memory that this peer was removed for a reason). | Eviction is block/tombstone, never a bare delete. |
| **F7** | P1 | Manifest mutation or replay = a key-swap attack after initial acceptance. | Once accepted, a vault descriptor is immutable. Any differing manifest triggers a fresh, explicit accept flow; an identical manifest is an idempotent no-op. |
| **F8** | P1 | Accept UX doesn't prove the user's own key is actually in the vault, nor surface look-alike peer names. | Show the full M-of-N and all fingerprints; require that the user's own controlled fingerprint is present; flag name collisions explicitly. |
| **F9** | P1 | `countSignatures` counts unvalidated partial sigs, producing a false "complete" state and a broadcast that then fails. | Count only partial sigs whose pubkey is an actual descriptor cosigner for that specific input. |
| **F13** | P1 | Tor collapses IP-based rate limiting — every request appears to originate from loopback. | Rely on invite-gated handshake plus a global handshake cap with backoff; never rely on client IP for rate limiting. |
| **F14** | P1 | `/psbt/submit` isn't authorization-gated, enabling storage exhaustion via spam sessions. | Reject submission unless the descriptor's fingerprints intersect a key we actually hold; cap open sessions per peer; enforce session TTL/expiry via the watcher. |
| **F15** | P1 | A `defaultEnabled: true` feature flag must never, by itself, open a network attack surface. | `federation_enabled` setting gates **all** networking: routes return 503, the onion service stays unpublished, the watcher never starts, and there is no outbound traffic at init, regardless of flag state. The flag controls nav visibility only. Ship a test asserting `/api/federation/*` returns 503 whenever the setting is OFF, irrespective of the flag. |
| **F16** | P1 | Bearer tokens stored in plaintext mean a DB theft is a live impersonation with no seed required. | Encrypt token columns using an `instance_secrets`-derived key, and/or sign every protocol request with the ed25519 identity key. Restore messaging must be honest about this. |
| **F17** | P1 | SSRF via an attacker-controlled `baseUrl` — a malicious invite could point `baseUrl` at an internal service. | `.onion`-only allowlist (subsumes F12), plus an explicit block on RFC1918 / loopback / link-local addresses for any non-test peer. |
| **F6** | P2 | `instanceId` at `sha256[:16 hex]` (64 bits) is narrower than ideal. | Widen to `sha256[:32]` (128 bits) in Phase 2. |
| **F11** | P2 | Peers currently trust the coordinator's claim that a transaction broadcast successfully. | Peers self-verify the broadcast txid against what they actually signed, using their own node, in Phase 2. |
| — | P2 | No application-layer encryption is the hard gate before any supported clearnet transport ships. | Phase 2 prerequisite (see Section 8). |
| — | P2 | No federation-identity export/recovery path exists yet. | Phase 2 (see Open Question 4). |

### 7.2 Accepted invariant (document, don't "fix")

**F18 — PSBT-level derivation paths are unavoidable and not a leak.** PSBT inputs inherently carry per-input BIP32 derivation info (fingerprint + path) so that a signer can locate its own key. This means the coordinator, as a co-owner of the vault, legitimately sees cosigner account paths inside any PSBT it constructs. "No paths travel over the wire" is true only at the **descriptor** level (Bastion's fingerprint-only origins) — it does not and cannot extend to PSBT contents. Document this accurately rather than treating it as a bug to fix.

### 7.3 Inherit-from-Bastion checklist

Carry these forward unchanged: 404-not-403 everywhere; constant-time token comparison; self-peer handshake rejection; blocked-peer request refusal; fingerprint redaction in logs; rate limits always on; major-version protocol gate; descriptor path omission; contacts-gated key/invite sharing; audit log on every protocol action.

---

## 8. MVP Cut & Phasing

### Phase 1 — MVP
Tor-only. Opt-in — `federation_enabled` is OFF by default. Positioned as experimental and testnet-steered in-product.

Scope:
- Identity, handshake, peers, invites, share-key (Bastion port, D1/D2 applied)
- Shared-vault build with manifest push, explicit accept, and a non-skippable Recovery Kit gate
- Direct star-topology PSBT submit / sign / collect
- Unified spend flow inside the existing multisig UI, with a cosigner status strip and a plain-language remote-review screen backed by independent PSBT verification
- Real-time delivery via the existing SSE/notification bus
- `federationWatcher` for retries and offline handling
- Sneakernet fallback at every step
- Broadcast/cancel wired end-to-end
- Audit log and always-on rate limiting
- **All P0 and P1 security fixes from Section 7 are in-scope for MVP, not deferred.**

### Phase 2 — before any supported clearnet transport / real-fund promotion
- Application-layer PSBT encryption to each peer's ed25519 key (mandatory once clearnet is supported)
- Federation-identity export/recovery
- Guided "cosigner disappeared" migration flow
- Broadcast self-verification (F11)

### Phase 3+
- Multi-hop relay / mesh topology
- Nostr as a wakeup/signaling channel (not a PSBT pipe)
- Iroh transport
- Larger and more complex quorum structures

### Non-goals (explicit)
No e-cash, no Fedimint, no Lightning. No custodial layer of any kind. No shared-fund pool. MVP is **not** intended for mainnet real funds until Phase 2 hardening lands.

---

## 9. Open Questions for Alex

1. **umbrelOS per-app onion availability.** Does umbrelOS 1.x still expose a per-app `.onion` (`APP_*_HIDDEN_SERVICE` via `exports.sh`)? This must be verified before committing to Tor as the default transport. **This is the ship-blocker spike.** *Default if unresolved: fall back to Manual URL / Tailscale with documented `torrc` setup as an interim path.*

2. **If the onion spike fails, does app-layer encryption move into MVP?** *Default: yes.*

3. **Testnet-only for MVP, or allow mainnet with loud warnings?** *Default: testnet-steered, with mainnet gated behind an explicit user acknowledgement.*

4. **Federation identity portability — MVP or Phase 2?** *Default: Phase 2. MVP messaging is "lost instance = re-handshake; funds are safe" (funds are never at risk since federation holds no custody, but coordination continuity is).*

5. **Recovery Kit format.** Caravan JSON is the existing interchange standard — confirm the "cosigner disappeared" document's exact content. *Default: Caravan JSON export + key-holder map + a static instructional doc, non-skippable in the vault-creation wizard.*

6. **Sign-request auth — encrypt tokens at rest, sign every request, or both (F16)?** *Default: both.*

7. **Mobile surface.** Confirm federation does not get a 5th tab, and that incoming requests surface only via notifications/activity with a deep link. *Default: confirmed, no 5th tab.*

8. **Max quorum / party count for MVP.** *Default: cap at a small N (≤5), matching a family/friends use case rather than larger organizational quorums.*

---

## 10. Complexity Estimate

**Sequencing note (from the security review):** the natural build order is **Unit 0 (transport spike) → PSBT verification + peer-auth hardening → manifest → D5 unification → broadcast/SSE → Recovery Kit.** The unification work (Track D) is the architectural keystone of this whole feature, but it must land *after* verification (Track P) and transport (Track 0) are solid — building the unified spend flow on top of unverified PSBT trust or an unresolved transport question would lock in the exact vulnerabilities Section 7 exists to prevent.

**Track 0 — gating spike**
- **U0** — umbrelOS per-app onion verification + transport allowlist (`.onion`-only, RFC1918 block). Lands F12 and F17. Blocks everything else.

**Track A — identity/transport**
- **A1** — `federation_seed` + ed25519 identity module
- **A2** — `transport.ts` URL abstraction + onion provisioning
- **A3** — `federation` flag + `federation_enabled` setting + J0 wizard (acceptance criterion: the F15 gate test)

**Track B — peering (Bastion port)**
- **B1** — `federation_peers` + `/handshake` + per-direction tokens/auth (+ F4 pending-handshake state, + F16 token-at-rest)
- **B2** — invite engine + J1/J2 UI + peer list (+ F2 pubkey-bind, + F3 out-of-band confirm, + F5 block-not-delete)
- **B3** — share-key + `federation_peer_keys` routing map
- **B4** — audit log + rate limiting (+ F13 Tor-safe rate limiting)

**Track C — shared vault**
- **C1** — `multisig_keys.holder_*` columns + cosigner-source picker in the multisig wizard
- **C2** — vault-manifest push + auto-create/accept + descriptor-match verification (+ F7 immutability, + F8 accept-UX)
- **C3** — Recovery Kit gate

**Track P — PSBT verification (critical path, ahead of unification)**
- **P1** — cosigner-side independent PSBT verification engine, wiring `summarizePsbt`/`validateRecipientsAndFeeRate` into the federation sign path (F1)
- **P2** — validated signature counting (F9)

**Track D — unified PSBT flow**
- **D1** — `multisig_transactions` federation columns + `psbtSession.ts` (unified submit/sign/collect, star topology, unsigned-bytes dedupe) (+ F14 submit gate and caps)
- **D2** — endpoints: `psbt/submit`, `psbt/[id]`, `psbt/[id]/sign` (session auth, 404-not-403)
- **D3** — cosigner status strip + remote-review screen (reuses `Amount.svelte`)
- **D4** — broadcast/cancel wiring + `federation.*` notify types + peer fan-out

**Track E — runtime/resilience**
- **E1** — `federationWatcher.ts` (retry queue, `last_seen`, stale-session expiry, peer-offline notify)
- **E2** — sneakernet fallback at every step + offline/decline/disappeared failure UIs
- **E3** — backup/restore additions + re-handshake-on-restore messaging

**Rough total: ~24 units.**

The foundation (Tracks A/B) is a near-verbatim, low-risk port of Bastion's already-audited protocol. The real engineering effort is concentrated in **Track P** (independent verification), **C2** (manifest push/accept), and **Track D** (unification) — these are where Heartwood genuinely diverges from and improves on Bastion. **U0 gates everything downstream** and should be the very first thing scheduled.

---

## 11. Alternatives Considered (brief)

- **Fedimint / e-cash (the original framing).** Rejected. It's custodial — a guardian quorum can steal or debase funds — and offers no trustless proof-of-reserves. Wrong trust model entirely for sovereign multisig coordination. Bastion, notably, explicitly rejects this model too for the same reason.

- **Cashu.** Rejected for the same reason: single-mint custodial design.

- **Nostr-native PSBT coordination** (Munstr, Smart Vaults/Coinstr). All observed implementations are stalled pre-production; there is no PSBT NIP standard, and relay size/delivery limits make it unsuitable as a primary transport. Retained only as a possible Phase-2 wakeup signal, not a PSBT pipe.

- **Nunchuk's model** (a centrally-owned server plus a descriptor-derived E2E group key via PBKDF2). The strongest prior art reviewed. Not chosen because it depends on a shared relay/server, whereas Heartwood's federation is peer-to-peer and sovereign by design. The descriptor-derived-key technique itself is worth revisiting in Phase 2 if a store-and-forward relay is ever introduced.

- **Sneakernet** (Sparrow/Caravan/Specter-style file and QR-code exchange). This is Heartwood's status quo today. Federation is strictly an enhancement layered on top of it, and sneakernet remains the permanent fallback at every step of the journey (Section 6).

---

*End of scoping document.*
