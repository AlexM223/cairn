/**
 * SV2 authority keypair custody (docs/SV2-IMPLEMENTATION-PLAN.md §a.5/§d.2-3):
 * the durable trust anchor clients pin (base58check pubkey, published in the
 * `stratum2+tcp://host:port/<b58>` mining-settings URL) plus per-boot
 * static-key certificate issuance signed by that authority key.
 *
 * Key custody split:
 *  - AUTHORITY key: 32-byte secp secret, generated once on first SV2 enable,
 *    persisted ENCRYPTED via secretKey.ts's per-domain envelope
 *    (`encryptSecret(hex, SV2_AUTHORITY_DOMAIN)`) under kv key
 *    `mining_sv2_authority_secret` in the `instance_secrets` table. Durable
 *    across reboots; this module never rotates it automatically (rotation
 *    invalidates every pinned client — an explicit future admin action, see
 *    §d.2).
 *  - STATIC (session) key: generated fresh per `Sv2Server` boot by the CALLER
 *    (crypto.ts's `ellswiftKeygen`/`staticFromSecret`) — this module only
 *    signs a cert FOR a given static xonly pubkey via `issueCert`; it does not
 *    generate or hold the static key itself (§d.3: compromise window bounded
 *    to one boot session, never persisted).
 *
 * Persistence note (qfez8.21, resolved by the Phase 4 owner): `setSecretSetting`/
 * `readSecretSetting` (settings.ts) now accept/self-describe a domain `label`,
 * so this module goes through them like every other instance_secrets writer —
 * no more hand-rolled SQL. `readSecretSetting` needs no label argument on read:
 * the label rides in secretKey.ts's envelope (`Envelope.l`) and `decryptSecret`
 * picks the matching HKDF domain automatically.
 *
 * Dependency direction: `certDigest`/`encodeSignatureNoiseMessage`/
 * `SignedCert` are DEFINED in noise.ts (the initiator needs the identical
 * digest/encoding to verify what this module signs) and re-exported here —
 * see noise.ts's module doc comment for why the dependency runs this
 * direction and not the reverse.
 */

import { createBase58check } from '@scure/base';
import { readSecretSetting, setSecretSetting } from '../../settings';
import { randomSecret32, schnorrSign, sha256, staticFromSecret } from './crypto';
import { certDigest, encodeSignatureNoiseMessage, type SignedCert } from './noise';

export { certDigest, encodeSignatureNoiseMessage, decodeSignatureNoiseMessage, type SignedCert } from './noise';

/** secretKey.ts HKDF domain label for the persisted authority secret. */
export const SV2_AUTHORITY_DOMAIN = 'cairn:sv2-authority';
/** `instance_secrets` kv key the encrypted authority secret is stored under. */
export const AUTHORITY_SECRET_KV_KEY = 'mining_sv2_authority_secret';

export const CERT_VERSION = 0;
export const CERT_VALIDITY_SEC = 24 * 3600;
/** NTP-skew tolerance: certs are signed with `valid_from` this far in the past. */
export const CERT_BACKDATE_SEC = 300;
/** Re-issue cadence (§d.3): half the validity window, so a long-uptime
 *  instance's cert is always refreshed well before it actually expires. */
export const CERT_REISSUE_INTERVAL_SEC = CERT_VALIDITY_SEC / 2; // 12h

export class Sv2AuthorityError extends Error {}

const b58check = createBase58check(sha256);
/** spec §4.7: 2-byte version prefix [1, 0] ‖ 32-byte x-only key. */
const AUTHORITY_B58_VERSION = Uint8Array.of(1, 0);

// ---------------------------------------------------------------------------
// Authority key persistence
// ---------------------------------------------------------------------------

/** Load (or first-run create + persist encrypted) the durable authority keypair. */
export function loadOrCreateAuthorityKey(): { secret32: Uint8Array; xonly32: Uint8Array } {
	const hex = readSecretSetting(AUTHORITY_SECRET_KV_KEY);

	if (hex) {
		const secret32 = Buffer.from(hex, 'hex');
		if (secret32.length !== 32) {
			throw new Sv2AuthorityError(
				`stored SV2 authority secret is ${secret32.length} bytes, expected 32 (key=${AUTHORITY_SECRET_KV_KEY})`
			);
		}
		const { xonly32 } = staticFromSecret(secret32);
		return { secret32: new Uint8Array(secret32), xonly32 };
	}

	const secret32 = randomSecret32();
	persistAuthoritySecret(secret32);
	const { xonly32 } = staticFromSecret(secret32);
	return { secret32, xonly32 };
}

