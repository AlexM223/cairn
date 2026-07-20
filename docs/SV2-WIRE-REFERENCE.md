<!-- Distilled 2026-07-20 from stratum-mining/sv2-spec@main (03-Protocol-Overview, 04-Protocol-Security, 05-Mining-Protocol, 08-Message-Types) + BIP320, for the Heartwood native SV2 listener build. Canonical codec reference for implementers. -->

# Stratum V2 Server (Pool-Side) Wire-Level Implementation Reference

Sources: raw markdown from github.com/stratum-mining/sv2-spec (main): 03-Protocol-Overview.md, 04-Protocol-Security.md, 05-Mining-Protocol.md, 08-Message-Types.md; BIP320 for version-rolling mask.

## 1. FRAMING
### 1.1 Plaintext frame header — 6 bytes
| Field | Type | Bytes | Notes |
|---|---|---|---|
| extension_type | U16 | 2 | LE. 0x0000 for all core-spec messages. |
| msg_type | U8 | 1 | Message id (see §4). |
| msg_length | U24 | 3 | LE. Payload length excluding this 6-byte header. |
| payload | BYTES | msg_length | If channel_msg bit set, first 4 payload bytes are U32 channel_id (LE), counted in msg_length and also listed as the message's first field (don't double-prepend). |

channel_msg bit = least significant bit of extension_type: `extension_type & 0x0001` = channel_msg flag; `extension_type & 0xFFFE` = extension id for lookup. Core-protocol wire values: 0x0000 (non-channel) or 0x0001... NOTE: sv2 messages listed channel_msg=1 in §4 are sent with the channel_msg bit set (wire extension_type 0x0001 for core protocol; SRI may also emit 0x8000-style values — mask with 0xFFFE for lookup and tolerate either on receive; verify against SRI in interop tests).

### 1.2 Noise-encrypted framing
After handshake, every frame is encrypted with the two CipherStates (c1=initiator→responder, c2=responder→initiator) via EncryptWithAd([], header) and EncryptWithAd([], payload) — zero-length AD for both.
- Max Noise ciphertext per AEAD block = 65535 bytes.
- The 6-byte header is always its own AEAD call → fixed 22-byte ciphertext (6 + 16 MAC).
- msg_length inside the header is the PLAINTEXT payload length; receiver derives ciphertext length.
- Payload > 65519 plaintext bytes is split into 65519-byte chunks, each AEAD-encrypted to 65535-byte blocks; last block 17–65535 bytes.

Plaintext→ciphertext length conversion (implement exactly):
```c
#define MAX_CT_LEN 65535
#define MAC_LEN 16
#define MAX_PT_LEN (MAX_CT_LEN - MAC_LEN)   // 65519
uint pt_len_to_ct_len(uint pt_len) {
    uint remainder = pt_len % MAX_PT_LEN;
    if (remainder > 0) { remainder += MAC_LEN; }
    return pt_len / MAX_PT_LEN * MAX_CT_LEN + remainder;
}
```
Decrypt procedure: (1) read exactly 22 bytes, decrypt → 6-byte header or fail; (2) convert msg_length to ct length, read, decrypt → payload; (3) deserialize per (extension_type & 0xFFFE, msg_type). Any decrypt failure ⇒ terminate session (nonce not incremented on failure).

AEAD nonce: CipherState holds 32-byte key k, counter n starting 0. Nonce = 32 zero bits || little-endian 64-bit counter; post-increment per call. AEAD = ChaCha20-Poly1305 IETF (RFC 8439).

