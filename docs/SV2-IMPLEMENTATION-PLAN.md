# Native Stratum V2 Listener — Implementation Architecture

Status: design, 2026-07-20. Resolves ballot cairn-qfez8.1 as option (a) native listener (Alex, this session); port 3335 per qfez8.5.
Companion codec spec: `docs/SV2-WIRE-REFERENCE.md` (read first — this plan assumes its field lists and framing).

Route (orchestrator-fixed, do not relitigate): pure-TypeScript transport (Route C1, no native addons); templates from the existing `TipPoller → GBT → buildJob` pipeline (no Template Provider); per-channel personalized coinbase; extended channels primary, standard channels supported; Noise keys per-instance persisted via `secretKey.ts`; a third listener inside `MiningPool` next to `server`/`asicServer`; V1 listeners (3333/3334) frozen; vitest; Node ≥ 22.5 (box runs 24.14.1).

---

## 0. Headline architectural result

**The entire consensus-and-money path is reused with ZERO changes to `job.ts` or `wire.ts`.** Two facts make this true:

1. **Extranonce layout already matches SV2.** `buildJob().personalize()` returns `coinb1Hex` / `coinb2Hex` split around an 8-byte extranonce zone (`EXTRANONCE1_SIZE(4) + EXTRANONCE2_SIZE(4)`, job.ts:37-39). The split uses the *legacy* (non-witness) coinbase serialization (`tx.toBuffer()` "no witness set → legacy bytes", job.ts:139) — which is exactly SV2's BIP141-stripped `coinbase_tx_prefix` / `coinbase_tx_suffix`. So:
   - SV2 `coinbase_tx_prefix` = `coinb1` (bytes before the 8-byte zone)
   - SV2 `coinbase_tx_suffix` = `coinb2` (bytes after the 8-byte zone)
   - the 8-byte zone = `extranonce_prefix ‖ extranonce`
2. **The crypto is already in a dependency we ship.** `@scure/btc-signer/p2p.js` exports `elligatorSwift` with BIP324 `getSharedSecretBip324(...)` — verified to compute exactly SV2's Noise `ee`/`es` ECDH with agreeing secrets across initiator/responder roles. `@noble/curves/secp256k1.js` exports `schnorr` for BIP340 cert signing. `node:crypto` `chacha20-poly1305` (IETF, 16-byte tag, zero-length AAD) works on this box. **No custom ElligatorSwift implementation is needed** (see §9 verdict).

Consequence: the SV2 listener is a *transport + protocol-state* layer. All hashing, target math, merkle folding, header assembly, block assembly, and value-conservation checks call the existing exported `wire.ts` functions and the existing `CoinbaseVariant` closures. The frozen legal gate (single value-bearing coinbase output, cairn-vn43.14) is inherited automatically because SV2 personalizes through the same `buildJob().personalize()`.

---

## a. Module / file layout

All under `src/lib/server/mining/sv2/`. Every module is independently unit-testable.

```
sv2/
  crypto.ts        # thin wrapper over deps: ellswift ECDH, schnorr, sha256/hmac/hkdf, chacha AEAD
  codec.ts         # Reader/Writer serialization primitives + per-message encode/decode + MSG ids
  frames.ts        # 6-byte header codec, plaintext + Noise frame (de)framing, backpressure FrameReader
  noise.ts         # NoiseResponder handshake (NX) + CipherState pair, transport encrypt/decrypt
  authority.ts     # authority keypair load/persist (secretKey.ts), static key, cert issuance
  channels.ts      # per-connection channel registry + FrozenJob state machine + job→message mapping
  sv2Server.ts     # the listener: implements the StratumServer-equivalent contract
  testClient.ts    # test-only Noise initiator + minimal mining client (see §g)
  index.ts         # barrel: export { Sv2Server, type Sv2ServerOptions }
  *.test.ts        # colocated per module (see §f)
```

### a.1 `crypto.ts`
Re-exports and wraps the vendored dep crypto so the rest of sv2 never imports `@scure`/`@noble` directly.

```ts
import { elligatorSwift } from '@scure/btc-signer/p2p.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToNumberBE } from '@noble/curves/utils.js';
import { sha256 as _sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import * as nodeCrypto from 'node:crypto';

export function sha256(...parts: Uint8Array[]): Uint8Array;            // SHA-256 of concat
export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;

/** Noise HKDF: returns [ck', temp_k] (2-output form; §3 of wire ref). */
export function hkdf2(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array];

/** Ephemeral EllSwift keypair: 32-byte secp secret + 64-byte EllSwift public. */
export function ellswiftKeygen(): { priv: Uint8Array; pub64: Uint8Array };

/** SV2 Noise ECDH = BIP324 v2_ecdh. Server passes initiator=false. */
export function ecdhSv2(ourPriv32: Uint8Array, theirPub64: Uint8Array, ourPub64: Uint8Array, initiator: boolean): Uint8Array; // = elligatorSwift.getSharedSecretBip324

/** From a persisted 32-byte static secret → x-only (cert field) + a valid 64-byte EllSwift wire encoding. */
export function staticFromSecret(priv32: Uint8Array): { xonly32: Uint8Array; ell64: Uint8Array };
// xonly32 = schnorr.getPublicKey(priv32); ell64 = elligatorSwift.encode(bytesToNumberBE(xonly32))

export function schnorrSign(msg32: Uint8Array, priv32: Uint8Array): Uint8Array;        // 64B BIP340
export function schnorrVerify(sig64: Uint8Array, msg32: Uint8Array, xonly32: Uint8Array): boolean;
export function randomSecret32(): Uint8Array;                                          // schnorr.utils.randomSecretKey()

/** ChaCha20-Poly1305 IETF, 16-byte tag. nonce12 = 4 zero bytes ‖ LE u64 counter. */
export function chachaSeal(key32: Uint8Array, nonce12: Uint8Array, ad: Uint8Array, pt: Uint8Array): Uint8Array; // ct‖tag
export function chachaOpen(key32: Uint8Array, nonce12: Uint8Array, ad: Uint8Array, ctTag: Uint8Array): Uint8Array; // throws on bad tag
```
`chachaSeal`/`chachaOpen` wrap `nodeCrypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })` (verified working, §9).

