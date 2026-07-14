// Single-sig wallet service layer. A wallet is one xpub: Cairn holds only the
// public key (it can never spend on its own), but the wallet is a full wallet —
// the user signs on their own device. Every function is scoped by userId —
// callers pass locals.user.id and never see another user's rows.

import { db } from './db';
import { parseXpub, deriveAddress } from './bitcoin/xpub';
import { containsNulByte, TextInputError } from './textGuard';
import {
	scanWallet,
	invalidateWalletCache,
	findNextUnusedIndex,
	type WalletScanResult
} from './bitcoin/walletScan';
import { unwatchWallet } from './addressWatcher';
import { withLock } from './keyedLock';
import { childLogger } from './logger';
import { recordActivity } from './activity';
import {
	parseKeyOriginInput,
	normalizeFingerprint,
	normalizeOriginPath
} from '$lib/hw/keyOrigin';
import type { ScriptType, WalletDeviceType, WalletSummary } from '$lib/types';

const GAP_LIMIT = 20;

const log = childLogger('wallets');

/** Device types a wallet's key can be routed to when signing. Must stay in sync
 *  with WalletDeviceType and the DevicePicker tiles — an omitted type silently
 *  normalizes to null (file fallback), so a wallet can never remember it. */
const WALLET_DEVICE_TYPES: readonly WalletDeviceType[] = [
	'trezor',
	'ledger',
	'coldcard',
	'bitbox02',
	'jade',
	'jade-qr',
	'qr',
	'file'
];

/** Coerce arbitrary input to a known device type, or null when unrecognized. */
export function normalizeDeviceType(input: unknown): WalletDeviceType | null {
	const v = String(input ?? '').trim().toLowerCase();
	return (WALLET_DEVICE_TYPES as readonly string[]).includes(v)
		? (v as WalletDeviceType)
		: null;
}

export interface WalletRow {
	id: number;
	user_id: number;
	name: string;
	type: 'xpub';
	xpub: string;
	script_type: ScriptType;
	device_type: WalletDeviceType | null;
	/** Key origin, embedded in PSBTs and the config backup; null until known. */
	master_fingerprint: string | null;
	derivation_path: string | null;
	receive_cursor: number;
	created_at: string;
}

// ---------------------------------------------------------------- helpers

/** Map raw parseXpub errors to something a person can act on. */
export function friendlyXpubError(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	if (/private extended key/i.test(msg)) return msg; // already explains itself
	if (/testnet/i.test(msg)) return msg;
	if (/empty/i.test(msg)) return 'Paste an extended public key (xpub, ypub or zpub).';
	if (/checksum/i.test(msg))
		return 'That key has a bad checksum — double-check you copied the whole string.';
	if (/base58|length|prefix|no public key/i.test(msg))
		return "That doesn't look like an extended public key. Paste the full xpub, ypub or zpub string.";
	return `Could not read that key: ${msg}`;
}

/** Latest activity from a scan: newest confirmed tx time, or "now" if anything is pending. */
function lastActivityOf(scan: WalletScanResult): number | null {
	let latest: number | null = null;
	let pending = false;
	for (const tx of scan.txs) {
		if (tx.height <= 0) pending = true;
		else if (tx.time != null) latest = Math.max(latest ?? 0, tx.time);
	}
	if (pending) return Math.floor(Date.now() / 1000);
	return latest;
}

export function toWalletSummary(row: WalletRow, scan?: WalletScanResult): WalletSummary {
	return {
		id: row.id,
		name: row.name,
		type: 'xpub',
		scriptType: row.script_type,
		xpub: row.xpub,
		deviceType: row.device_type ?? null,
		createdAt: row.created_at,
		balance: scan?.confirmed ?? 0,
		unconfirmed: scan?.unconfirmed ?? 0,
		lastActivity: scan ? lastActivityOf(scan) : null
	};
}

/**
 * Build a list-view WalletSummary from the small cached balance blob
 * (walletSync.listCachedPortfolio) instead of a full WalletScanResult, so the
 * list never parses the whole snapshot. `bal` is already finalized (lastActivity
 * computed). Field mapping mirrors toWalletSummary — keep the two in sync.
 */