## 2. SERIALIZATION (all multibyte LE)
| Type | Bytes | Rule |
|---|---|---|
| BOOL | 1 | LSB = value; ignore upper bits on receive |
| U8/U16/U24/U32/U64 | 1/2/3/4/8 | unsigned LE |
| U256 | 32 | LE; raw SHA-256 output interpreted as unsigned int |
| STR0_255 | 1+L | U8 length prefix + raw bytes, no NUL |
| B0_32 / B0_255 | 1+L | U8 length prefix |
| B0_64K | 2+L | U16 LE length prefix |
| B0_16M | 3+L | U24 LE length prefix |
| BYTES | L | length from context |
| MAC | 16 | AEAD tag |
| PUBKEY | 32 | x-only secp256k1 (BIP340) |
| SIGNATURE | 64 | BIP340 Schnorr |
| OPTION[T] | 1 + (present?size(T):0) | = SEQ0_1[T] |
| SEQ0_255[T] | 1 + n*size | U8 count then elements |
| SEQ0_64K[T] | 2 + n*size | U16 LE count then elements |
F32 (nominal_hash_rate): 4-byte LE IEEE-754 single.

## 3. NOISE HANDSHAKE
Mandatory for remote connections. Primitives: secp256k1; BIP340 Schnorr (key-prefixed); SHA-256; ChaCha20-Poly1305 IETF. Point encodings: certificates use 32-byte x-only; handshake keys on the wire use 64-byte ElligatorSwift (BIP324); authority pubkey distributed as base58check.

Key generation: random 32-byte sk (reject 0 or >= group order n); P = sk·G; (u,t) = XElligatorSwift(P.x); ellswift_pub = bytes(u)||bytes(t) (64B). No Y-parity grinding — algorithms implicitly negate.

Core ops (standard Noise unless noted):
- HKDF(ck, ikm): temp=HMAC-SHA256(ck, ikm); out1=HMAC(temp, 0x01); out2=HMAC(temp, out1||0x02).
- MixKey(ikm): (ck, temp_k)=HKDF(ck, ikm); InitializeKey(temp_k) (k=temp_k, n=0).
- MixHash(d): h = SHA256(h||d).
- EncryptAndHash(pt): if k set → ct=EncryptWithAd(h, pt) else ct=pt; MixHash(ct); return ct.
- DecryptAndHash(ct): if k set → pt=DecryptWithAd(h, ct) else pt=ct; MixHash(ct); return pt.
- ECDH(k, rk) = BIP324 v2_ecdh:
  v2_ecdh(k, ellswift_k, rk, initiator): x = ellswift_ecdh_xonly(rk, k); initiator ? tagged_hash(ellswift_k, rk, x) : tagged_hash(rk, ellswift_k, x).
  tagged_hash(a,b,c): tag=SHA256("bip324_ellswift_xonly_ecdh"); SHA256(tag||tag||a||b||c). NOT role-commutative — track initiator flag.

Act 0 (both): protocolName = "Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256"; h=SHA256(protocolName); ck=h; h=SHA256(h); k=empty.

Act 1 (client→server), 64 bytes: client generates ephemeral e, sends e.pub EllSwift (64B plaintext). Both MixHash(e.public_key). (EncryptAndHash on empty payload = MixHash of empty.)

Act 2 (server→client): server: generate ephemeral e; append e.pub (64B plaintext); MixHash(e.pub); MixKey(ECDH(e.priv, re.pub)) [ee]; append EncryptAndHash(s.pub 64B EllSwift) → 80B; MixKey(ECDH(s.priv, re.pub)) [es]; append EncryptAndHash(SIGNATURE_NOISE_MESSAGE 74B) → 90B; send. Then (temp_k1,temp_k2)=HKDF(ck, zerolen); c1.InitializeKey(temp_k1) [client→server]; c2.InitializeKey(temp_k2) [server→client].
Wire total: 64+80+90 = 234 bytes. WARNING: spec text says "170 bytes" — itemized sum is 234; treat 234 as authoritative but VERIFY against SRI reference implementation in interop tests (flag: spec erratum).

SIGNATURE_NOISE_MESSAGE (74B): version U16 | valid_from U32 | not_valid_after U32 | signature SIGNATURE(64).

Certificate the client reconstructs and verifies: signed fields = version, valid_from, not_valid_after, server_public_key (32B x-only, decoded from the EllSwift static key). m = SHA256(version||valid_from||not_valid_after||server_public_key) with fields wire-serialized (LE). BIP340 Schnorr over m by the AUTHORITY key. Client checks signature against known authority pubkey + validity window vs current time.