### a.2 `codec.ts`
```ts
export const MSG = {
  SetupConnection: 0x00, SetupConnectionSuccess: 0x01, SetupConnectionError: 0x02,
  ChannelEndpointChanged: 0x03, Reconnect: 0x04,
  OpenStandardMiningChannel: 0x10, OpenStandardMiningChannelSuccess: 0x11, OpenMiningChannelError: 0x12,
  OpenExtendedMiningChannel: 0x13, OpenExtendedMiningChannelSuccess: 0x14,
  NewMiningJob: 0x15, UpdateChannel: 0x16, UpdateChannelError: 0x17, CloseChannel: 0x18,
  SetExtranoncePrefix: 0x19, SubmitSharesStandard: 0x1a, SubmitSharesExtended: 0x1b,
  SubmitSharesSuccess: 0x1c, SubmitSharesError: 0x1d,
  NewExtendedMiningJob: 0x1f, SetNewPrevHash: 0x20, SetTarget: 0x21, SetGroupChannel: 0x25,
} as const;

/** Message types that carry the channel_msg bit (§4 of wire ref). */
export const CHANNEL_MSG: ReadonlySet<number>;

export class Writer {
  u8(n: number): this; u16(n: number): this; u24(n: number): this; u32(n: number): this;
  u64(n: bigint): this; f32(n: number): this; bool(b: boolean): this;
  bytesRaw(b: Uint8Array): this;                 // no length prefix
  u256(v: Uint8Array | bigint): this;            // 32B LE
  str0_255(s: string): this; b0_32(b: Uint8Array): this; b0_255(b: Uint8Array): this;
  b0_64k(b: Uint8Array): this;
  optU32(v: number | null): this;                // OPTION[U32]
  seqU256(items: Uint8Array[]): this;            // SEQ0_255[U256]
  seqU32_64k(items: number[]): this;             // SEQ0_64K[U32]
  finish(): Uint8Array;
}
export class Reader {
  constructor(buf: Uint8Array);
  u8(): number; u16(): number; u24(): number; u32(): number; u64(): bigint; f32(): number; bool(): boolean;
  u256(): Uint8Array; str0_255(): string; b0_32(): Uint8Array; b0_255(): Uint8Array; b0_64k(): Uint8Array;
  optU32(): number | null; seqU256(): Uint8Array[]; seqU32_64k(): number[];
  rest(): Uint8Array; get eof(): boolean;
}

// Typed message interfaces + decode(payload)/encode(msg) per direction we handle.
// INBOUND (client→server) — decode only:
export interface SetupConnection { protocol: number; minVersion: number; maxVersion: number; flags: number;
  endpointHost: string; endpointPort: number; vendor: string; hardwareVersion: string; firmware: string; deviceId: string; }
export function decodeSetupConnection(p: Uint8Array): SetupConnection;
export interface OpenStandardMiningChannel { requestId: number; userIdentity: string; nominalHashRate: number; maxTarget: Uint8Array; }
export function decodeOpenStandardMiningChannel(p: Uint8Array): OpenStandardMiningChannel;
export interface OpenExtendedMiningChannel extends OpenStandardMiningChannel { minExtranonceSize: number; }
export function decodeOpenExtendedMiningChannel(p: Uint8Array): OpenExtendedMiningChannel;
export interface UpdateChannel { channelId: number; nominalHashRate: number; maximumTarget: Uint8Array; }
export function decodeUpdateChannel(p: Uint8Array): UpdateChannel;
export interface SubmitSharesStandard { channelId: number; sequenceNumber: number; jobId: number; nonce: number; ntime: number; version: number; }
export function decodeSubmitSharesStandard(p: Uint8Array): SubmitSharesStandard;
export interface SubmitSharesExtended extends SubmitSharesStandard { extranonce: Uint8Array; }
export function decodeSubmitSharesExtended(p: Uint8Array): SubmitSharesExtended;
export function decodeCloseChannel(p: Uint8Array): { channelId: number; reasonCode: string };

// OUTBOUND (server→client) — encode only (returns payload, header added by frames.ts):
export function encodeSetupConnectionSuccess(m: { usedVersion: number; flags: number }): Uint8Array;
export function encodeSetupConnectionError(m: { flags: number; errorCode: string }): Uint8Array;
export function encodeOpenStandardMiningChannelSuccess(m: { requestId: number; channelId: number; target: Uint8Array; extranoncePrefix: Uint8Array; groupChannelId: number }): Uint8Array;
export function encodeOpenExtendedMiningChannelSuccess(m: { requestId: number; channelId: number; target: Uint8Array; extranonceSize: number; extranoncePrefix: Uint8Array; groupChannelId: number }): Uint8Array;
export function encodeOpenMiningChannelError(m: { requestId: number; errorCode: string }): Uint8Array;
export function encodeNewMiningJob(m: { channelId: number; jobId: number; minNtime: number | null; version: number; merkleRoot: Uint8Array }): Uint8Array;
export function encodeNewExtendedMiningJob(m: { channelId: number; jobId: number; minNtime: number | null; version: number; versionRollingAllowed: boolean; merklePath: Uint8Array[]; coinbaseTxPrefix: Uint8Array; coinbaseTxSuffix: Uint8Array }): Uint8Array;
export function encodeSetNewPrevHash(m: { channelId: number; jobId: number; prevHash: Uint8Array; minNtime: number; nbits: number }): Uint8Array;
export function encodeSetTarget(m: { channelId: number; maximumTarget: Uint8Array }): Uint8Array;
export function encodeSubmitSharesSuccess(m: { channelId: number; lastSequenceNumber: number; newSubmitsAcceptedCount: number; newSharesSum: bigint }): Uint8Array;
export function encodeSubmitSharesError(m: { channelId: number; sequenceNumber: number; errorCode: string }): Uint8Array;
export function encodeUpdateChannelError(m: { channelId: number; errorCode: string }): Uint8Array;
```
Note: `SetupConnection.protocol`/`flags` etc. are LE per §2. `u256` stores/reads **LE** (matches wire ref: raw SHA-256 output as LE unsigned). Target conversion `bigint ↔ 32B LE` lives here (a helper `targetToU256LE(t: bigint)` / `u256LEToBigint(b)`), used against `wire.difficultyToTarget` / `wire.bitsToTarget` outputs.

### a.3 `frames.ts`
```ts
export const HEADER_LEN = 6;
export const NOISE_HEADER_CT_LEN = 22;         // 6 + 16 MAC
export const MAX_PT_LEN = 65519;
export const MAX_CT_LEN = 65535;

export function encodeHeader(extType: number, msgType: number, payloadLen: number): Uint8Array; // 6B, U24 LE length
export function decodeHeader(buf6: Uint8Array): { extType: number; msgType: number; msgLen: number };
export function ptLenToCtLen(ptLen: number): number;                                  // exact algorithm from wire ref §1.2

export interface Frame { extType: number; msgType: number; channelMsg: boolean; payload: Uint8Array }

/** For a server→client message: build a full plaintext frame (header ‖ payload). */
export function buildFrame(msgType: number, channelMsg: boolean, payload: Uint8Array): Uint8Array;

/** Streaming plaintext parser (handshake phase only). Accumulates partial TCP chunks,
 *  yields complete frames; enforces a max buffered-bytes cap (DoS). */
export class PlaintextFrameReader {
  constructor(maxBuffer?: number);
  push(chunk: Uint8Array): void;
  *drain(): IterableIterator<Frame>;            // yields whatever is now complete
}
```
Noise-transport framing (post-handshake) is driven by `noise.ts` because it interleaves AEAD calls with the length conversion; see a.4.