export function toWalletSummaryFromCache(
	row: WalletRow,
	bal: { confirmed: number; unconfirmed: number; lastActivity: number | null } | null
): WalletSummary {
	return {
		id: row.id,
		name: row.name,
		type: 'xpub',
		scriptType: row.script_type,
		xpub: row.xpub,
		deviceType: row.device_type ?? null,
		createdAt: row.created_at,
		balance: bal?.confirmed ?? 0,
		unconfirmed: bal?.unconfirmed ?? 0,
		lastActivity: bal?.lastActivity ?? null
	};
}

// ---------------------------------------------------------------- queries

export function getWallet(userId: number, id: number): WalletRow | null {
	const row = db
		.prepare('SELECT * FROM wallets WHERE id = ? AND user_id = ?')
		.get(id, userId) as unknown as WalletRow | undefined;
	return row ?? null;
}

/** All of a user's wallet rows, no scan — the synchronous, Electrum-free source
 *  for the SWR list path (see walletSync.listCachedPortfolio). Same ordering as
 *  listWallets. */
export function listWalletRows(userId: number): WalletRow[] {
	return db
		.prepare('SELECT * FROM wallets WHERE user_id = ? ORDER BY created_at ASC, id ASC')
		.all(userId) as unknown as WalletRow[];
}

/**
 * All wallets for a user, with live balances from (cached) scans.
 * A scan failure never throws: that wallet comes back with zeroed balances
 * and its error message lands in `errors[walletId]`.
 */
export async function listWallets(
	userId: number
): Promise<{ wallets: WalletSummary[]; errors: Record<number, string> }> {
	const rows = db
		.prepare('SELECT * FROM wallets WHERE user_id = ? ORDER BY created_at ASC, id ASC')
		.all(userId) as unknown as WalletRow[];

	const errors: Record<number, string> = {};
	const wallets = await Promise.all(
		rows.map(async (row) => {
			try {
				const scan = await scanWallet(row.xpub);
				return toWalletSummary(row, scan);
			} catch (e) {
				errors[row.id] = e instanceof Error ? e.message : 'Wallet scan failed';
				return toWalletSummary(row);
			}
		})
	);
	return { wallets, errors };
}

/**
 * Validate the caller-supplied key origin. Empty input is fine (null column);
 * NON-empty garbage throws — silently dropping a mistyped fingerprint would
 * quietly re-create the "hardware signing is broken" state this exists to fix
 * (cairn-alw8). The all-zero placeholder fingerprint counts as empty: some
 * device exports use it for "unknown".
 */
function normalizeOriginInput(input: {
	fingerprint?: unknown;
	derivationPath?: unknown;
}): { fingerprint: string | null; path: string | null } {
	const fpRaw = String(input.fingerprint ?? '').trim();
	let fingerprint: string | null = null;
	if (fpRaw && !/^0{8}$/.test(fpRaw)) {
		fingerprint = normalizeFingerprint(fpRaw);
		if (!fingerprint) {
			throw new Error(
				"That master fingerprint doesn't look right — it's exactly 8 characters of 0-9 and a-f, like 73c5da0a."
			);
		}
	}

	const pathRaw = String(input.derivationPath ?? '').trim();
	let path: string | null = null;
	if (pathRaw) {
		path = normalizeOriginPath(pathRaw);
		if (!path) {
			throw new Error(
				"That derivation path doesn't look right — it looks like m/84'/0'/0'."
			);
		}
	}

	return { fingerprint, path };
}

/** Standard BIP-purpose -> script type a derivation path's first component
 *  implies, per BIP44/49/84/86. 86' (Taproot) has no SLIP-132 prefix of its
 *  own — wallets export it under the plain xpub prefix — so it can never
 *  match a prefix-inferred type below; see assertDerivationMatchesPrefix. */
const PURPOSE_SCRIPT_TYPE: Record<number, ScriptType> = {
	44: 'p2pkh',
	49: 'p2sh-p2wpkh',
	84: 'p2wpkh',
	86: 'p2tr'
};

/** SLIP-132 prefix a prefix-inferred script type reads back as, for the
 *  mismatch error message (mirrors xpub.ts's PUBLIC_VERSIONS). */
const SCRIPT_TYPE_PREFIX: Partial<Record<ScriptType, string>> = {
	p2pkh: 'xpub',
	'p2sh-p2wpkh': 'ypub',
	p2wpkh: 'zpub'
};