Authority pubkey distribution: base58check(2-byte version prefix [1,0] + 32-byte x-only key), e.g. embedded in stratum2+tcp://host:port/<base58key> URL. Round-trip test vector in spec §4.7.

## 4. MESSAGE TYPES (msg_type / channel_msg)
Common: SetupConnection 0x00/0; SetupConnection.Success 0x01/0; SetupConnection.Error 0x02/0; ChannelEndpointChanged 0x03/1; Reconnect 0x04/0.
Mining: OpenStandardMiningChannel 0x10/0; .Success 0x11/0; OpenMiningChannel.Error 0x12/0; OpenExtendedMiningChannel 0x13/0; .Success 0x14/0; NewMiningJob 0x15/1; UpdateChannel 0x16/1; UpdateChannel.Error 0x17/1; CloseChannel 0x18/1; SetExtranoncePrefix 0x19/1; SubmitSharesStandard 0x1a/1; SubmitSharesExtended 0x1b/1; SubmitShares.Success 0x1c/1; SubmitShares.Error 0x1d/1; (0x1e reserved); NewExtendedMiningJob 0x1f/1; SetNewPrevHash 0x20/1; SetTarget 0x21/1; SetCustomMiningJob 0x22/1; .Success 0x23/1; .Error 0x24/1; SetGroupChannel 0x25/0.

Field lists (ordered, exact):
- SetupConnection: protocol U8 (Mining=0) | min_version U16 (=2) | max_version U16 (=2) | flags U32 | endpoint_host STR0_255 | endpoint_port U16 | vendor STR0_255 | hardware_version STR0_255 | firmware STR0_255 | device_id STR0_255. Flags (client): bit0 REQUIRES_STANDARD_JOBS, bit1 REQUIRES_WORK_SELECTION, bit2 REQUIRES_VERSION_ROLLING.
- SetupConnection.Success: used_version U16 | flags U32. Flags (server): bit0 REQUIRES_FIXED_VERSION (mutually exclusive with client REQUIRES_VERSION_ROLLING), bit1 REQUIRES_EXTENDED_CHANNELS.
- SetupConnection.Error: flags U32 (all unsupported flags) | error_code STR0_255.
- ChannelEndpointChanged: channel_id U32.
- Reconnect: new_host STR0_255 (empty=keep) | new_port U16 (0=keep). Client redoes full handshake, same authority key.
- OpenStandardMiningChannel: request_id U32 | user_identity STR0_255 | nominal_hash_rate F32 | max_target U256.
- OpenStandardMiningChannel.Success: request_id U32 | channel_id U32 | target U256 | extranonce_prefix B0_32 | group_channel_id U32.
- OpenExtendedMiningChannel: request_id U32 | user_identity STR0_255 | nominal_hash_rate F32 | max_target U256 | min_extranonce_size U16.
- OpenExtendedMiningChannel.Success: request_id U32 | channel_id U32 | target U256 | extranonce_size U16 | extranonce_prefix B0_32 | group_channel_id U32.
- OpenMiningChannel.Error: request_id U32 | error_code STR0_255.
- UpdateChannel: channel_id U32 | nominal_hash_rate F32 | maximum_target U256 (if smaller than current, server MUST honor via SetTarget).
- UpdateChannel.Error: channel_id U32 | error_code STR0_255.
- CloseChannel: channel_id U32 | reason_code STR0_255.
- SetExtranoncePrefix: channel_id U32 | extranonce_prefix B0_32.
- SubmitSharesStandard: channel_id U32 | sequence_number U32 | job_id U32 | nonce U32 | ntime U32 | version U32.
- SubmitSharesExtended: + extranonce B0_32 (size MUST equal negotiated extranonce_size).
- SubmitShares.Success: channel_id U32 | last_sequence_number U32 | new_submits_accepted_count U32 | new_shares_sum U64 (sum of difficulty in batch). Server need not verify seq monotonicity.
- SubmitShares.Error: channel_id U32 | sequence_number U32 | error_code STR0_255.
- NewMiningJob (standard channels; MUST be first message after standard channel opens, first one future/min_ntime unset): channel_id U32 | job_id U32 | min_ntime OPTION[U32] (unset=future job) | version U32 | merkle_root U256.
- NewExtendedMiningJob: channel_id U32 (channel or group id) | job_id U32 | min_ntime OPTION[U32] | version U32 | version_rolling_allowed BOOL | merkle_path SEQ0_255[U256] (deepest-first) | coinbase_tx_prefix B0_64K | coinbase_tx_suffix B0_64K. BIP141 marker/flag/witness stripped from prefix/suffix (server keeps full segwit original internally for block assembly).
- SetNewPrevHash: channel_id U32 | job_id U32 (now-valid job; all other queued jobs invalidated) | prev_hash U256 | min_ntime U32 | nbits U32.
- SetTarget: channel_id U32 | maximum_target U256. Applies to future jobs + already-received future jobs, not retroactively to active jobs.
- SetGroupChannel: group_channel_id U32 | channel_ids SEQ0_64K[U32]. Only on connections without REQUIRES_STANDARD_JOBS. Group id shares namespace with channel ids.
- SetCustomMiningJob family: only needed with REQUIRES_WORK_SELECTION — out of scope for v1 (reject flag in SetupConnection.Error or refuse).

