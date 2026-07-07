// Known-device-keys registry (cairn-fdlf.2): a per-user memory of account
// xpubs previously read off a hardware device, keyed by
// (user_id, fingerprint, purpose). Modeled on Bastion's master_keys table
// (UNIQUE(user_id, xfp, purpose)), adapted to Cairn's conventions.
//
// Why it exists: every readSingleSigKeyFrom* / readMultisigKeyFrom* call is a
// fresh live device query with no memory. When the single-sig wizard prefetches
// a BIP-45 sharing key (cairn-fdlf.1), this registry is where it lands, so a
// later collaborative-vault flow (cairn-fdlf.4) can reuse the already-read
// m/45' xpub instead of making the user plug the same device in again.
//
// This is a CONVENIENCE CACHE only. Actual wallet records (wallets /
// multisig_keys) remain the source of truth and never read from here.
//
// The critical invariant — enforced here, not left to callers — is that the
// three purpose families are never conflated:
//
//   • single-sig purposes '44' | '49' | '84' | '86'  (BIP-44/49/84/86)
//   • '48'  personal/self-made multisig               (BIP-48, script-aware path)
//   • '45'  collaborative/shared-vault cosigner key   (BIP-45, m/45')
//
// `purpose` is a closed enum (rejected otherwise), every stored row's path
// must actually start with its purpose segment, and every read requires the
// caller to name the specific purpose(s) it means — there is no "give me all
// keys for this fingerprint" that could accidentally hand a single-sig lookup
// a '45' row or vice versa.
//
// share_opt_in (cairn-fdlf.3, column only — enforcement is a future bead):
// sharing/export surfaces must default to exposing only multisig-purpose
// ('45'/'48') path data. On single-sig-purpose rows this flag records the
// user's explicit opt-in to sharing that key's path data; it defaults to off
// and only ever ratchets on.

import { db } from './db';
import { childLogger } from './logger';
import { normalizeFingerprint, normalizeOriginPath } from '$lib/hw/keyOrigin';
import { b58check, SCRIPT_TYPE_PURPOSE } from '$lib/hw/common';
import type { ScriptType } from '$lib/types';

const log = childLogger('deviceKeys');

// ------------------------------------------------------------------ purposes

/** Single-sig purposes — BIP-44/49/84/86 account keys. */
export const SINGLE_SIG_PURPOSES = ['44', '49', '84', '86'] as const;
export type SingleSigPurpose = (typeof SINGLE_SIG_PURPOSES)[number];

/** Multisig purposes — '48' (personal multisig), '45' (collaborative vault). */
export const MULTISIG_PURPOSES = ['48', '45'] as const;
export type MultisigPurpose = (typeof MULTISIG_PURPOSES)[number];

/** The closed purpose enum. Anything else is rejected, never stored. */
export type DeviceKeyPurpose = SingleSigPurpose | MultisigPurpose;
export const DEVICE_KEY_PURPOSES: readonly DeviceKeyPurpose[] = [
	...SINGLE_SIG_PURPOSES,
	...MULTISIG_PURPOSES
];

export function isDeviceKeyPurpose(v: unknown): v is DeviceKeyPurpose {
	return (DEVICE_KEY_PURPOSES as readonly unknown[]).includes(v);
}

/** The single-sig registry purpose for a script type (p2wpkh → '84', …). */
export function singleSigPurposeFor(scriptType: ScriptType): SingleSigPurpose {
	return String(SCRIPT_TYPE_PURPOSE[scriptType]) as SingleSigPurpose;
}

/**
 * Derive the purpose a canonical origin path belongs to, from its first
 * (hardened) segment: m/84'/0'/0' → '84', m/45' → '45'. Returns null when the
 * path is malformed, its first segment is not hardened, or the purpose is not
 * one of the closed set — callers must not guess.
 */
export function purposeFromPath(rawPath: unknown): DeviceKeyPurpose | null {
	const path = normalizeOriginPath(rawPath);
	if (!path) return null;
	const first = path.split('/')[1]; // ["m", "84'", …]
	if (!first?.endsWith("'")) return null; // purpose level is always hardened
	const purpose = first.slice(0, -1);
	return isDeviceKeyPurpose(purpose) ? purpose : null;
}

// -------------------------------------------------------------------- errors

/** Typed validation error — safe to show to the user verbatim. */
export class DeviceKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DeviceKeyError';
	}
}

// -------------------------------------------------------------------- shapes