### a.4 `noise.ts`
```ts
export interface CipherState {
  encrypt(ad: Uint8Array, pt: Uint8Array): Uint8Array;   // ChaCha20Poly1305, post-increment counter
  decrypt(ad: Uint8Array, ct: Uint8Array): Uint8Array;   // throws → caller terminates session
}
export function newCipherState(key32: Uint8Array): CipherState;

export interface SignedCert { version: number; validFrom: number; notValidAfter: number; signature: Uint8Array; }

/** Server side of the NX handshake (responder). Single-use per connection. */
export class NoiseResponder {
  constructor(params: { staticPriv32: Uint8Array; staticEll64: Uint8Array; cert: SignedCert });
  /** Consume the 64-byte Act-1 (client ephemeral EllSwift). */
  readAct1(act1: Uint8Array): void;
  /** Produce the 234-byte Act-2 (see wire ref §3; 64 ephemeral + 80 enc static + 90 enc signature). */
  writeAct2(): Uint8Array;
  /** After Act-2 written: derive transport ciphers. */
  split(): { recv: CipherState /* c1: client→server */; send: CipherState /* c2: server→client */ };
}

/** Transport-frame encryption: header AEAD (own call) + payload AEAD (chunked to ≤65519 pt). */
export function sealTransport(send: CipherState, frame: Uint8Array /* header‖payload */): Uint8Array;

/** Stateful transport decryptor: feed ciphertext, get complete plaintext frames.
 *  Reads 22-byte encrypted header, converts msg_length→ct length, reads+decrypts payload. */
export class TransportReader {
  constructor(recv: CipherState, maxBuffer?: number);
  push(chunk: Uint8Array): void;
  *drain(): IterableIterator<Frame>;            // decrypt failure → throws (terminate session)
}
```
`writeAct2()` implements exactly the wire-ref §3 Act-2 sequence: append ephemeral `e.pub` (64B, MixHash), `MixKey(ecdhSv2(e.priv, re, e.pub, false))`, append `EncryptAndHash(staticEll64)` (→80B), `MixKey(ecdhSv2(staticPriv, re, staticEll64, false))`, append `EncryptAndHash(certBytes74)` (→90B), then `HKDF(ck, ∅)` → `(recv=c1, send=c2)`. Protocol name string, `h`/`ck` init, `MixHash`, `EncryptAndHash`, `DecryptAndHash` per wire ref. **Assert output length === 234** and leave a `// TODO(interop): spec text says 170; verify vs SRI noise_sv2` marker.

### a.5 `authority.ts`
```ts
export const SV2_AUTHORITY_DOMAIN = 'cairn:sv2-authority';
export const CERT_VERSION = 0;
export const CERT_VALIDITY_SEC = 24 * 3600;
export const CERT_BACKDATE_SEC = 300;          // NTP-skew tolerance

/** Load (or first-run create + persist encrypted) the durable authority keypair. */
export function loadOrCreateAuthorityKey(): { secret32: Uint8Array; xonly32: Uint8Array };

/** base58check( [1,0] ‖ xonly32 ) — the value published in stratum2+tcp://host:port/<b58>. */
export function authorityPubBase58(xonly32: Uint8Array): string;

/** The 32-byte digest the authority signs: SHA256(ver ‖ valid_from ‖ not_valid_after ‖ static_xonly), wire-serialized LE. */
export function certDigest(version: number, validFrom: number, notValidAfter: number, staticXonly32: Uint8Array): Uint8Array;

/** Issue a cert for a static key, signed by the authority secret (BIP340 Schnorr). */
export function issueCert(staticXonly32: Uint8Array, authoritySecret32: Uint8Array, now?: number): SignedCert;

/** Serialize SIGNATURE_NOISE_MESSAGE (74B): version U16 | valid_from U32 | not_valid_after U32 | signature(64). */
export function encodeSignatureNoiseMessage(cert: SignedCert): Uint8Array;
```
`loadOrCreateAuthorityKey` persists via the refactored `secretKey.ts` (`encryptSecret(hex, SV2_AUTHORITY_DOMAIN)` under kv key `mining_sv2_authority_secret`; see §d).

### a.6 `channels.ts`
```ts
import type { BuiltJob, CoinbaseVariant, MinerAuth } from '../types';

export type ChannelKind = 'standard' | 'extended';

/** One announced job on one channel — the FROZEN unit (payout + target fixed at announce). */
export interface FrozenJob {
  sv2JobId: number;          // channel-scoped U32 we assigned
  poolJobId: string;         // built.job.jobId — the key MiningPool.handleSolve looks up
  variant: CoinbaseVariant;  // personalized to THIS channel's payoutScript (frozen)
  target: bigint;            // announce-time share target (announce-time-difficulty invariant)
  prevHashDisplay: string;
  ntimeHex: string;
  baseVersionHex: string;
  nbitsHex: string;
  height: number;
  coinbaseValueSats: bigint;
  en1PrefixHex: string;      // server extranonce_prefix (extended: 4B; standard: full 8B split[0:4])
  merkleRootLE?: Uint8Array; // standard channels only (server-computed, sent in NewMiningJob)
}

export interface Channel {
  readonly id: number;
  readonly kind: ChannelKind;
  readonly auth: MinerAuth;
  readonly userIdentity: string;
  readonly extranoncePrefixHex: string; // server-owned bytes
  readonly extranonceSize: number;      // client-owned bytes (extended). standard: 0
  target: bigint;                        // current channel target (moves with vardiff SetTarget)
  versionRollingAllowed: boolean;
  readonly jobs: Map<number, FrozenJob>; // keyed by sv2JobId, capped (JOB_RETENTION)
  nextSv2JobId(): number;
}

export class ChannelRegistry {
  openExtended(auth: MinerAuth, userIdentity: string, minExtranonceSize: number, target: bigint, versionRolling: boolean): Channel; // throws if minExtranonceSize > 8
  openStandard(auth: MinerAuth, userIdentity: string, target: bigint, versionRolling: boolean): Channel;
  get(channelId: number): Channel | undefined;
  close(channelId: number): void;
  all(): Channel[];
  count(): number;
}

/** Map a BuiltJob → the messages to send on one channel. Pure (no I/O), fully unit-testable. */
export function jobMessagesFor(ch: Channel, built: BuiltJob): {
  frozen: FrozenJob;
  newJob: { kind: 'extended'; msg: Parameters<typeof import('./codec').encodeNewExtendedMiningJob>[0] }
         | { kind: 'standard'; msg: Parameters<typeof import('./codec').encodeNewMiningJob>[0] };
  setPrevHash?: Parameters<typeof import('./codec').encodeSetNewPrevHash>[0]; // present when built.job.cleanJobs
};
```
See §b for the exact body of `jobMessagesFor`.

