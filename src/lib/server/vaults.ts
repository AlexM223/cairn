// Vault persistence + the bridge to the multisig descriptor library.
//
// A vault is local M-of-N multisig: one user, several keys, threshold
// signatures to spend. The rows here hold key metadata (category, device
// routing, origin info); everything cryptographic — addresses, descriptors,
// derivation material — comes from src/lib/server/bitcoin/multisig.ts via
// toVaultConfig, so there is exactly one code path that interprets a vault's
// keys. Quorum progress is never stored: it is derived from the PSBT itself,
// which cannot disagree with reality (a stored counter can).

import { db } from './db';
import {
	VaultError,
	vaultTestAddress,
	type VaultConfig,
	type VaultKeyDescriptor,
	MAX_VAULT_KEYS
} from './bitcoin/multisig';

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
		path: r.path as string
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
