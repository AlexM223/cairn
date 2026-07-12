// Explorer wallet-awareness ("this is yours") lookup — server-only, private to the
// explorer route (a *.server.ts module, so SvelteKit never treats it as a route).
//
// Goal: when a LOGGED-IN user views an explorer address or tx that touches one of
// THEIR OWN wallets, surface a plain-language badge linking back to the wallet.
//
// Ownership boundary (the whole point): we ONLY ever enumerate the *viewing user's*
// own + shared wallets and match against those. We never ask "does this address
// belong to ANY wallet on the instance" — only "does it belong to one of MINE" —
// so it is structurally impossible for one user to learn another user's ownership.
// "Involved" = any legitimate access under the 3-tier collaborative-custody model:
//   - single-sig: the wallet's owner (wallets.user_id)
//   - multisig:   owner OR any accepted share (viewer or cosigner) — mirrors
//                 getViewableMultisig()'s access predicate exactly.
//
// Cost: zero extra chain calls. We read only data the app already persists — the
// per-wallet `wallet_snapshots` JSON (the same blob the wallet-detail page renders
// from) — via PK lookups. Work is bounded by the *viewing user's own wallet count*
// (typically a handful), NOT by instance size. A short per-process memo keeps rapid
// explorer navigation from re-parsing snapshots on every hop.

import { db } from '$lib/server/db';
import { listWalletRows } from '$lib/server/wallets';
import { readWalletSnapshot, readMultisigSnapshot } from '$lib/server/walletSync';
import type { TxDetail } from '$lib/types';

/** A wallet the viewing user has access to, plus the route back to its detail page. */
export interface OwnedWalletRef {
	kind: 'wallet' | 'multisig';
	id: number;
	name: string;
	/** Link target: single-sig `/wallets/<id>`, multisig `/wallets/multisig/<id>`. */
	href: string;
}

interface AddrEntry {
	wallet: OwnedWalletRef;
	/** True when this is an internal (change) address rather than a receive address. */
	change: boolean;
}

interface UserWalletIndex {
	/** address -> the user's wallet that owns it (first match wins). */
	addr: Map<string, AddrEntry>;
	/** txid -> the user's wallet(s) whose stored history contains it. */
	txid: Map<string, OwnedWalletRef[]>;
}

// Owner OR any accepted share (viewer/cosigner). Same access predicate as
// getViewableMultisig(); listMultisigs() only returns OWNED rows, so we can't
// reuse it here. Uses the idx_multisig_shares_shared_with index for the EXISTS.
const viewableMultisigsStmt = db.prepare(
	`SELECT m.id AS id, m.name AS name FROM multisigs m
	 WHERE m.user_id = ?
	    OR EXISTS (SELECT 1 FROM multisig_shares s
	               WHERE s.multisig_id = m.id AND s.shared_with_id = ?)
	 ORDER BY m.id ASC`
);

function buildIndex(userId: number): UserWalletIndex {
	const addr = new Map<string, AddrEntry>();
	const txid = new Map<string, OwnedWalletRef[]>();

	const addTx = (t: string, ref: OwnedWalletRef) => {
		const arr = txid.get(t);
		if (!arr) {
			txid.set(t, [ref]);
		} else if (!arr.some((w) => w.kind === ref.kind && w.id === ref.id)) {
			arr.push(ref);
		}
	};

	// Single-sig wallets the user owns. listWalletRows is a synchronous, indexed
	// (idx_wallets_user), chain-free query.
	for (const w of listWalletRows(userId)) {
		const ref: OwnedWalletRef = {
			kind: 'wallet',
			id: w.id,
			name: w.name,
			href: `/wallets/${w.id}`
		};
		const snap = readWalletSnapshot(w.id)?.snapshot;
		if (!snap?.scan) continue;
		for (const a of snap.scan.addresses) {
			if (!addr.has(a.address)) addr.set(a.address, { wallet: ref, change: a.change });
		}
		for (const t of snap.scan.txs) addTx(t.txid, ref);
	}

	// Multisigs the user owns OR has an accepted share in.
	for (const m of viewableMultisigsStmt.all(userId, userId) as { id: number; name: string }[]) {
		const ref: OwnedWalletRef = {
			kind: 'multisig',
			id: m.id,
			name: m.name,
			href: `/wallets/multisig/${m.id}`
		};
		const snap = readMultisigSnapshot(m.id)?.snapshot;
		if (!snap?.detail) continue;
		for (const a of snap.detail.addresses) {
			// MultisigScanAddress.chain: 0 = receive, 1 = change.
			if (!addr.has(a.address)) addr.set(a.address, { wallet: ref, change: a.chain === 1 });
		}
		for (const t of snap.detail.history) addTx(t.txid, ref);
	}

	return { addr, txid };
}