### a.7 `sv2Server.ts`
Implements the **same contract shape as `StratumServer`** (stratum.ts:71-94 / 248-325) so `MiningPool` treats it identically to `server`/`asicServer`.

```ts
import type { AuthProvider, BuiltJob, ConnectionInfo, Network, RejectEvent, ShareEvent, SolveEvent } from '../types';
import type { VardiffOptions } from '../stratum';

export interface Sv2ServerOptions {
  readonly port: number;
  readonly host?: string;                 // default '127.0.0.1'
  readonly shareDifficulty: number;
  readonly network: Network;
  readonly authProvider: AuthProvider;
  readonly onShare: (e: ShareEvent) => void;
  readonly onSolve: (e: SolveEvent) => void;   // MiningPool wraps this in enqueue(handleSolve)
  readonly onReject?: (e: RejectEvent) => void;
  readonly log?: (msg: string) => void;
  readonly blockPolicyShift?: number;     // default 4 (parity with V1 solve gate)
  readonly vardiff?: VardiffOptions;
  readonly maxConnections?: number;       // default 64 (per-IP + global; DoS)
  readonly versionRollingAllowed?: boolean; // default FALSE for v1 (see §b version rolling)
  readonly authority: {                   // injected so the server is testable with a fixed key
    readonly staticPriv32: Uint8Array;
    readonly staticEll64: Uint8Array;
    readonly cert: import('./noise').SignedCert;
  };
  readonly handshakeTimeoutMs?: number;   // default 10_000
}

export class Sv2Server {
  constructor(opts: Sv2ServerOptions);
  listen(): Promise<void>;
  close(): Promise<void>;
  setJob(built: BuiltJob): void;
  connections(): ConnectionInfo[];        // ConnectionInfo.protocol = 'sv2'
  get minerCount(): number;
  get listening(): boolean;
  get port(): number;                     // actual bound port
  get boundAddress(): string | null;
}
```

### a.8 `index.ts`
```ts
export { Sv2Server } from './sv2Server';
export type { Sv2ServerOptions } from './sv2Server';
```

---

## b. Engine-concept mapping

### b.1 `BuiltJob → NewExtendedMiningJob` + extranonce byte budget
Per channel, on `setJob(built)`:
```
variant = built.personalize({ payoutScript: ch.auth.payoutScript })   // frozen, single-output coinbase
coinbase_tx_prefix = hexToBytes(variant.coinb1Hex)                     // = SV2 prefix (BIP141-stripped)
coinbase_tx_suffix = hexToBytes(variant.coinb2Hex)                     // = SV2 suffix
merkle_path        = built.job.merkleBranchesInternalHex.map(hexToBytesLE)  // SEQ0_255[U256], deepest-first
version            = parseInt(built.job.versionHex, 16)
```
**Byte budget (the 8-byte zone is fixed by job.ts and never changes):**

| channel | extranonce_prefix (server) | extranonce (client) | total |
|---|---|---|---|
| extended, default | 4 bytes | `extranonce_size` = 4 bytes | 8 |
| extended, client asked `min_extranonce_size = m` (0 ≤ m ≤ 8) | `8 − m` bytes | `m` bytes | 8 |
| extended, `m > 8` | — reject `OpenMiningChannel.Error("max-extranonce-too-large")` | — | — |
| standard | 8 bytes (full zone; no client part) | 0 | 8 |

- Extended default `4/4` mirrors V1 `EN1/EN2` roles exactly (server EN1 = per-channel prefix, client EN2 = rolled). `extranonce_prefix` is server-assigned and unique per channel (a running counter is sufficient; per-channel coinbase already differs by payout, so this is defense-in-depth, not correctness-critical).
- `OpenExtendedMiningChannel.Success.extranonce_size` = the client byte count `m` (default 4); `extranonce_prefix` = the `8−m` server bytes.

### b.2 `SetNewPrevHash` flow on `installJob`
`built.job.cleanJobs` carries the clean/refresh distinction (set true from `handleTip`, false from `refreshJob`; miningPool.ts:266/292). `Sv2Server.setJob` reads it:

- **clean (new block / cleanJobs=true):** send the new job as a **future** job (`min_ntime = null`), then `SetNewPrevHash(channel_id, sv2JobId, prev_hash, min_ntime=job.ntime, nbits)` naming it. This activates the new job and invalidates all prior jobs on the channel (drop them from `ch.jobs` after a short grace, matching V1 `JOB_WINDOW`).
- **refresh (fee bump / cleanJobs=false, same prevhash):** send the new job with `min_ntime = job.ntime` (immediately valid, non-future); **no** `SetNewPrevHash`. Prior jobs remain valid until the next clean.

`jobMessagesFor(ch, built)` body:
```ts
const clean = built.job.cleanJobs;
const variant = built.personalize({ payoutScript: ch.auth.payoutScript });
const sv2JobId = ch.nextSv2JobId();
const ntime = parseInt(built.job.ntimeHex, 16);
const version = parseInt(built.job.versionHex, 16);
const nbits = parseInt(built.job.nbitsHex, 16);
const prevHash = displayToU256LE(built.job.prevHashDisplay);
const frozen: FrozenJob = { sv2JobId, poolJobId: built.job.jobId, variant, target: ch.target,
  prevHashDisplay: built.job.prevHashDisplay, ntimeHex: built.job.ntimeHex,
  baseVersionHex: built.job.versionHex, nbitsHex: built.job.nbitsHex, height: built.job.height,
  coinbaseValueSats: built.job.coinbaseValueSats, en1PrefixHex: ch.extranoncePrefixHex };
if (ch.kind === 'extended') {
  return { frozen, newJob: { kind:'extended', msg: { channelId: ch.id, jobId: sv2JobId,
    minNtime: clean ? null : ntime, version, versionRollingAllowed: ch.versionRollingAllowed,
    merklePath: built.job.merkleBranchesInternalHex.map(h => Buffer.from(h,'hex')),
    coinbaseTxPrefix: Buffer.from(variant.coinb1Hex,'hex'),
    coinbaseTxSuffix: Buffer.from(variant.coinb2Hex,'hex') } },
    setPrevHash: clean ? { channelId: ch.id, jobId: sv2JobId, prevHash, minNtime: ntime, nbits } : undefined };
}
// standard: server computes merkle_root from the full 8-byte prefix
const en = Buffer.from(ch.extranoncePrefixHex, 'hex');           // 8 bytes
const coinbase = Buffer.concat([Buffer.from(variant.coinb1Hex,'hex'), en, Buffer.from(variant.coinb2Hex,'hex')]);
const rootLE = applyBranches(sha256d(coinbase), built.job.merkleBranchesInternalHex.map(h=>Buffer.from(h,'hex')));
frozen.merkleRootLE = rootLE;
return { frozen, newJob: { kind:'standard', msg: { channelId: ch.id, jobId: sv2JobId,
  minNtime: clean ? null : ntime, version, merkleRoot: rootLE } },
  setPrevHash: clean ? { channelId: ch.id, jobId: sv2JobId, prevHash, minNtime: ntime, nbits } : undefined };
```
Only exported `wire.ts` functions (`sha256d`, `applyBranches`, `displayToInternal`) are used — no new consensus math.

