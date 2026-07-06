// Multisig persistence + the bridge to the multisig descriptor library.
//
// A multisig is local M-of-N multisig: one user, several keys, threshold
// signatures to spend. The rows here hold key metadata (category, device
// routing, origin info); everything cryptographic — addresses, descriptors,
// derivation material — comes from src/lib/server/bitcoin/multisig.ts via
// toMultisigConfig, so there is exactly one code path that interprets a multisig's
// keys. Quorum progress is never stored: it is derived from the PSBT itself,
// which cannot disagree with reality (a stored counter can).

import { sha256 } from '@noble/hashes/sha2.js';
import { createBase58check } from '@scure/base';
import { db } from '../db';
import {
	MultisigError,
	multisigTestAddress,
	type MultisigConfig,
	type MultisigKeyDescriptor,
	MAX_MULTISIG_KEYS
} from '../bitcoin/multisig';
import { parseXpub } from '../bitcoin/xpub';

export type MultisigScriptType = 'p2wsh' | 'p2sh-p2wsh' | 'p2sh';
export const MULTISIG_SCRIPT_TYPES: MultisigScriptType[] = ['p2wsh', 'p2sh-p2wsh', 'p2sh'];

export type MultisigKeyCategory = 'hardware' | 'mobile' | 'recovery';
export const MULTISIG_KEY_CATEGORIES: MultisigKeyCategory[] = ['hardware', 'mobile', 'recovery'];

/** Device routing for the signing stepper; null = generic file signing. */
export type MultisigDeviceType =
	| 'trezor'
	| 'ledger'
	| 'coldcard'
	| 'bitbox02'
	| 'jade'
	| 'qr'
	| 'file'
	| null;

export interface MultisigKeyRow {
	id: number;
	multisigId: number;
	position: number;
	name: string;
	category: MultisigKeyCategory;
	deviceType: MultisigDeviceType;
	xpub: string;
	fingerprint: string;
	path: string;
	/**
	 * When this key last passed a health check (ISO 8601), null = never.
	 * Optional so existing literal constructions (tests, fixtures) stay valid;
	 * rows read from the database always carry it. See markKeyVerified.
	 */
	lastVerifiedAt?: string | null;
	/**
	 * The collaborator this key is assigned to (collaborative custody), or null
	 * when unassigned — which is every key of a solo multisig, the common case.
	 * See docs/COLLABORATIVE-CUSTODY-PLAN.md and multisigShares.ts.
	 */
	assignedUserId?: number | null;
}

/** How a multisig came to exist. Backup safeguards apply only to 'created'
 *  (built key-by-key; config exists nowhere else); 'imported' wallets came from
 *  a config file the user already has. See db.ts (multisigs.source). */
export type MultisigSource = 'created' | 'imported';

export interface MultisigRow {
	id: number;
	userId: number;
	name: string;
	threshold: number;
	scriptType: MultisigScriptType;
	receiveCursor: number;
	createdAt: string;
	/**
	 * How the multisig came to exist. Optional so existing literal constructions
	 * (tests, fixtures) stay valid; rows read from the database always carry it
	 * (mapMultisig defaults it to 'created'). Backup safeguards key off this.
	 */
	source?: MultisigSource;
	keys: MultisigKeyRow[];
}

export interface NewMultisigKey {
	name: string;
	category: MultisigKeyCategory;
	deviceType?: MultisigDeviceType;
	xpub: string;
	fingerprint: string;
	path: string;
}

function mapKey(r: Record<string, unknown>): MultisigKeyRow {
	return {
		id: r.id as number,
		multisigId: r.multisig_id as number,
		position: r.position as number,
		name: r.name as string,
		category: r.category as MultisigKeyCategory,
		deviceType: (r.device_type ?? null) as MultisigDeviceType,
		xpub: r.xpub as string,
		fingerprint: r.fingerprint as string,
		path: r.path as string,
		lastVerifiedAt: (r.last_verified_at ?? null) as string | null,
		assignedUserId: (r.assigned_user_id ?? null) as number | null
	};
}

function mapMultisig(r: Record<string, unknown>, keys: MultisigKeyRow[]): MultisigRow {
	return {
		id: r.id as number,
		userId: r.user_id as number,
		name: r.name as string,
		threshold: r.threshold as number,
		scriptType: r.script_type as MultisigScriptType,
		receiveCursor: r.receive_cursor as number,
		createdAt: r.created_at as string,
		source: ((r.source as string) ?? 'created') as MultisigSource,
		keys
	};
}