Error codes: free-form ASCII strings everywhere; no canonical enum; drive behavior off protocol state, log unknown codes.

## 5. SERVER SEMANTICS
- Extranonce: full extranonce = extranonce_prefix (server-owned) + extranonce (client-owned, extranonce_size bytes, extended only). Coinbase: standard = prefix_tx + extranonce_prefix + suffix_tx; extended = prefix_tx + extranonce_prefix + extranonce + suffix_tx.
- Merkle root: coinbase_txid = sha256d(coinbase_tx) [BIP141-stripped serialization]; fold: for each leaf in merkle_path (deepest-first): root = sha256d(root || leaf_LE); result read as LE U256.
- Group-channel constraint: all channels under one group MUST share identical total extranonce size.
- Version rolling: BIP320 mask 0x1fffe000 (bits 13–28). version_rolling_allowed on extended jobs; standard channels governed by connection flags. REQUIRES_VERSION_ROLLING ⊕ REQUIRES_FIXED_VERSION.
- ntime: submitted ntime >= SetNewPrevHash.min_ntime and <= min_ntime + seconds since that SetNewPrevHash (tolerance window; cap by consensus 2h future rule).
- Future jobs: min_ntime unset ⇒ not minable until SetNewPrevHash names its job_id (activates it, invalidates all others on the channel). Server MAY precompute; SHOULD follow activation with a fresh conflict-free job.
- channel_id: U32 unique per connection lifetime, server-assigned. job_id: U32, server-assigned, uniqueness per channel scope; monotonic counter fine.
- Share validation: build 80-byte header (version|prev_hash|merkle_root|ntime|nbits|nonce), sha256d, compare as int vs channel target ("hashes higher than target rejected"). SubmitShares.Error per rejected submit; SubmitShares.Success may batch acks.
- Requirements: servers MUST support BOTH standard and extended channels. Group channels optional (bandwidth optimization). REQUIRES_STANDARD_JOBS ⇒ only NewMiningJob on that connection, never NewExtendedMiningJob/SetGroupChannel. Client REQUIRES_VERSION_ROLLING ⇒ never disallow rolling. Unknown extension_type with channel_msg unset at terminating endpoint ⇒ discard/ignore. Extensions Negotiation (0x0001) only needed if supporting extensions — v1: none.

## 6. OPEN ITEMS
1. Act-2 length: 234 vs spec's stated 170 — verify vs SRI noise_sv2.
2. Error-code strings: define our own documented set.
3. Cert validity: SRI templates use cert_validity_sec=3600; NTP drift causes InvalidCertificate at seconds-level skew — issue with generous valid_from backdating (e.g. -5 min) and refresh before expiry.
