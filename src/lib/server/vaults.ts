// Vault persistence + the bridge to the multisig descriptor library.
//
// A vault is local M-of-N multisig: one user, several keys, threshold
// signatures to spend. The rows here hold key metadata (category, device
// routing, origin info); everything cryptographic — addresses, descriptors,
// derivation material — comes from src/lib/server/bitcoin/multisig.ts via
// toVaultConfig, so there is exactly one code path that interprets a vault's
// keys. Quorum progress is never stored: it is derived from the PSBT itself,
// which cannot disagree with reality (a stored counter can).

import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import { db } from './db';
import {
	VaultError,
	vaultTestAddress,
	type VaultConfig,
	type VaultKeyDescriptor,
	MAX_VAULT_KEYS
} from './bitcoin/multisig';
import { parseXpub } from './bitcoin/xpub';

export type VaultScriptType = 'p2wsh' | 'p2sh-p2wsh' | 'p2sh';
export const VAULT_SCRIPT_TYPES: VaultScriptType[] = ['p2wsh', 'p2sh-p2wsh', 'p2sh'];

export type VaultKeyCategory = 'hardware' | 'mobile' | 'recovery';
export const VAULT_KEY_CATEGORIES: VaultKeyCategory[] = ['hardware', 'mobile', 'recovery'];

/** Device routing for the signing stepper; null = generic file signing. */
export type VaultDeviceType = 'trezor' | 'ledger' | 'coldcard' | 'qr' | 'file' | null;

export interface VaultKeyRow {
	id: number;
	vaultId: number;
	position: number;
	name: string;
	category: VaultKeyCategory;
	deviceType: VaultDeviceType;
	xpub: string;
	fingerprint: string;
	path: string;
	/**
	 * When this key last passed a health check (ISO 8601), null = never.
	 * Optional so existing literal constructions (tests, fixtures) stay valid;
	 * rows read from the database always carry it. See markKeyVerified.
	 */
	lastVerifiedAt?: string | null;
}

export interface VaultRow {
	id: number;
	userId: number;
	name: string;
	threshold: number;
	scriptType: VaultScriptType;
	receiveCursor: number;
	createdAt: string;
	keys: VaultKeyRow[];
}

export interface NewVaultKey {
	name: string;
	category: VaultKeyCategory;
	deviceType?: VaultDeviceType;
	xpub: string;
	fingerprint: string;
	path: string;
}

function mapKey(r: Record<string, unknown>): VaultKeyRow {
	return {
		id: r.id as number,
		vaultId: r.vault_id as number,
		position: r.position as number,
		name: r.name as string,
		category: r.category as VaultKeyCategory,
		deviceType: (r.device_type ?? null) as VaultDeviceType,
		xpub: r.xpub as string,
		fingerprint: r.fingerprint as string,
		path: r.path as string,
		lastVerifiedAt: (r.last_verified_at ?? null) as string | null
	};
}

function mapVault(r: Record<string, unknown>, keys: VaultKeyRow[]): VaultRow {
	return {
		id: r.id as number,
		userId: r.user_id as number,
		name: r.name as string,
		threshold: r.threshold as number,
		scriptType: r.script_type as VaultScriptType,
		receiveCursor: r.receive_cursor as number,
		createdAt: r.created_at as string,
		keys
	};
}

function keysFor(vaultId: number): VaultKeyRow[] {
	return (
		db
			.prepare('SELECT * FROM vault_keys WHERE vault_id = ? ORDER BY position')
			.all(vaultId) as Record<string, unknown>[]
	).map(mapKey);
}

export function getVault(userId: number, id: number): VaultRow | null {
	const row = db
		.prepare('SELECT * FROM vaults WHERE id = ? AND user_id = ?')
		.get(id, userId) as Record<string, unknown> | undefined;
	if (!row) return null;
	return mapVault(row, keysFor(row.id as number));
}

export function listVaults(userId: number): VaultRow[] {
	return (
		db
			.prepare('SELECT * FROM vaults WHERE user_id = ? ORDER BY created_at DESC')
			.all(userId) as Record<string, unknown>[]
	).map((r) => mapVault(r, keysFor(r.id as number)));
}

/**
 * The single translation from vault rows to the descriptor library's config.
 * Key order is the stored position order — BIP-67 sorting happens inside the
 * library at script-build time, so display order stays the user's order.
 */
export function toVaultConfig(vault: VaultRow): VaultConfig & { scriptType: VaultScriptType } {
	const keys: VaultKeyDescriptor[] = vault.keys.map((k) => ({
		xpub: k.xpub,
		fingerprint: k.fingerprint,
		path: k.path,
		name: k.name
	}));
	return { threshold: vault.threshold, keys, scriptType: vault.scriptType };
}

/**
 * Create a vault after validating the full config cryptographically (every
 * xpub parses, threshold is sane, an address actually derives). Throws
 * VaultError for config problems — surface `.message` verbatim.
 */