const SCRIPT_TYPE_LABEL: Record<ScriptType, string> = {
	p2pkh: 'legacy',
	'p2sh-p2wpkh': 'nested SegWit',
	p2wpkh: 'native SegWit',
	p2tr: 'Taproot'
};

/** The BIP-32 purpose (first component) of a canonical `m/84'/0'/0'`-form
 *  path, or null when it doesn't start with a hardened number (shouldn't
 *  happen for anything normalizeOriginPath/parseKeyOriginInput produced). */
function purposeOf(path: string): number | null {
	const m = /^m\/(\d+)'/.exec(path);
	return m ? parseInt(m[1], 10) : null;
}

/**
 * Cross-check a declared derivation path's purpose against the script type
 * inferred from the key's own SLIP-132 prefix (xpub/ypub/zpub — see
 * xpub.ts's parseXpub). A mismatch means the user almost certainly exported
 * the wrong key: notably, a BIP-86 (Taproot) xpub uses the exact SAME prefix
 * as an ordinary BIP-44 xpub (no distinct SLIP-132 prefix exists for
 * Taproot), so without this check createWallet silently accepted it as a
 * legacy p2pkh wallet — generating addresses that never match what the same
 * key produces on any other Taproot-aware device/wallet (QA finding, task
 * #11). REJECTS rather than warns: Cairn doesn't support Taproot spending
 * yet, and a mismatched purpose/prefix pair is never a usable combination.
 *
 * Only enforced when a derivation path is actually declared (embedded in the
 * key string or passed explicitly) — an absent/unrecognized path is accepted
 * exactly as before, since there's nothing to contradict.
 */
function assertDerivationMatchesPrefix(
	derivationPath: string | null,
	prefixScriptType: ScriptType
): void {
	if (!derivationPath) return;
	const purpose = purposeOf(derivationPath);
	if (purpose === null) return;

	if (purpose === 86) {
		throw new Error(
			"Taproot wallets aren't supported yet. This key would generate legacy addresses that won't match your other wallet's."
		);
	}

	const impliedType = PURPOSE_SCRIPT_TYPE[purpose];
	// An unrecognized purpose has no implied type to check — nothing to enforce.
	if (!impliedType || impliedType === prefixScriptType) return;

	const prefixLabel = SCRIPT_TYPE_PREFIX[prefixScriptType] ?? prefixScriptType;
	throw new Error(
		`This key's derivation path (${derivationPath}) doesn't match its prefix type ` +
			`(${prefixLabel} → ${SCRIPT_TYPE_LABEL[prefixScriptType]}). Double-check you exported the right key.`
	);
}

