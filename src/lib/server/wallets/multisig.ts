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
import { recordActivity } from '../activity';
import { childLogger } from '../logger';
import {
	MultisigError,
	multisigTestAddress,
	validateMultisigKeyPaths,
	cosignerPathPurpose,
	type MultisigConfig,
	type MultisigKeyDescriptor,
	MAX_MULTISIG_KEYS
} from '../bitcoin/multisig';
import { detectXpubReuse } from '../cosignerDetection';
import { parseXpub } from '../bitcoin/xpub';
// Cyclic with ../multisigScan (it imports several things from this module),
// but safe: both sides only reach into the other from inside function bodies,
// never at module top level, so ESM's live bindings resolve fine either way.
import { invalidateMultisigCache } from '../multisigScan';
// Also cyclic with ../addressWatcher (it imports toMultisigConfig/MultisigRow
// from this module) — same safety argument: unwatchMultisig is only reached
// from inside deleteMultisig's function body, never at module top level.
import { unwatchMultisig } from '../addressWatcher';

// Wave 2 / log-ops.md: this module had ZERO log lines of any kind (not even a
// failure log) — an even bigger blind spot than wallets.ts's single-sig
// equivalent. create/deleteMultisig below now log success at info.
const log = childLogger('multisig');

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
	/**
	 * The vault mode declared at creation (cairn-1kc3.6): true = collaborative
	 * (cosigner keys shared with other people — fresh on-platform creations must
	 * use BIP-45 m/45' paths, enforced in createMultisig), false = personal (all
	 * the user's own keys — BIP-48 paths), null = never declared (every
	 * pre-existing row, and creations from flows that don't ask yet — no mode
	 * enforcement, only the universal path checks). Set once at creation; never
	 * edited after (flipping it wouldn't re-derive already-recorded paths).
	 */
	collaborative?: boolean | null;
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
		collaborative: r.collaborative == null ? null : Boolean(r.collaborative),
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
		/** Declared vault mode (cairn-1kc3.6): true = collaborative (BIP-45 m/45'
		 *  required on every key for fresh creations), false = personal (BIP-48;
		 *  m/45' rejected), omitted/null = undeclared (no mode enforcement).
		 *  Imports (source 'imported') persist the flag but are exempt from the
		 *  enforcement — an imported wallet already exists on-chain with whatever
		 *  paths it was built with. */
		collaborative?: boolean | null;
	}
): MultisigRow {
	const name = params.name.trim();
	if (name.length === 0 || name.length > 60) {
		throw new MultisigError('Multisig name must be 1-60 characters.', 'invalid_config');
	}
	// Double-submit guard (cairn-50ng): two concurrent identical creates both
	// reached the INSERT below because nothing existed to stop them. This
	// check and the INSERT further down are separated by zero `await`s —
	// createMultisig runs start-to-finish synchronously — so on Node's
	// single-threaded event loop no second request's JS can interleave
	// between this SELECT and that INSERT; whichever request's synchronous
	// run reaches here first "wins" and the other sees the row it just made.
	const existing = db
		.prepare('SELECT id FROM multisigs WHERE user_id = ? AND name = ?')
		.get(userId, name) as { id: number } | undefined;
	if (existing) {
		throw new MultisigError(`You already have a multisig named “${name}”.`, 'duplicate_name');
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

	const source: MultisigSource = params.source === 'imported' ? 'imported' : 'created';
	const collaborative = typeof params.collaborative === 'boolean' ? params.collaborative : null;

	// ONE config object feeds both validation gates below, so the sanity
	// derivation exercises the wallet's REAL script type (cairn-1kc3.2) instead
	// of silently defaulting to p2wsh.
	const config: MultisigConfig = {
		threshold: params.threshold,
		scriptType,
		keys: params.keys.map((k) => ({
			xpub: k.xpub,
			fingerprint: k.fingerprint,
			path: k.path,
			name: k.name
		}))
	};

	// Path hygiene (cairn-1kc3.1/.3/.5): every declared cosigner path must carry
	// a multisig purpose (45' or 48'), and 48' paths must match this wallet's
	// script type and the mainnet coin type. Applies to creation AND import —
	// imports are exempt from the BIP-45 product rule below, never from
	// carrying single-sig or self-contradictory paths. 'import' mode (cairn-acft)
	// additionally tolerates the historical legacy-P2SH 1'-suffix label instead
	// of hard-rejecting it — an imported wallet already exists on-chain with
	// whatever path label it was built with.
	validateMultisigKeyPaths(config, { mode: source === 'imported' ? 'import' : 'create' });

	// Declared-mode enforcement (cairn-1kc3.6): the server-side backstop for the
	// collaborative-custody rule, independent of any wizard. Skipped entirely
	// for imports ("all imported wallets can be used for collaborative
	// regardless of path") and when no mode was declared.
	if (source !== 'imported' && collaborative !== null) {
		params.keys.forEach((k, i) => {
			const label = k.name.trim() || `key ${i + 1}`;
			const purpose = cosignerPathPurpose(k.path);
			if (collaborative && purpose !== 45) {
				throw new MultisigError(
					`${label}: a collaborative vault needs every key on the shared multisig path m/45' — this key's path is "${k.path.trim() || 'm'}". Re-export the key at m/45'.`,
					'invalid_key'
				);
			}
			if (!collaborative && purpose === 45) {
				throw new MultisigError(
					`${label}: m/45' marks a key as shared for collaborative custody — a personal vault's keys use a BIP-48 path (like m/48'/0'/0'/2') instead.`,
					'invalid_key'
				);
			}
		});
	}

	// Cryptographic validation: deriving the first address exercises threshold
	// bounds, xpub parsing, duplicate detection, and the actual script-building
	// code path this wallet will use.
	multisigTestAddress(config);

	// Cross-wallet xpub reuse (cairn-1kc3.4): computed BEFORE the insert so the
	// new multisig's own rows can't match themselves. Non-blocking — reuse can
	// be deliberate — but surfaced in the activity feed below, never silent.
	const reusedKeys = detectXpubReuse(
		userId,
		params.keys.map((k) => k.xpub)
	);

	const info = db
		.prepare(
			'INSERT INTO multisigs (user_id, name, threshold, script_type, source, collaborative) VALUES (?, ?, ?, ?, ?, ?)'
		)
		.run(
			userId,
			name,
			params.threshold,
			scriptType,
			source,
			collaborative === null ? null : collaborative ? 1 : 0
		);
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

	// Creating/importing a multisig is a significant account action: surface it
	// in the user's activity feed and the admin log (cairn-cvcu). recordActivity
	// is best-effort and never throws. No xpubs in the detail — identity only.
	recordActivity({
		type: 'wallet_created',
		level: 'success',
		userId,
		message: `Multisig wallet “${name}” ${source === 'imported' ? 'imported' : 'created'} (${params.threshold}-of-${params.keys.length})`,
		detail: {
			walletKind: 'multisig',
			walletId: multisigId,
			threshold: params.threshold,
			totalKeys: params.keys.length,
			source
		}
	});
	// Wave 2 / log-ops.md: this module previously logged nothing at all — no
	// success, no failure. No xpubs here either, same rationale as above.
	log.info(
		{
			userId,
			walletId: multisigId,
			threshold: params.threshold,
			totalKeys: params.keys.length,
			source
		},
		'multisig wallet created'
	);

	// Reused-key warning (cairn-1kc3.4): tell the user where the key already
	// lives. Best-effort, never blocking; no xpubs in the detail — identity only.
	if (reusedKeys.length > 0) {
		const places = [
			...new Set(
				reusedKeys.map(
					(r) => `${r.kind === 'wallet' ? 'wallet' : 'multisig'} “${r.walletName}”`
				)
			)
		];
		const keyCount = new Set(reusedKeys.map((r) => r.xpub)).size;
		recordActivity({
			type: 'key_reuse',
			level: 'warn',
			userId,
			message: `${keyCount === 1 ? 'A key' : `${keyCount} keys`} in “${name}” ${keyCount === 1 ? 'is' : 'are'} already used by your ${places.join(', ')} — sharing one key across wallets weakens the protection a multisig is meant to add.`,
			detail: {
				walletKind: 'multisig',
				walletId: multisigId,
				reuse: reusedKeys.map((r) => ({
					kind: r.kind,
					walletId: r.walletId,
					walletName: r.walletName
				}))
			}
		});
	}

	return getMultisig(userId, multisigId)!;
}

export function deleteMultisig(userId: number, id: number): boolean {
	// Fetch the full row (keys included) before it's gone — invalidateMultisigCache
	// needs the key set/threshold/script type to compute the scan-cache key.
	const row = getMultisig(userId, id);
	if (!row) return false;
	// The polymorphic (wallet_kind, wallet_id) child tables — notified_txids,
	// address_labels, wallet_backups, backup_missing_notified, balance_snapshots —
	// have no real FK to multisigs, but db.ts's trg_multisigs_delete_children
	// trigger sweeps all of them on this DELETE (cairn-97ui).
	const info = db.prepare('DELETE FROM multisigs WHERE id = ? AND user_id = ?').run(id, userId);
	if (info.changes > 0) {
		// Drop the in-memory scan cache AND its persisted row (cairn-ez9y) —
		// mirrors deleteWallet's invalidateWalletCache. Without this the
		// persisted wallet_scan_cache row survives and seedScanCachesFromDb
		// resurrects the deleted multisig's stale scan into RAM on every restart.
		invalidateMultisigCache(row);
		// cairn-uzgu / cairn-gakd Phase 1: drop this multisig's scripthashes from
		// the address watcher's local state so it stops manufacturing orphaned
		// notified_txids rows and firing notifications that deep-link to a 404
		// multisig page. Electrum-side unsubscribe is Phase 2 (cairn-gakd).
		unwatchMultisig(id);
		// Wave 2 / log-ops.md: no log line existed for this destructive action
		// either. No xpubs — identity only.
		log.info({ userId, walletId: id }, 'multisig wallet deleted');
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
	/**
	 * True when the STORED key never had a real fingerprint on record (the
	 * '00000000' placeholder — a bare-xpub add with no [fingerprint/path]
	 * origin) and the xpub still matched. Callers should treat this as a pass
	 * (there was nothing real for the supplied fingerprint to disagree with),
	 * distinct from a genuine fingerprintMatch.
	 */
	matchedWithoutFingerprint: boolean;
}

/**
 * Compare a live device reading against a stored multisig key. Both checks are
 * reported separately: fingerprint-mismatch means a different seed entirely
 * ("this device holds a different key"), while fingerprint-match with
 * xpub-mismatch usually means the right device read at a different account
 * path than the key was created with.
 *
 * A stored fingerprint still sitting at the '00000000' placeholder (never
 * captured because the key was added as a bare xpub) never disagreed with
 * anything real, so a differing supplied fingerprint doesn't fail the check
 * on its own — see `matchedWithoutFingerprint`.
 */
export function compareMultisigKey(
	stored: Pick<MultisigKeyRow, 'xpub' | 'fingerprint'>,
	reading: { xpub: string; fingerprint: string }
): MultisigKeyComparison {
	const canonStored = canonicalXpub(stored.xpub);
	const canonReading = canonicalXpub(reading.xpub);
	const fingerprintMatch =
		stored.fingerprint.toLowerCase() === reading.fingerprint.trim().toLowerCase();
	const xpubMatch = canonStored !== null && canonStored === canonReading;
	const noStoredFingerprint = stored.fingerprint.toLowerCase() === '00000000';
	return {
		fingerprintMatch,
		xpubMatch,
		matchedWithoutFingerprint: noStoredFingerprint && xpubMatch && !fingerprintMatch
	};
}