function persistAuthoritySecret(secret32: Uint8Array): void {
	const hex = Buffer.from(secret32).toString('hex');
	setSecretSetting(AUTHORITY_SECRET_KV_KEY, hex, SV2_AUTHORITY_DOMAIN);
}

/**
 * Explicit rotation (out of scope for v1 wiring per §d.2 — exposed so a future
 * admin action has a documented entry point instead of hand-rolling the SQL).
 * Rotating invalidates every client pinned to the old authority pubkey.
 */
export function rotateAuthorityKey(): { secret32: Uint8Array; xonly32: Uint8Array } {
	const secret32 = randomSecret32();
	persistAuthoritySecret(secret32);
	const { xonly32 } = staticFromSecret(secret32);
	return { secret32, xonly32 };
}

// ---------------------------------------------------------------------------
// base58check pubkey encoding (spec §4.7)
// ---------------------------------------------------------------------------

/** base58check([1,0] ‖ xonly32) — the value published in stratum2+tcp://host:port/<b58>. */
export function authorityPubBase58(xonly32: Uint8Array): string {
	if (xonly32.length !== 32) {
		throw new Sv2AuthorityError(`authority xonly pubkey must be 32 bytes, got ${xonly32.length}`);
	}
	const payload = new Uint8Array(34);
	payload.set(AUTHORITY_B58_VERSION, 0);
	payload.set(xonly32, 2);
	return b58check.encode(payload);
}

/** Inverse of {@link authorityPubBase58}: decode + validate the [1,0] version prefix. */
export function authorityPubFromBase58(encoded: string): Uint8Array {
	let payload: Uint8Array;
	try {
		payload = b58check.decode(encoded);
	} catch (e) {
		throw new Sv2AuthorityError(`malformed base58check authority pubkey: ${String(e)}`);
	}
	if (payload.length !== 34) {
		throw new Sv2AuthorityError(`decoded authority pubkey must be 34 bytes, got ${payload.length}`);
	}
	if (payload[0] !== AUTHORITY_B58_VERSION[0] || payload[1] !== AUTHORITY_B58_VERSION[1]) {
		throw new Sv2AuthorityError(`unexpected authority pubkey version bytes: [${payload[0]}, ${payload[1]}]`);
	}
	return payload.subarray(2);
}

// ---------------------------------------------------------------------------
// Certificate issuance
// ---------------------------------------------------------------------------

/**
 * Issue a cert for a static key, signed by the authority secret (BIP340
 * Schnorr). `valid_from` is backdated by {@link CERT_BACKDATE_SEC} (NTP-skew
 * tolerance) and validity runs {@link CERT_VALIDITY_SEC} from `now`.
 */
export function issueCert(
	staticXonly32: Uint8Array,
	authoritySecret32: Uint8Array,
	now: number = Math.floor(Date.now() / 1000)
): SignedCert {
	const validFrom = now - CERT_BACKDATE_SEC;
	const notValidAfter = now + CERT_VALIDITY_SEC;
	const digest = certDigest(CERT_VERSION, validFrom, notValidAfter, staticXonly32);
	const signature = schnorrSign(digest, authoritySecret32);
	return { version: CERT_VERSION, validFrom, notValidAfter, signature };
}

/**
 * Whether `cert` should be re-issued now: past the re-issue cadence measured
 * from its (approximate) issuance time — `validFrom + CERT_BACKDATE_SEC`, since
 * `issueCert` always backdates `validFrom` by exactly that much — or already
 * past `notValidAfter` outright. Mirrors §d.3's "re-issue a fresh cert every
 * CERT_VALIDITY_SEC/2" background-timer cadence as a pure predicate the caller
 * can poll/schedule against.
 */
export function certNeedsReissue(cert: SignedCert, now: number = Math.floor(Date.now() / 1000)): boolean {
	const issuedAt = cert.validFrom + CERT_BACKDATE_SEC;
	return now >= cert.notValidAfter || now - issuedAt >= CERT_REISSUE_INTERVAL_SEC;
}