export function createVault(
	userId: number,
	params: {
		name: string;
		threshold: number;
		scriptType?: VaultScriptType;
		keys: NewVaultKey[];
	}
): VaultRow {
	const name = params.name.trim();
	if (name.length === 0 || name.length > 60) {
		throw new VaultError('Vault name must be 1-60 characters.', 'invalid_config');
	}
	const scriptType = params.scriptType ?? 'p2wsh';
	if (!VAULT_SCRIPT_TYPES.includes(scriptType)) {
		throw new VaultError('Unknown vault script type.', 'invalid_config');
	}
	if (params.keys.length > MAX_VAULT_KEYS) {
		throw new VaultError(`A vault can hold at most ${MAX_VAULT_KEYS} keys.`, 'invalid_config');
	}
	for (const k of params.keys) {
		if (!VAULT_KEY_CATEGORIES.includes(k.category)) {
			throw new VaultError('Unknown key category.', 'invalid_key');
		}
		if (k.name.trim().length === 0 || k.name.trim().length > 60) {
			throw new VaultError('Each key needs a name (1-60 characters).', 'invalid_key');
		}
	}

	// Cryptographic validation: deriving the first address exercises threshold
	// bounds, xpub parsing, and duplicate detection inside the library.
	vaultTestAddress({
		threshold: params.threshold,
		keys: params.keys.map((k) => ({ xpub: k.xpub, fingerprint: k.fingerprint, path: k.path }))
	});

	const info = db
		.prepare('INSERT INTO vaults (user_id, name, threshold, script_type) VALUES (?, ?, ?, ?)')
		.run(userId, name, params.threshold, scriptType);
	const vaultId = Number(info.lastInsertRowid);

	const insertKey = db.prepare(
		`INSERT INTO vault_keys (vault_id, position, name, category, device_type, xpub, fingerprint, path)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);
	params.keys.forEach((k, i) => {
		insertKey.run(
			vaultId,
			i,
			k.name.trim(),
			k.category,
			k.deviceType ?? null,
			k.xpub.trim(),
			k.fingerprint.toLowerCase(),
			k.path.trim()
		);
	});

	return getVault(userId, vaultId)!;
}

export function deleteVault(userId: number, id: number): boolean {
	const info = db.prepare('DELETE FROM vaults WHERE id = ? AND user_id = ?').run(id, userId);
	return info.changes > 0;
}

/** Advance the receive cursor past a freshly handed-out address index. */
export function bumpReceiveCursor(userId: number, id: number, toIndex: number): void {
	db.prepare(
		'UPDATE vaults SET receive_cursor = MAX(receive_cursor, ?) WHERE id = ? AND user_id = ?'
	).run(toIndex + 1, id, userId);
}

// ------------------------------------------------------------- key health checks
//
// Casa-style periodic verification: each key carries a last_verified_at
// timestamp, refreshed whenever the user proves the key still exists — either
// a live device re-read (fingerprint + xpub compared against the stored row)
// or a guided manual check. The UI nudges when any key goes unchecked for
// ~6 months, because a key you can't access is a key you don't have.

/**
 * Record a successful key health check: stamp last_verified_at = now.
 * Ownership-checked end to end (key ∈ vault ∈ user); returns the refreshed
 * key row, or null when the key/vault isn't the user's.
 */
export function markKeyVerified(userId: number, vaultId: number, keyId: number): VaultKeyRow | null {
	const info = db
		.prepare(
			`UPDATE vault_keys
			 SET last_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			 WHERE id = ? AND vault_id = ?
			   AND EXISTS (SELECT 1 FROM vaults WHERE id = ? AND user_id = ?)`
		)
		.run(keyId, vaultId, vaultId, userId);
	if (info.changes === 0) return null;
	const row = db.prepare('SELECT * FROM vault_keys WHERE id = ?').get(keyId) as
		| Record<string, unknown>
		| undefined;
	return row ? mapKey(row) : null;
}

// SLIP-132 multisig public prefixes (Ypub / Zpub) rewritten to standard xpub
// bytes before comparison — same normalization multisig.ts applies internally
// (its toStandardXpub is private; the rewrite is 4 version bytes, duplicated
// here rather than widening that module's API). Device readers always return
// standard xpubs, but a STORED key may have been pasted in SLIP-132 form.
const SLIP132_MULTISIG_VERSIONS = new Set([
	0x0295b43f, // Ypub (p2sh-p2wsh multisig)
	0x02aa7ed3 // Zpub (p2wsh multisig)
]);
const XPUB_VERSION = 0x0488b21e;
const b58check = createBase58check(sha256);

/** Canonical xpub string for equality comparison, or null when unparseable. */
function canonicalXpub(input: string): string | null {
	let s = input.trim();
	try {
		const raw = b58check.decode(s);
		if (raw.length === 78) {
			const version = ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0;
			if (SLIP132_MULTISIG_VERSIONS.has(version)) {
				const out = new Uint8Array(raw);
				out[0] = (XPUB_VERSION >>> 24) & 0xff;
				out[1] = (XPUB_VERSION >>> 16) & 0xff;
				out[2] = (XPUB_VERSION >>> 8) & 0xff;
				out[3] = XPUB_VERSION & 0xff;
				s = b58check.encode(out);
			}
		}
	} catch {
		// Not base58 at all — let parseXpub fail below.
	}
	try {
		return parseXpub(s).hdkey.publicExtendedKey;
	} catch {
		return null;
	}
}

export interface VaultKeyComparison {
	/** Master fingerprints agree (case-insensitive). */
	fingerprintMatch: boolean;
	/** Extended keys agree after canonicalization (SLIP-132 aliases equal). */
	xpubMatch: boolean;
}

/**
 * Compare a live device reading against a stored vault key. Both checks are
 * reported separately: fingerprint-mismatch means a different seed entirely
 * ("this device holds a different key"), while fingerprint-match with
 * xpub-mismatch usually means the right device read at a different account
 * path than the key was created with.
 */
export function compareVaultKey(
	stored: Pick<VaultKeyRow, 'xpub' | 'fingerprint'>,
	reading: { xpub: string; fingerprint: string }
): VaultKeyComparison {
	const canonStored = canonicalXpub(stored.xpub);
	const canonReading = canonicalXpub(reading.xpub);
	return {
		fingerprintMatch: stored.fingerprint.toLowerCase() === reading.fingerprint.trim().toLowerCase(),
		xpubMatch: canonStored !== null && canonStored === canonReading
	};
}