// Per-process memo, keyed by userId. Snapshots only change on the background
// wallet-sync refresh, so a few seconds of staleness on an ownership badge is
// invisible and self-heals; this keeps a wallet-heavy user's rapid explorer
// navigation from re-parsing every snapshot on each page.
const MEMO_TTL_MS = 3000;
const memo = new Map<number, { at: number; index: UserWalletIndex }>();

function getIndex(userId: number): UserWalletIndex {
	const now = Date.now();
	const hit = memo.get(userId);
	if (hit && now - hit.at < MEMO_TTL_MS) return hit.index;
	const index = buildIndex(userId);
	memo.set(userId, { at: now, index });
	// Bound the map: opportunistically drop expired entries when it grows.
	if (memo.size > 64) {
		for (const [k, v] of memo) if (now - v.at >= MEMO_TTL_MS) memo.delete(k);
	}
	return index;
}

/** Badge data for an explorer address page: the viewing user's wallet that owns
 *  this address, or null when it's not theirs (or no user). */
export interface AddressOwnership {
	wallet: OwnedWalletRef;
	/** True for an internal change address (worth saying so in the copy). */
	change: boolean;
}

export function addressOwnership(
	userId: number | undefined,
	address: string
): AddressOwnership | null {
	if (!userId) return null;
	const entry = getIndex(userId).addr.get(address);
	return entry ? { wallet: entry.wallet, change: entry.change } : null;
}

/** Badge data for an explorer tx page. */
export interface TxOwnership {
	/** De-duped wallets the viewing user has that this tx touches (by matched
	 *  input/output address, or by the wallet's own stored history). Drives the
	 *  summary badge at the top of the tx page. */
	wallets: OwnedWalletRef[];
	/** address -> the user's wallet that owns it, for badging the individual
	 *  input/output rows that are theirs. */
	addressOwners: Record<string, OwnedWalletRef>;
}

export function txOwnership(userId: number | undefined, tx: TxDetail): TxOwnership | null {
	if (!userId) return null;
	const idx = getIndex(userId);
	const keyOf = (r: OwnedWalletRef) => `${r.kind}:${r.id}`;

	const addressOwners: Record<string, OwnedWalletRef> = {};
	const walletsByKey = new Map<string, OwnedWalletRef>();

	const consider = (address: string | null) => {
		if (!address || addressOwners[address]) return;
		const e = idx.addr.get(address);
		if (e) {
			addressOwners[address] = e.wallet;
			walletsByKey.set(keyOf(e.wallet), e.wallet);
		}
	};
	for (const v of tx.vin) consider(v.address);
	for (const o of tx.vout) consider(o.address);

	// Whole-tx involvement via the wallet's own history — catches self-transfers
	// and cases where an input/output address couldn't be decoded.
	for (const w of idx.txid.get(tx.txid) ?? []) walletsByKey.set(keyOf(w), w);

	if (walletsByKey.size === 0) return null;
	return { wallets: [...walletsByKey.values()], addressOwners };
}