function keysFor(multisigId: number): MultisigKeyRow[] {
	return (
		db
			.prepare('SELECT * FROM multisig_keys WHERE multisig_id = ? ORDER BY position')
			.all(multisigId) as Record<string, unknown>[]
	).map(mapKey);
}

export function getMultisig(userId: number, id: number): MultisigRow | null {
	const row = db
		.prepare('SELECT * FROM multisigs WHERE id = ? AND user_id = ?')
		.get(id, userId) as Record<string, unknown> | undefined;
	if (!row) return null;
	return mapMultisig(row, keysFor(row.id as number));
}

/**
 * Owner OR any accepted share (viewer or cosigner) — the read-only surface
 * (balance, addresses, history, labels). Returns null for a non-participant
 * exactly like a non-existent id, so callers throw a uniform 404 and never leak
 * a wallet's existence with a 403. See docs/COLLABORATIVE-CUSTODY-PLAN.md §3.
 */
export function getViewableMultisig(userId: number, id: number): MultisigRow | null {
	const row = db
		.prepare(
			`SELECT m.* FROM multisigs m
			 WHERE m.id = ?
			   AND (m.user_id = ?
			        OR EXISTS (SELECT 1 FROM multisig_shares s
			                   WHERE s.multisig_id = m.id AND s.shared_with_id = ?))`
		)
		.get(id, userId, userId) as Record<string, unknown> | undefined;
	if (!row) return null;
	return mapMultisig(row, keysFor(row.id as number));
}

/**
 * Owner OR a share with role='cosigner' — the signing surface. Being a
 * wallet-level cosigner is necessary but not alone sufficient to sign a given
 * transaction: the per-transaction roster (multisig_transaction_signers) is the
 * actual per-transaction gate. Null for everyone else (uniform 404).
 */
export function getSignableMultisig(userId: number, id: number): MultisigRow | null {
	const row = db
		.prepare(
			`SELECT m.* FROM multisigs m
			 WHERE m.id = ?
			   AND (m.user_id = ?
			        OR EXISTS (SELECT 1 FROM multisig_shares s
			                   WHERE s.multisig_id = m.id AND s.shared_with_id = ?
			                     AND s.role = 'cosigner'))`
		)
		.get(id, userId, userId) as Record<string, unknown> | undefined;
	if (!row) return null;
	return mapMultisig(row, keysFor(row.id as number));
}

export function listMultisigs(userId: number): MultisigRow[] {
	return (
		db
			.prepare('SELECT * FROM multisigs WHERE user_id = ? ORDER BY created_at DESC')
			.all(userId) as Record<string, unknown>[]
	).map((r) => mapMultisig(r, keysFor(r.id as number)));
}

/**
 * The single translation from multisig rows to the descriptor library's config.
 * Key order is the stored position order — BIP-67 sorting happens inside the
 * library at script-build time, so display order stays the user's order.
 */
export function toMultisigConfig(multisig: MultisigRow): MultisigConfig & { scriptType: MultisigScriptType } {
	const keys: MultisigKeyDescriptor[] = multisig.keys.map((k) => ({
		xpub: k.xpub,
		fingerprint: k.fingerprint,
		path: k.path,
		name: k.name
	}));
	return { threshold: multisig.threshold, keys, scriptType: multisig.scriptType };
}

/**
 * Create a multisig after validating the full config cryptographically (every
 * xpub parses, threshold is sane, an address actually derives). Throws
 * MultisigError for config problems — surface `.message` verbatim.
 */