### b.3 Share validation (reuses `wire.ts`, rolling-ready)
On `SubmitSharesExtended{ channelId, jobId, nonce, ntime, version, extranonce }`:
```ts
const ch = registry.get(channelId);                     // else SubmitShares.Error "unknown-channel"
const job = ch.jobs.get(jobId);                          // else SubmitShares.Error "stale-job" (+ onReject 'stale')
// version rolling gate:
if (!ch.versionRollingAllowed && version !== parseInt(job.baseVersionHex,16))
   → SubmitShares.Error "version-rolling-not-allowed";
if (ch.versionRollingAllowed) assertRolledWithinMask(version, job.baseVersionHex); // BIP320 0x1fffe000
// ntime window: job.ntime ≤ ntime ≤ job.ntime + elapsed (+2h consensus cap)
const en1 = job.en1PrefixHex, en2 = toHex(extranonce);   // extended: server prefix + client extranonce
// (standard channel: SubmitSharesStandard has NO extranonce; en1=prefix[0:8][0:4], en2=prefix[4:8])
const header = buildHeader(hex8(version), job.prevHashDisplay,
                 applyBranches(sha256d(coinbaseBytes(job.variant, en1, en2)), branches),
                 hex8(ntime), job.nbitsHex, hex8(nonce));
const hv = hashValueFromDisplay(headerHashDisplay(header));   // wire.ts
if (hv > job.target) → SubmitShares.Error "difficulty-too-low" (+ onReject 'low_difficulty');
// else accept: onShare({ userId, miningId, worker, difficulty: targetToDifficulty(job.target), timestampMs })
//   + SubmitShares.Success (batched acks OK)
// solve check:
const networkTarget = bitsToTarget(job.nbitsHex);
const solveTarget = min(networkTarget, job.target >> policyShift);   // parity with V1 stratum.ts:671-674
if (hv <= networkTarget) → emit SolveEvent (see b.4)
```
Duplicate detection: per-channel `Set` of `(jobId,en2,ntime,version,nonce)` → `SubmitShares.Error "duplicate-share"` (+ onReject 'duplicate'), mirroring V1.

Because validation goes through `wire.buildHeader(versionHex, …)` directly (not `variant.headerFor`, which hardcodes the template version), the path already supports a rolled version. For v1 we ship `versionRollingAllowed=false` (parity with the V1 ASIC listener, which has no version field); flipping it on later needs only the additive job.ts change in §f Phase 6.

### b.4 Solve path (reuses the enqueued `handleSolve`, no MiningPool change)
When a share also meets `networkTarget`, `Sv2Server` emits a `SolveEvent` whose **`jobId` is the pool jobId** (`job.poolJobId`), so `MiningPool.handleSolve` (miningPool.ts:318-360) finds the `BuiltJob` in `jobsById` and re-personalizes + `assemble` + `submitblock` exactly as for V1:
```ts
onSolve({ jobId: job.poolJobId, extranonce1Hex: en1, extranonce2Hex: en2, ntimeHex: hex8(ntime),
  nonceHex: hex8(nonce), hashDisplay: headerHashDisplay(header), height: job.height,
  userId: ch.auth.userId, miningId: ch.auth.miningId, worker: ch.userIdentity || ch.auth.miningId,
  walletId: ch.auth.walletId, address: ch.auth.address,
  payoutScriptHex: toHex(ch.auth.payoutScript), coinbaseValueSats: job.coinbaseValueSats });
```
`handleSolve` re-personalizes from `jobsById.get(poolJobId)` using `payoutScriptHex`, calls `variant.assemble(en1, en2, ntime, nonce)`, asserts `assembled.blockHashDisplay === hashDisplay` (miningPool.ts:333), then `submitblock`. **The full segwit block is assembled by the existing `assemble` closure** (job.ts:162-178, which re-adds the witness commitment) — SV2 does not build blocks itself. For v1 (`versionRollingAllowed=false`) the submitted `version` equals the template version, so `assemble`'s hardcoded version matches; the `blockHashDisplay` assertion is the guard that catches any mismatch.

### b.5 Vardiff → `SetTarget`
`SetTarget(channel_id, maximum_target)` where `maximum_target = targetToU256LE(difficultyToTarget(newDiff))`. Reuse the V1 `VardiffOptions` semantics per channel; on adjustment, update `ch.target` and send `SetTarget`. Per wire ref: applies to future jobs + already-received future jobs, not retroactively — so new `FrozenJob`s created after the change carry the new target; in-flight active jobs keep their announce-time target (the frozen `job.target`). **v1 ships static target** (channel target = `shareDifficulty`); vardiff is Phase 6 (design the hook now, wire later). `UpdateChannel` (client-driven nominal-hashrate/maximum-target) is honored by sending `SetTarget` when the requested `maximum_target` is smaller than current.

### b.6 Standard-channel support
Standard channels are mandatory (servers MUST support both). Handled above: on `OpenStandardMiningChannel`, assign an 8-byte `extranonce_prefix` (full zone, server-owned), reply `OpenStandardMiningChannel.Success{ target, extranonce_prefix(8B), group_channel_id=0 }`, then on each job send **`NewMiningJob`** with the **server-computed `merkle_root`** (b.2 standard branch). The miner rolls only nonce/ntime/version; `SubmitSharesStandard` carries no extranonce, so validation splits the fixed 8-byte prefix into `en1=prefix[0:4]`, `en2=prefix[4:8]` and reuses the identical header/merkle machinery. Group channels (`SetGroupChannel`) are optional and **out of scope for v1** (bandwidth optimization only).

---

## c. Frozen-payout + announce-time-target invariants (SV2 terms)