export interface DeviceKeyRecord {
	id: number;
	userId: number;
	/** Master fingerprint, 8 lowercase hex — identifies the physical device/seed. */
	fingerprint: string;
	purpose: DeviceKeyPurpose;
	/** The account-level extended public key read at `path`. */
	xpub: string;
	/** Canonical origin path, e.g. "m/45'" or "m/84'/0'/0'". */
	path: string;
	/** Which device kind produced the read ('trezor', 'ledger', …); null = unknown. */
	deviceType: string | null;
	/** cairn-fdlf.3: single-sig path-data sharing opt-in. Meaningful on
	 *  single-sig-purpose rows; multisig-purpose paths are always shareable. */
	shareOptIn: boolean;
	createdAt: string;
	updatedAt: string;
}

interface DeviceKeyRow {
	id: number;
	user_id: number;
	fingerprint: string;
	purpose: string;
	xpub: string;
	path: string;
	device_type: string | null;
	share_opt_in: number;
	created_at: string;
	updated_at: string;
}

function toRecord(row: DeviceKeyRow): DeviceKeyRecord {
	return {
		id: row.id,
		userId: row.user_id,
		fingerprint: row.fingerprint,
		purpose: row.purpose as DeviceKeyPurpose,
		xpub: row.xpub,
		path: row.path,
		deviceType: row.device_type,
		shareOptIn: row.share_opt_in === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

// ---------------------------------------------------------------- validation

/** A 78-byte base58check extended key of any prefix family (xpub/ypub/zpub/
 *  Ypub/Zpub). Shape check only — the registry is a cache, not a wallet. */
function validateXpub(raw: unknown): string {
	const v = String(raw ?? '').trim();
	try {
		if (b58check.decode(v).length === 78) return v;
	} catch {
		// fall through to the shared error below
	}
	throw new DeviceKeyError("That doesn't look like an extended public key.");
}

interface ValidatedKey {
	fingerprint: string;
	purpose: DeviceKeyPurpose;
	xpub: string;
	path: string;
}

function validateKeyInput(input: {
	fingerprint?: unknown;
	purpose?: unknown;
	xpub?: unknown;
	path?: unknown;
}): ValidatedKey {
	const fingerprint = normalizeFingerprint(input.fingerprint);
	if (!fingerprint) {
		throw new DeviceKeyError(
			"That master fingerprint doesn't look right — it's exactly 8 characters of 0-9 and a-f."
		);
	}
	const purpose = input.purpose;
	if (!isDeviceKeyPurpose(purpose)) {
		throw new DeviceKeyError(`Unknown key purpose "${String(purpose)}".`);
	}
	const path = normalizeOriginPath(input.path);
	if (!path) {
		throw new DeviceKeyError("That derivation path doesn't look right — it looks like m/84'/0'/0'.");
	}
	// The never-conflate invariant, enforced at the write path: a row's path
	// must actually live under its declared purpose. Without this, a mislabeled
	// write could hand a future single-sig lookup a BIP-45 key or vice versa.
	if (purposeFromPath(path) !== purpose) {
		throw new DeviceKeyError(
			`That path (${path}) doesn't belong to purpose ${purpose}' — refusing to store a mislabeled key.`
		);
	}
	return { fingerprint, purpose, xpub: validateXpub(input.xpub), path };
}

// ------------------------------------------------------------------- writes

/**
 * Upsert one device key. The registry keeps ONE row per
 * (user, fingerprint, purpose) — a re-read of the same device at the same
 * purpose refreshes the row in place (newer account read wins), it never
 * duplicates. shareOptIn only ever ratchets on: a later write that omits it
 * (or passes false) does not silently revoke an earlier explicit opt-in.
 *
 * Throws DeviceKeyError on any invalid input — a cache full of garbage is
 * worse than no cache.
 */
export function rememberDeviceKey(
	userId: number,
	input: {
		fingerprint: unknown;
		purpose: unknown;
		xpub: unknown;
		path: unknown;
		deviceType?: unknown;
		shareOptIn?: boolean;
	}
): DeviceKeyRecord {
	const key = validateKeyInput(input);
	const deviceType = String(input.deviceType ?? '').trim().toLowerCase() || null;
	const optIn = input.shareOptIn === true ? 1 : 0;

	db.prepare(
		`INSERT INTO device_keys (user_id, fingerprint, purpose, xpub, path, device_type, share_opt_in)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (user_id, fingerprint, purpose) DO UPDATE SET
		   xpub         = excluded.xpub,
		   path         = excluded.path,
		   device_type  = COALESCE(excluded.device_type, device_keys.device_type),
		   share_opt_in = MAX(device_keys.share_opt_in, excluded.share_opt_in),
		   updated_at   = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
	).run(userId, key.fingerprint, key.purpose, key.xpub, key.path, deviceType, optIn);

	const rec = getDeviceKey(userId, key.fingerprint, key.purpose);
	if (!rec) throw new DeviceKeyError('Could not save the device key.');
	return rec;
}

/**
 * The single-sig-wizard write path (cairn-fdlf.1): persist the BIP-45 sharing
 * key that was just prefetched off a live device, plus (best-effort) the
 * primary single-sig key from the same read so the registry knows the device
 * under its everyday purpose too.
 *
 *   • `shared` MUST be a BIP-45 key (path m/45') — anything else throws;
 *     storing a mislabeled sharing key would poison the exact lookup
 *     cairn-fdlf.4 exists to make.
 *   • `primary` is optional and forgiving: it rides along only when its own
 *     origin is valid; an unusable primary is skipped (logged), never fatal —
 *     the sharing key is the thing the user spent a device touch on.
 *
 * Both rows record shareOptIn (the user explicitly checked "I plan to use
 * this key in a collaborative wallet"). This function never touches the
 * single-sig wallet being created — that proceeds independently via
 * createWallet.
 */
export function rememberPrefetchedSharedKey(
	userId: number,
	input: {
		shared: { fingerprint: unknown; xpub: unknown; path: unknown };
		primary?: { fingerprint: unknown; xpub: unknown; path: unknown } | null;
		deviceType?: unknown;
	}
): { shared: DeviceKeyRecord; primary: DeviceKeyRecord | null } {
	const sharedPurpose = purposeFromPath(input.shared.path);
	if (sharedPurpose !== '45') {
		throw new DeviceKeyError(
			`The sharing key must be read at m/45' — got "${String(input.shared.path ?? '')}".`
		);
	}
	const shared = rememberDeviceKey(userId, {
		...input.shared,
		purpose: '45',
		deviceType: input.deviceType,
		shareOptIn: true
	});

	let primary: DeviceKeyRecord | null = null;
	if (input.primary) {
		const primaryPurpose = purposeFromPath(input.primary.path);
		if (primaryPurpose && (SINGLE_SIG_PURPOSES as readonly string[]).includes(primaryPurpose)) {
			try {
				primary = rememberDeviceKey(userId, {
					...input.primary,
					purpose: primaryPurpose,
					deviceType: input.deviceType,
					shareOptIn: true
				});
			} catch (e) {
				log.warn({ err: e, userId }, 'primary device-key row skipped (invalid input)');
			}
		} else {
			log.warn(
				{ userId, path: String(input.primary.path ?? '') },
				'primary device-key row skipped (not a single-sig purpose path)'
			);
		}
	}
	return { shared, primary };
}

// -------------------------------------------------------------------- reads

/** One exact row, or null. Purpose is required — there is no cross-purpose read. */
export function getDeviceKey(
	userId: number,
	fingerprint: unknown,
	purpose: DeviceKeyPurpose
): DeviceKeyRecord | null {
	const fp = normalizeFingerprint(fingerprint);
	if (!fp || !isDeviceKeyPurpose(purpose)) return null;
	const row = db
		.prepare('SELECT * FROM device_keys WHERE user_id = ? AND fingerprint = ? AND purpose = ?')
		.get(userId, fp, purpose) as unknown as DeviceKeyRow | undefined;
	return row ? toRecord(row) : null;
}

/**
 * All of a user's rows for the EXPLICITLY named purposes. `purposes` must be
 * non-empty and every entry valid — a caller that can't say which purpose
 * family it wants must not read from this registry at all (that vagueness is
 * exactly how single-sig and multisig keys would get conflated).
 */
export function listDeviceKeys(
	userId: number,
	purposes: readonly DeviceKeyPurpose[]
): DeviceKeyRecord[] {
	if (!Array.isArray(purposes) || purposes.length === 0) {
		throw new DeviceKeyError('listDeviceKeys requires the specific purpose(s) to read.');
	}
	for (const p of purposes) {
		if (!isDeviceKeyPurpose(p)) throw new DeviceKeyError(`Unknown key purpose "${String(p)}".`);
	}
	const placeholders = purposes.map(() => '?').join(', ');
	const rows = db
		.prepare(
			`SELECT * FROM device_keys WHERE user_id = ? AND purpose IN (${placeholders})
			 ORDER BY fingerprint ASC, purpose ASC`
		)
		.all(userId, ...purposes) as unknown as DeviceKeyRow[];
	return rows.map(toRecord);
}

// ------------------------------------------------------------------- delete

/** Remove one (fingerprint, purpose) row. Returns whether a row existed. */
export function deleteDeviceKey(
	userId: number,
	fingerprint: unknown,
	purpose: DeviceKeyPurpose
): boolean {
	const fp = normalizeFingerprint(fingerprint);
	if (!fp || !isDeviceKeyPurpose(purpose)) return false;
	const res = db
		.prepare('DELETE FROM device_keys WHERE user_id = ? AND fingerprint = ? AND purpose = ?')
		.run(userId, fp, purpose);
	return res.changes > 0;
}