export function createMultisig(
	userId: number,
	params: {
		name: string;
		threshold: number;
		scriptType?: MultisigScriptType;
		keys: NewMultisigKey[];
		/** 'created' (built key-by-key — the default, backup-critical) or
		 *  'imported' (from a config the user already holds — no backup prompts). */
		source?: MultisigSource;
		/** Receive cursor to seed (from an imported config's startingAddressIndex),
		 *  so a restored wallet resumes handing out fresh addresses (cairn-u161). */
		receiveCursor?: number;
	}
): MultisigRow {
	const name = params.name.trim();
	if (name.length === 0 || name.length > 60) {
		throw new MultisigError('Multisig name must be 1-60 characters.', 'invalid_config');
	}
	const scriptType = params.scriptType ?? 'p2wsh';
	if (!MULTISIG_SCRIPT_TYPES.includes(scriptType)) {
		throw new MultisigError('Unknown multisig script type.', 'invalid_config');
	}
	if (params.keys.length > MAX_MULTISIG_KEYS) {
		throw new MultisigError(`A multisig can hold at most ${MAX_MULTISIG_KEYS} keys.`, 'invalid_config');
	}
	for (const k of params.keys) {
		if (!MULTISIG_KEY_CATEGORIES.includes(k.category)) {
			throw new MultisigError('Unknown key category.', 'invalid_key');
		}
		if (k.name.trim().length === 0 || k.name.trim().length > 60) {
			throw new MultisigError('Each key needs a name (1-60 characters).', 'invalid_key');
		}
	}

	// Cryptographic validation: deriving the first address exercises threshold
	// bounds, xpub parsing, and duplicate detection inside the library.
	multisigTestAddress({
		threshold: params.threshold,
		keys: params.keys.map((k) => ({ xpub: k.xpub, fingerprint: k.fingerprint, path: k.path }))
	});

	const source: MultisigSource = params.source === 'imported' ? 'imported' : 'created';
	const info = db
		.prepare(
			'INSERT INTO multisigs (user_id, name, threshold, script_type, source) VALUES (?, ?, ?, ?, ?)'
		)
		.run(userId, name, params.threshold, scriptType, source);
	const multisigId = Number(info.lastInsertRowid);

	// Seed the receive cursor from an imported config so a backup→restore doesn't
	// reissue already-used addresses (cairn-u161). Default stays 0 for new wallets.
	if (params.receiveCursor && Number.isInteger(params.receiveCursor) && params.receiveCursor > 0) {
		db.prepare('UPDATE multisigs SET receive_cursor = ? WHERE id = ?').run(
			params.receiveCursor,
			multisigId
		);
	}

	const insertKey = db.prepare(
		`INSERT INTO multisig_keys (multisig_id, position, name, category, device_type, xpub, fingerprint, path)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);
	params.keys.forEach((k, i) => {
		insertKey.run(
			multisigId,
			i,
			k.name.trim(),
			k.category,
			k.deviceType ?? null,
			k.xpub.trim(),
			k.fingerprint.toLowerCase(),
			k.path.trim()
		);
	});

	return getMultisig(userId, multisigId)!;
}

export function deleteMultisig(userId: number, id: number): boolean {
	const info = db.prepare('DELETE FROM multisigs WHERE id = ? AND user_id = ?').run(id, userId);
	if (info.changes > 0) {
		// notified_txids has no FK to multisigs (cairn-zari) and won't cascade —
		// clear this multisig's dedup rows explicitly to avoid orphans.
		db.prepare("DELETE FROM notified_txids WHERE wallet_kind = 'multisig' AND wallet_id = ?").run(id);
	}
	return info.changes > 0;
}

/** Advance the receive cursor past a freshly handed-out address index. */
export function bumpReceiveCursor(userId: number, id: number, toIndex: number): void {
	db.prepare(
		'UPDATE multisigs SET receive_cursor = MAX(receive_cursor, ?) WHERE id = ? AND user_id = ?'
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
 * Ownership-checked end to end (key ∈ multisig ∈ user); returns the refreshed
 * key row, or null when the key/multisig isn't the user's.
 */
export function markKeyVerified(userId: number, multisigId: number, keyId: number): MultisigKeyRow | null {
	const info = db
		.prepare(
			`UPDATE multisig_keys
			 SET last_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			 WHERE id = ? AND multisig_id = ?
			   AND EXISTS (SELECT 1 FROM multisigs WHERE id = ? AND user_id = ?)`
		)
		.run(keyId, multisigId, multisigId, userId);
	if (info.changes === 0) return null;
	const row = db.prepare('SELECT * FROM multisig_keys WHERE id = ?').get(keyId) as
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

export interface MultisigKeyComparison {
	/** Master fingerprints agree (case-insensitive). */
	fingerprintMatch: boolean;
	/** Extended keys agree after canonicalization (SLIP-132 aliases equal). */
	xpubMatch: boolean;
}

/**
 * Compare a live device reading against a stored multisig key. Both checks are
 * reported separately: fingerprint-mismatch means a different seed entirely
 * ("this device holds a different key"), while fingerprint-match with
 * xpub-mismatch usually means the right device read at a different account
 * path than the key was created with.
 */
export function compareMultisigKey(
	stored: Pick<MultisigKeyRow, 'xpub' | 'fingerprint'>,
	reading: { xpub: string; fingerprint: string }
): MultisigKeyComparison {
	const canonStored = canonicalXpub(stored.xpub);
	const canonReading = canonicalXpub(reading.xpub);
	return {
		fingerprintMatch: stored.fingerprint.toLowerCase() === reading.fingerprint.trim().toLowerCase(),
		xpubMatch: canonStored !== null && canonStored === canonReading
	};
}