The `FrozenJob` record (§a.6) is the SV2 expression of both invariants:
- **Frozen payout:** `variant` is `built.personalize({ payoutScript: ch.auth.payoutScript })` captured at announce time and stored in `ch.jobs.get(sv2JobId)`. Share and solve validation read that stored `variant` — the coinbase (and thus payout output) is never re-derived from a different payout at submit time. The channel's `auth.payoutScript` is captured at channel-open; if `authTable` later changes the miner's address, in-flight jobs keep the announced payout (matches V1: payout frozen per `(connection, job)`).
- **Announce-time target:** `job.target = ch.target` snapshotted when the `FrozenJob` is created. A later `SetTarget`/vardiff move updates `ch.target` and future `FrozenJob`s only; shares against an already-announced job are graded against that job's frozen `target`.
- **Never crash the app:** every socket data handler, handshake step, and message dispatch is wrapped so a malformed frame or bad decrypt **terminates only that connection** (destroy socket, `onReject`/log), never throwing into the event loop — mirroring the V1 "every handler wrapped" rule. Solves still route through the single serialized `MiningPool.enqueue` queue, so `submitblock` ordering and the value-conservation assertions are unchanged.

---

## d. `secretKey.ts` refactor + authority/static key custody

### d.1 `secretKey.ts` per-domain-label refactor (qfez8.21), back-compat
Current: one hardcoded label `HKDF_INFO = 'cairn:notification-smtp-pass'` baked into `cipherKey()` (secretKey.ts:36, 90-94); envelope `{v:1, iv, tag, data}`; `decryptSecret` hard-rejects `v !== 1` (:150). Change (all additive, keeps `ENVELOPE_VERSION = 1`):

```ts
// cipherKey gains a label param, defaulting to the legacy label:
function cipherKey(label: string = HKDF_INFO): Buffer {
  return hkdfSync('sha256', getInstanceKey(), Buffer.alloc(0), Buffer.from(label, 'utf8'), 32);
}
// envelope gains an OPTIONAL label field `l`; omitted when label === HKDF_INFO (legacy-identical bytes):
interface Envelope { v: number; iv: string; tag: string; data: string; l?: string; }
export function encryptSecret(plaintext: string, label: string = HKDF_INFO): string {
  // ...encrypt with cipherKey(label); include l:label only when label !== HKDF_INFO
}
export function decryptSecret(envelopeText: string): string {
  // const label = env.l ?? HKDF_INFO;  createDecipheriv with cipherKey(label)
}
```
**Back-compat:** every existing envelope (no `l`) decrypts under the default label → byte-identical behavior for `core_rpc_pass` and per-user SMTP secrets (settings.ts consumers unchanged: `setSecretSetting`/`readSecretSetting`). New callers pass a domain label; the label rides in the envelope so decrypt is self-describing. No `ENVELOPE_VERSION` bump, so the `v !== 1` guard stays. Add domain constant(s): `'cairn:sv2-authority'`. Add a `secretKey.test.ts` case: legacy envelope (no `l`) still decrypts; labelled envelope round-trips; wrong label → auth-tag failure.

### d.2 Authority key (durable trust anchor)
- 32-byte secp secret, generated on first SV2 enable, persisted **encrypted** via `encryptSecret(hex, 'cairn:sv2-authority')` under kv key `mining_sv2_authority_secret`.
- Its x-only pubkey → `authorityPubBase58()` is the value clients pin (published in the `stratum2+tcp://host:port/<b58>` URL surfaced in the mining settings UI). Durable across reboots; rotating it invalidates all pinned clients, so it rotates only on explicit admin action (out of scope for v1 — document the kv key so a future "rotate authority key" action can overwrite it).

### d.3 Static (session) key — **per boot, in-memory**
- Fresh 32-byte static keypair generated at each `Sv2Server` construction (not persisted). `staticFromSecret` derives `xonly32` (cert field) + a 64-byte EllSwift wire encoding.
- **Cert issued at boot** by the persisted authority key: `issueCert(staticXonly32, authoritySecret32)` with `valid_from = now − 300s` (NTP backdate), `not_valid_after = now + 24h`.
- **Rationale:** the durable pinned identity is the authority key; the static key's compromise window is bounded to one boot session, and clients redo the full NX handshake on every (re)connect (`Reconnect`, or TCP drop) and receive the current cert — so there is no need to persist the static key. This is strictly safer than persisting a long-lived static key and costs nothing (handshake regenerates ephemeral keys anyway).
- **Re-issue cadence:** a background timer inside `Sv2Server` re-issues a fresh cert (same in-memory static key, new validity window) every `CERT_VALIDITY_SEC/2` (12h) so long-uptime instances never serve an expiring cert; new handshakes always read the latest cert. On any config change that reconstructs the pool, a new static key + cert is minted.

---

## e. Settings / config plumbing + MiningPool integration

### e.1 Settings (`src/lib/server/mining/settings.ts`)
- `MiningSettings` (settings.ts:19-46) += `sv2Enabled: boolean`, `sv2Port: number`, `sv2ShareDifficulty: number`, `sv2VersionRolling: boolean`.
- `DEFAULTS` (:68-79) += `sv2Enabled: false`, `sv2Port: 3335`, `sv2ShareDifficulty: DEFAULT_ASIC_SHARE_DIFFICULTY` (65536, ASIC-oriented), `sv2VersionRolling: false`.
- `readMiningSettings` (:131-150) += `boolSetting('mining_sv2_enabled', …)`, `intSetting('mining_sv2_port', …)`, `floatSetting('mining_sv2_share_difficulty', …)`, `boolSetting('mining_sv2_version_rolling', …)`. Bind follows the existing `mining_bind` tri-state via `bindHostFor(bind)` (:121-123) — SV2 reuses the same `bindHost`, no new bind key.

### e.2 `MiningEngineConfig` (`src/lib/server/mining/types.ts:166-194`) + `buildEngineConfig` (`index.ts:118-135`)
Add resolved fields: `sv2Enabled`, `sv2Port`, `sv2ShareDifficulty`, `sv2VersionRolling`, threaded from `readMiningSettings` (mirrors how `asicPortEnabled`/`asicPort`/`asicShareDifficulty` are threaded).

### e.3 `MiningPool` diff points (`src/lib/server/mining/miningPool.ts`)
- **Field (~L70):** `private readonly sv2Server: Sv2Server | null;`
- **Constructor (L91-128):** after `asicServer` (L125-127), when `config.sv2Enabled`, construct `Sv2Server` with the `makeServerOpts`-equivalent wiring (`onShare`/`onReject` = same sinks; `onSolve: (e) => this.enqueue(() => this.handleSolve(e))`, L113 pattern) **plus** the SV2-only extras: `authority` (from `authority.ts`: `loadOrCreateAuthorityKey` → `issueCert` → static keypair) and `versionRollingAllowed: config.sv2VersionRolling`. Because `makeServerOpts` (L103-123) returns `StratumServerOptions`, add a small parallel `makeSv2Opts(port, diff)` that returns `Sv2ServerOptions`.
- **`start()` (L135-171):** after `asicServer.listen()` (inside the same bind-failure try/catch, L143-162), `await this.sv2Server?.listen()`; extend the catch to also `close()` the sv2 listener + the others on failure so a bad bind never leaves a half-open pool.
- **`doStop()` (L179-195):** add `this.sv2Server?.close()` to the try/finally listener-close block (L188-192).
- **`status()` (L197-219):** include `sv2Server` connections/minerCount in the aggregation and push a `ListenerInfo{ role:'sv2', port, connections }`.
- **`installJob()` (L296-314):** after `this.asicServer?.setJob(built)` (L313), add `this.sv2Server?.setJob(built)`.