export function createWallet(
	userId: number,
	input: {
		name?: string;
		xpub?: string;
		deviceType?: unknown;
		/** Optional key origin: master fingerprint (8 hex chars) … */
		fingerprint?: unknown;
		/** … and account derivation path (e.g. m/84'/0'/0'). Without these,
		 *  PSBTs carry no bip32Derivation and hardware signers can't sign
		 *  (cairn-alw8). The xpub field may alternatively embed both in
		 *  key-origin/descriptor form: `[73c5da0a/84'/0'/0']zpub…`. */
		derivationPath?: unknown;
	}
): WalletSummary {
	// The key may arrive in descriptor form with the origin embedded — that
	// embedded origin is the most authoritative source, so it wins over the
	// separate fields (which the wizard derives from the same string anyway).
	const parsedInput = parseKeyOriginInput(String(input.xpub ?? ''));
	const xpub = parsedInput.xpub;
	let scriptType: ScriptType;
	try {
		scriptType = parseXpub(xpub).scriptType;
	} catch (e) {
		throw new Error(friendlyXpubError(e));
	}

	const explicit = normalizeOriginInput(input);
	const masterFingerprint = parsedInput.fingerprint ?? explicit.fingerprint;
	const derivationPath = parsedInput.path ?? explicit.path;
	assertDerivationMatchesPrefix(derivationPath, scriptType);

	let name = String(input.name ?? '').trim().slice(0, 64);
	// Reject an embedded NUL rather than let node:sqlite silently truncate the
	// name at it on write (cairn-y73r/cairn-x5m9) — see textGuard.ts.
	if (containsNulByte(name)) {
		throw new Error(
			'Wallet name contains a NUL character (U+0000), which cannot be stored. Remove it and try again.'
		);
	}
	if (!name) {
		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM wallets WHERE user_id = ?')
			.get(userId) as { n: number };
		name = `Wallet ${n + 1}`;
	}

	// null (unspecified) is stored as-is — signing falls back to file/PSBT.
	const deviceType = normalizeDeviceType(input.deviceType);

	try {
		const res = db
			.prepare(
				`INSERT INTO wallets (user_id, name, type, xpub, script_type, device_type, master_fingerprint, derivation_path)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(userId, name, 'xpub', xpub, scriptType, deviceType, masterFingerprint, derivationPath);
		const row = getWallet(userId, Number(res.lastInsertRowid));
		if (!row) throw new Error('Wallet insert failed');
		// Adding a wallet is a significant account action: surface it in the
		// user's activity feed and the admin log (cairn-cvcu). recordActivity is
		// best-effort and never throws. No xpub in the detail — identity only.
		recordActivity({
			type: 'wallet_added',
			level: 'success',
			userId,
			message: `Wallet “${name}” added`,
			detail: {
				walletKind: 'wallet',
				walletId: row.id,
				scriptType,
				deviceType,
				// Diagnosable from the admin log: a wallet imported WITHOUT a key
				// origin cannot hardware-sign (cairn-alw8). Boolean only — the
				// fingerprint itself identifies a device, so it stays out.
				hasKeyOrigin: masterFingerprint !== null
			}
		});
		// Wave 2 / log-ops.md: createWallet previously logged only on failure —
		// no positive confirmation ever reached the server log, only the DB
		// activity feed (a separate store an operator reading `docker logs`
		// never sees). No xpub here either, same rationale as recordActivity above.
		log.info(
			{ userId, walletId: row.id, scriptType, deviceType, hasKeyOrigin: masterFingerprint !== null },
			'wallet created'
		);
		return toWalletSummary(row);
	} catch (e) {
		if (e instanceof Error && /UNIQUE/i.test(e.message)) {
			throw new Error('You already imported this key.');
		}
		// Log the raw DB driver error but throw a sanitized message: the wallets
		// API route forwards this verbatim to the client, so a raw driver string
		// must not reach it (cairn-6y98).
		log.error({ err: e, userId }, 'createWallet insert failed');
		throw new Error('Could not save the wallet. Please try again.');
	}
}

/**
 * Record (or clear) which signing device holds this wallet's key. Used when
 * the user associates a device during their first send. Returns the updated
 * summary, or null when the wallet doesn't exist or isn't owned by userId.
 */
export function setWalletDevice(
	userId: number,
	id: number,
	deviceType: unknown
): WalletSummary | null {
	const row = getWallet(userId, id);
	if (!row) return null;
	const normalized = normalizeDeviceType(deviceType);
	db.prepare('UPDATE wallets SET device_type = ? WHERE id = ? AND user_id = ?').run(
		normalized,
		id,
		userId
	);
	return toWalletSummary({ ...row, device_type: normalized });
}

export function deleteWallet(userId: number, id: number): boolean {
	const row = getWallet(userId, id);
	if (!row) return false;
	// The polymorphic (wallet_kind, wallet_id) child tables — notified_txids,
	// address_labels, wallet_backups, backup_missing_notified, balance_snapshots —
	// have no real FK to wallets, but db.ts's trg_wallets_delete_children trigger
	// sweeps all of them on this DELETE (cairn-97ui). Only the app-side effects
	// that can't move into SQL stay here.
	db.prepare('DELETE FROM wallets WHERE id = ? AND user_id = ?').run(id, userId);
	invalidateWalletCache(row.xpub);
	forgetReceiveWindow(row.xpub);
	// cairn-uzgu / cairn-gakd Phase 1: drop this wallet's scripthashes from the
	// address watcher's local state so it stops manufacturing orphaned
	// notified_txids rows and firing notifications that deep-link to a 404
	// wallet page. Electrum-side unsubscribe is Phase 2 (cairn-gakd).
	unwatchWallet(id);
	// Wave 2 / log-ops.md: deletion had NO log line at all (log file or
	// activity feed) — the invisible-failure class applies to deliberate,
	// destructive actions too. No xpub — identity only.
	log.info({ userId, walletId: id }, 'wallet deleted');
	return true;
}

/**
 * Wallet row plus a full scan. Returns null when the wallet doesn't exist
 * (or isn't owned); throws Error with cause 'unreachable' when the scan
 * fails so pages can render an error state around the wallet shell.
 */
export async function getWalletDetail(
	userId: number,
	id: number
): Promise<{ wallet: WalletRow; scan: WalletScanResult } | null> {
	const wallet = getWallet(userId, id);
	if (!wallet) return null;
	try {
		const scan = await scanWallet(wallet.xpub);
		return { wallet, scan };
	} catch (e) {
		throw new Error(e instanceof Error ? e.message : 'Wallet scan failed', {
			cause: 'unreachable'
		});
	}
}

// ------------------------------------------------------------- tx labels

export const TX_LABEL_MAX = 120;

/**
 * All transaction labels for a wallet, keyed by txid.
 * Returns null when the wallet doesn't exist or isn't owned by userId.
 */
export function getLabels(userId: number, walletId: number): Record<string, string> | null {
	if (!getWallet(userId, walletId)) return null;
	const rows = db
		.prepare('SELECT txid, label FROM tx_labels WHERE wallet_id = ?')
		.all(walletId) as unknown as { txid: string; label: string }[];
	const labels: Record<string, string> = {};
	for (const row of rows) labels[row.txid] = row.label;
	return labels;
}

/**
 * Upsert a free-text label on a transaction in this wallet. The label is
 * trimmed and capped at TX_LABEL_MAX characters; an empty (or all-whitespace)
 * label clears any existing one. Returns the stored value, or null when the
 * wallet doesn't exist or isn't owned by userId.
 */
export function setLabel(
	userId: number,
	walletId: number,
	txid: string,
	label: string
): { txid: string; label: string } | null {
	if (!getWallet(userId, walletId)) return null;

	const trimmed = String(label ?? '').trim().slice(0, TX_LABEL_MAX);
	// Reject an embedded NUL rather than let node:sqlite silently truncate the
	// label at it on write (cairn-y73r/cairn-x5m9) — see textGuard.ts.
	if (containsNulByte(trimmed)) {
		throw new TextInputError(
			'Transaction label contains a NUL character (U+0000), which cannot be stored. Remove it and try again.'
		);
	}
	if (!trimmed) {
		db.prepare('DELETE FROM tx_labels WHERE wallet_id = ? AND txid = ?').run(walletId, txid);
		return { txid, label: '' };
	}
	db.prepare(
		`INSERT INTO tx_labels (wallet_id, txid, label) VALUES (?, ?, ?)
		 ON CONFLICT (wallet_id, txid) DO UPDATE SET label = excluded.label`
	).run(walletId, txid, trimmed);
	return { txid, label: trimmed };
}

// ------------------------------------------------------- receive addresses

function clampToGap(idx: number, nextUnused: number): number {
	// Never hand out an address beyond the gap-limit window, or wallets that
	// follow BIP44 discovery would miss funds sent to it.
	return Math.min(idx, nextUnused + GAP_LIMIT - 1);
}

/**
 * Per-xpub memory of the last *actually scanned* next-unused receive index, so a
 * Rotate click can advance one address without paying a fresh gap-limit Electrum
 * rescan every time (cairn-2ic5). scanWallet's own cache is only 60s, so a Rotate
 * more than a minute after the wallet page last scanned would otherwise re-run
 * the full portfolio-grade scan (30-40s) just to advance one index the wallet
 * already knows is unused.
 *
 * Safety: every index in [nextUnused, nextUnused + GAP_LIMIT − 1] was unused as
 * of the recorded scan, so reusing this window to advance can never re-hand-out
 * an address that Cairn or the chain had already used *at scan time*. The only
 * residual risk is an address funded out-of-band since the scan; we bound that
 * exposure with RECEIVE_WINDOW_TTL_MS and always fall back to a real scan the
 * moment the caller would probe at/past the known gap boundary — the one place a
 * stale boundary could actually hand out the wrong index.
 */
const RECEIVE_WINDOW_TTL_MS = 5 * 60_000;
const knownReceiveWindow = new Map<string, { nextUnused: number; at: number }>();

/** Resolve the receive-chain next-unused index and record it for the reuse
 *  window. This is the only receive-address path that pays the scan cost. */
async function resolveReceiveNextUnused(xpub: string): Promise<number> {
	const nextUnused = await findNextUnusedIndex(xpub, 0);
	knownReceiveWindow.set(xpub.trim(), { nextUnused, at: Date.now() });
	return nextUnused;
}

/** The recorded next-unused index for an xpub, or null when absent or older than
 *  RECEIVE_WINDOW_TTL_MS (reuse never refreshes the timestamp, so staleness is
 *  measured from the last *real* scan, not the last hand-out). */
function knownNextUnused(xpub: string): number | null {
	const hit = knownReceiveWindow.get(xpub.trim());
	if (!hit) return null;
	if (Date.now() - hit.at > RECEIVE_WINDOW_TTL_MS) return null;
	return hit.nextUnused;
}

/**
 * Hand out the next unused receive address and advance the cursor.
 * `afterIndex` (optional) requests an address strictly after the one the
 * caller is already showing, so repeated clicks always swap to a fresh one.
 * Cycles within the gap window — the index never exceeds nextUnused + 19.
 */
export async function nextReceiveAddress(
	userId: number,
	id: number,
	afterIndex?: number
): Promise<{ address: string; path: string; index: number } | null> {
	// cairn-2qa4: serialize issuance per wallet. Without this, two concurrent
	// callers could both read the same cursor, await the same gap scan, derive
	// the same index, and hand out the same address. `getWallet` below is the
	// first read in the critical section, so a caller queued behind another
	// only reads the cursor once the earlier caller's write has landed.
	return withLock(`wallet:${id}`, async () => {
		const wallet = getWallet(userId, id);
		if (!wallet) return null;

		const after = Number.isInteger(afterIndex) ? (afterIndex as number) : -1;
		// The index we'd hand out before any gap clamp — the furthest of the cursor
		// and one past the address on display. (The scanned used-boundary joins the
		// max below once we know it.)
		const want = Math.max(wallet.receive_cursor, after + 1);

		// Fast path (cairn-2ic5): if a recent scan already told us the used-boundary
		// and `want` lands on a known-unused address strictly inside the gap window,
		// advance without re-scanning. Anything at or past the window ceiling still
		// forces a real scan, since that's exactly where a stale boundary could hand
		// out a wrong index.
		const cached = knownNextUnused(wallet.xpub);
		const nextUnused =
			cached !== null && want >= cached && want <= cached + GAP_LIMIT - 1
				? cached
				: await resolveReceiveNextUnused(wallet.xpub);

		const idx = clampToGap(Math.max(nextUnused, wallet.receive_cursor, after + 1), nextUnused);
		const { address, path } = deriveAddress(parseXpub(wallet.xpub), 0, idx);

		// cairn-2qa4: MAX as defense-in-depth — even under an unforeseen race the
		// cursor can only advance, never regress to a lower, already-issued value.
		db.prepare(
			'UPDATE wallets SET receive_cursor = MAX(receive_cursor, ?) WHERE id = ? AND user_id = ?'
		).run(Math.min(idx + 1, nextUnused + GAP_LIMIT), id, userId);
		return { address, path, index: idx };
	});
}

/**
 * The receive address currently "on display" — the most recently handed-out
 * index (cursor − 1) or the next unused one, whichever is further along.
 * Read-only: never advances the cursor. Runs on every wallet-page load, so it
 * doubles as the seed for the Rotate reuse window above.
 */
export async function peekReceiveAddress(
	wallet: WalletRow
): Promise<{ address: string; path: string; index: number }> {
	const nextUnused = await resolveReceiveNextUnused(wallet.xpub);
	const idx = clampToGap(Math.max(nextUnused, wallet.receive_cursor - 1), nextUnused);
	const { address, path } = deriveAddress(parseXpub(wallet.xpub), 0, idx);
	return { address, path, index: idx };
}

/** Drop the Rotate reuse window for an xpub (wallet removed). Keeps the private
 *  cache from re-seeding a deleted wallet's stale boundary. */
export function forgetReceiveWindow(xpub: string): void {
	knownReceiveWindow.delete(xpub.trim());
}