### e.4 `ListenerInfo` / `ConnectionInfo` tagging (`types.ts`, additive)
- `ListenerInfo.role` (types.ts:140-144): `'standard' | 'asic'` → `'standard' | 'asic' | 'sv2'`.
- `ConnectionInfo` (types.ts:129-137) += optional `protocol?: 'v1' | 'sv2'` (default `'v1'`; V1 code unchanged, `Sv2Server.connections()` sets `'sv2'`). Additive — no downstream break; `aggregates.ts`/`index.ts` consume only the flat event shapes and never inspect the tag.

---

## f. Phased build order (fast-worker tasks)

Each phase is independently testable and lands with its vitest suite green. Test-file naming mirrors the existing suite (`wire.test.ts`, `job.test.ts`, `stratum.test.ts`, `miningPool.test.ts`, `forcedSolve.e2e.test.ts`).

**Phase 0 — foundation: deps + crypto wrapper.**
Files: `package.json` (pin `@scure/btc-signer` to the exact installed `2.2.0` that ships `p2p.js`; add a comment that the SV2 handshake depends on `p2p.js#elligatorSwift`), `sv2/crypto.ts`, `sv2/crypto.test.ts`.
Tests: BIP324 ellswift ECDH agreement (initiator vs responder secrets equal — the §9 self-check as a vitest); `staticFromSecret` round-trips (`decode(ell64) === xonly32`); schnorr sign/verify; `hkdf2` against a known Noise HKDF vector; `chachaSeal`/`chachaOpen` round-trip + tamper→throw; nonce builder (`4 zero ‖ LE u64`). Mirror: `wire.test.ts` style.

**Phase 1 — codec + frames.**
Files: `sv2/codec.ts`, `sv2/frames.ts`, `sv2/codec.test.ts`, `sv2/frames.test.ts`.
Tests: round-trip encode/decode for every message in §a.2 (including `OPTION[U32]` present/absent, `SEQ0_255[U256]`, `B0_64K`); **fuzz** — 10k random byte payloads into each `decode*` never throw uncaught (must throw a typed `Sv2DecodeError` or return, never crash); `encodeHeader`/`decodeHeader`; `ptLenToCtLen` table incl. boundaries (0, 1, 65519, 65520, 131038); `channel_msg` bit set/mask (`& 0x0001`, `& 0xFFFE`). Mirror: `wire.test.ts`.

**Phase 2 — noise handshake + authority.**
Files: `sv2/noise.ts`, `sv2/authority.ts`, `sv2/noise.test.ts`, `sv2/authority.test.ts`. (Uses a minimal `NoiseInitiator` test helper — lands early inside `testClient.ts` skeleton.)
Tests: full NX self-talk — initiator ↔ `NoiseResponder` complete handshake, `split()` yields matching `recv`/`send` keys, an encrypted frame decrypts both directions; **Act-2 length === 234** (assert + `TODO(interop)` note re: spec's 170); client verifies the cert against the authority pubkey + validity window; tamper a handshake byte → decrypt throws → session-terminate; `authority.ts` cert digest + base58check round-trip (spec §4.7 vector); legacy-envelope back-compat lives in `secretKey.test.ts`. Mirror: new (no direct analog).

**Phase 3 — channels + job mapping.**
Files: `sv2/channels.ts`, `sv2/channels.test.ts`.
Tests: from a fixed `BuiltJob` fixture (reuse `job.test.ts` template fixture), `openExtended` → `jobMessagesFor` produces `coinbaseTxPrefix === coinb1`, `coinbaseTxSuffix === coinb2`, `merklePath === merkleBranchesInternalHex`; `openStandard` → `merkleRoot` equals an independent `wire.applyBranches(sha256d(coinb1‖prefix8‖coinb2), branches)`; clean vs refresh → `setPrevHash` present iff `cleanJobs`; `min_extranonce_size` 0/4/8 → correct prefix/size split; `>8` → throws; extranonce-prefix uniqueness across channels. Mirror: `job.test.ts`.

**Phase 4 — the listener + engine wiring.**
Files: `sv2/sv2Server.ts`, `sv2/index.ts`, finish `sv2/testClient.ts`, edits to `types.ts` (ListenerInfo/ConnectionInfo/MiningEngineConfig), `mining/settings.ts` (sv2 keys), `mining/index.ts` (`buildEngineConfig` + pool construction wiring `onShare`/`onReject`/`onSolve`), `miningPool.ts` (third listener per §e.3). Tests: `sv2/sv2Server.test.ts`, `settings.test.ts` (+sv2 defaults/reads).
Tests: `testClient` connects over a real loopback socket → handshake → `SetupConnection`/`Success` → `OpenExtendedMiningChannel`/`Success` → receives `NewExtendedMiningJob` + `SetNewPrevHash` after `setJob` → submits a valid share (`onShare` fired, `SubmitShares.Success` received) → submits low-diff (`SubmitShares.Error` + `onReject('low_difficulty')`) → duplicate (`onReject('duplicate')`) → stale job id (`onReject('stale')`). Standard-channel variant. `maxConnections`/handshake-timeout DoS caps. Mirror: `stratum.test.ts` + `miningPool.test.ts`.

**Phase 5 — e2e forced solve + V1/V2 parity.**
Files: `sv2/forcedSolve.e2e.test.ts` (or extend the existing one).
Tests: drive `Sv2Server` through a real `MiningPool` with a mock `RpcLike` and a template whose target is trivially met; `testClient` submits the winning nonce → `onSolve` fires → `handleSolve` calls `submitblock` with a block whose bytes are **byte-identical** to a V1 solve for the same template + same payout + same extranonce (the parity assertion: SV2 and V1 must assemble the same block). Assert `blockHashDisplay` matches and value-conservation holds. Mirror: `forcedSolve.e2e.test.ts`.

**Phase 6 — fast-follow (optional, post-first-ship).**
- Per-channel vardiff → `SetTarget` (wire the `VardiffOptions` hook designed in §b.5).
- Version rolling: additive optional `versionOverrideHex?` param to `job.ts` `headerFor`/`assemble` (default = template version → V1 behavior byte-identical), then flip `sv2VersionRolling` default handling to advertise `version_rolling_allowed=true` and thread the rolled version into `assemble`.
- SRI interop: run a real `sv2` reference miner/proxy against port 3335 to confirm Act-2 length (234 vs 170), channel_msg wire values, and cert format; capture as a manual QA runbook entry.

---

## g. Mock V2 client (`sv2/testClient.ts`, test-only)

A minimal **initiator** that reuses `codec.ts`, `frames.ts`, `crypto.ts` (never a second codec). Because NX is a 2-message handshake (`-> e` ; `<- e, ee, s, es`), the client:
```ts
export class Sv2TestClient {
  constructor(authorityXonly32: Uint8Array);   // to verify the server cert
  connect(socket: net.Socket): Promise<void>;   // Act-1 send, Act-2 recv+verify cert, split()
  setupConnection(flags?: number): Promise<{ usedVersion: number; flags: number }>;
  openExtended(userIdentity: string, minExtranonceSize?: number): Promise<{ channelId: number; extranoncePrefix: Uint8Array; extranonceSize: number; target: Uint8Array }>;
  openStandard(userIdentity: string): Promise<{ channelId: number; extranoncePrefix: Uint8Array; target: Uint8Array }>;
  onJob(cb: (job: NewExtendedMiningJobDecoded | NewMiningJobDecoded) => void): void;
  onPrevHash(cb: (m: SetNewPrevHashDecoded) => void): void;
  submitExtended(a: { channelId: number; jobId: number; nonce: number; ntime: number; version: number; extranonce: Uint8Array }): Promise<'ok' | { error: string }>;
  submitStandard(a: { channelId: number; jobId: number; nonce: number; ntime: number; version: number }): Promise<'ok' | { error: string }>;
  /** Test helper: brute a nonce that meets a given target for the current job (small target in tests). */
  mineOnce(job: NewExtendedMiningJobDecoded, prev: SetNewPrevHashDecoded, target: bigint): { nonce: number; ntime: number; version: number; extranonce: Uint8Array } | null;
}
```
The initiator ECDH calls pass `initiator=true` to `ecdhSv2`. `mineOnce` reconstructs the coinbase from `coinbase_tx_prefix ‖ extranonce_prefix ‖ extranonce ‖ coinbase_tx_suffix`, folds `merkle_path`, builds the header via `wire.buildHeader`, and scans nonce space — proving the client-side coinbase reconstruction matches the server's (the core interop guarantee).

---

## h. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | EllSwift/BIP324 availability | **Resolved** | Reuse `@scure/btc-signer/p2p.js#elligatorSwift` (verified, §9). Pin exact dep version; the module is marked "experimental", so lock it + guard with BIP324 test vectors. Fallback if a future bump drops `p2p.js`: vendor the ~150-line implementation (it is self-contained; source read at `node_modules/@scure/btc-signer/src/p2p.ts`). |
| 2 | Act-2 length 234 vs spec's stated 170 | Med | Emit 234 (itemized sum), unit-assert it, `TODO(interop)`; Phase 6 SRI cross-check. If SRI disagrees, adjust the responder only (isolated). |
| 3 | Nonce / endianness bugs (Noise counter, U256 LE, prevhash word order) | High | All byte-order math via `wire.ts` (`displayToInternal`, `applyBranches`, `bitsToTarget`) — never re-implemented. Chacha nonce = `4 zero bytes ‖ LE u64 counter` (12B IETF); explicit unit vectors; counter post-increment + reset-on-`MixKey` tested. |
| 4 | Merkle root byte order (standard channel) | High | `merkleRootLE` computed with the same `sha256d`+`applyBranches` the V1 path uses; Phase 3 asserts equality vs an independent recompute and Phase 5 asserts block-byte parity with V1. |
| 5 | TCP partial reads / backpressure | Med | `PlaintextFrameReader`/`TransportReader` accumulate across chunks; never assume `chunk == frame`; `socket.write` return value respected (pause on false, resume on `drain`). |
| 6 | DoS (pre-auth) | Med | Max buffered bytes cap pre-handshake; handshake acts are fixed sizes (reject anything off-size); `handshakeTimeoutMs` (10s) to complete Noise + `SetupConnection`; per-message sane length caps (< the U24 16MB max); idle timeout; `maxConnections` (default 64) as global + per-IP cap. Any violation → destroy that socket only. |
| 7 | Version rolling mismatch → invalid block | Med | v1 ships `versionRollingAllowed=false` (parity with V1 ASIC listener); validation already routes through `wire.buildHeader(version…)` so enabling later is the additive job.ts change in Phase 6 — never a silent wrong-version block (the `blockHashDisplay` assert in `handleSolve` is the backstop). |
| 8 | Frozen-payout / target drift | High | `FrozenJob` snapshots `variant`+`target` at announce; share/solve read the stored record, never re-derive; solve routes through the single `MiningPool.enqueue` queue → `handleSolve` re-personalizes the *same* payout and asserts hash match before `submitblock`. |
| 9 | Key custody / clock skew | Med | Authority secret encrypted via per-domain `secretKey.ts`; static key per-boot; cert `valid_from` backdated 300s; 12h re-issue timer; clients re-handshake on reconnect for a fresh cert. |
| 10 | App crash from a bad connection | High | Every socket/handshake/dispatch handler wrapped; failure terminates one session (log + `onReject`), never throws into the loop — mirrors the V1 "never crash the app" invariant. |
| 11 | `secretKey.ts` back-compat regression | Med | Optional envelope `l` field + default label = legacy `HKDF_INFO`; `ENVELOPE_VERSION` unchanged; `secretKey.test.ts` proves old (no-`l`) envelopes still decrypt for `core_rpc_pass`/SMTP. |

---

## Deviations from the brief's assumptions
1. **No `ellswift.ts` module** — the highest-risk crypto piece is already implemented in `@scure/btc-signer/p2p.js` (a shipped dep) and verified to compute SV2's exact ECDH. The brief's `ellswift.ts` becomes a thin `crypto.ts` wrapper; no BIP324 XSwiftEC/XSwiftECInv code is written.
2. **No `job.ts` change for v1** — the existing 8-byte extranonce zone and legacy coinbase serialization already equal SV2's `coinbase_tx_prefix`/`suffix`; extended = 4/4 prefix/size, standard = 8/0. Version rolling (which would need an additive `assemble` param) is deferred to Phase 6.
3. **`aggregates.ts` / `index.ts`, not `aggregates/index.ts`** — the events sink is `aggregates.ts`; wiring is `mining/index.ts` (confirmed listener-agnostic).
4. **Static key per boot, authority key persisted** — chosen over persisting the static key (bounded compromise window, free because handshake regenerates ephemerals anyway).
