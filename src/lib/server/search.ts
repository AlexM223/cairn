// Search classifier: turns free-text explorer queries into a destination.

import { getChain } from './chain';
import { CoreRpcError } from './bitcoinCore/client';
import { isExplorerAddress } from './bitcoin/xpub';
import type { SearchResult } from '$lib/types';

/**
 * True when an upstream chain error means "no such object" (or a malformed id)
 * rather than "chain data sources unreachable". Covers Bitcoin Core's
 * not-found/invalid-param codes (-5 / -8) and the generic "not found" message
 * ChainService throws for a Core miss.
 */
export function isNotFoundError(e: unknown): boolean {
	if (e instanceof CoreRpcError) return e.code === -5 || e.code === -8;
	return e instanceof Error && /not found/i.test(e.message);
}

/** Human-readable message for a failed chain call. */
export function chainErrorMessage(e: unknown): string {
	if (e instanceof Error && e.message) return e.message;
	return 'Could not reach chain data sources';
}

const HEIGHT_RE = /^\d{1,9}$/;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Total wall-clock budget for a whole classify pass. A 64-hex query can chain a
 * tip/tx/block lookup; with a healthy local Core/Electrum these are fast, but a
 * MISCONFIGURED backend must never let first paint hang on a stack of full request
 * timeouts (cairn-zoz8) — on budget exhaustion we return the 'unknown' result the
 * Explorer already renders as "couldn't classify / chain unreachable".
 */
const CLASSIFY_BUDGET_MS = 4_000;

/** Resolve to `fallback` if `p` doesn't settle within the remaining budget. */
function withBudget<T>(p: Promise<T>, deadline: number, fallback: T): Promise<T> {
	const remaining = Math.max(0, deadline - Date.now());
	return Promise.race([
		p,
		new Promise<T>((resolve) => {
			const t = setTimeout(() => resolve(fallback), remaining);
			t.unref?.();
		})
	]);
}

/** Classify a search query into block / tx / address / unknown. Never throws. */
export async function classifySearch(q: string): Promise<SearchResult> {
	const query = q.trim();
	const unknown: SearchResult = { type: 'unknown', redirect: null, query };
	if (query === '') return unknown;
	const deadline = Date.now() + CLASSIFY_BUDGET_MS;

	// Plain number: block height, if it isn't beyond the chain tip.
	if (HEIGHT_RE.test(query)) {
		const height = parseInt(query, 10);
		// Optimistic sentinel: on unreachable OR budget-exhausted tip, classify as a
		// block height anyway (the block page surfaces any connectivity error itself).
		const tip = await withBudget(
			getChain()
				.getTip()
				.catch(() => null),
			deadline,
			null
		);
		if (tip && height > tip.height + 1) return unknown;
		return { type: 'block-height', redirect: `/explorer/block/${height}`, query };
	}

	// 64 hex chars: block hash or txid.
	if (HEX64_RE.test(query)) {
		const hex = query.toLowerCase();
		// Real block hashes lead with many zero nibbles; 8+ is unambiguous.
		if (hex.startsWith('00000000')) {
			return { type: 'block-hash', redirect: `/explorer/block/${hex}`, query };
		}
		const chain = getChain();
		const NOT_FOUND = Symbol('tx-not-found');
		const OTHER_ERROR = Symbol('tx-other-error');
		const tx = await withBudget(
			chain.getTx(hex).catch((e) => (isNotFoundError(e) ? NOT_FOUND : OTHER_ERROR)),
			deadline,
			// Budget exhaustion / timeout: preserve prior behavior and fall through
			// to the block lookup below rather than routing to a page we couldn't
			// confirm exists.
			NOT_FOUND
		);
		if (tx !== NOT_FOUND && tx !== OTHER_ERROR) {
			return { type: 'tx', redirect: `/explorer/tx/${hex}`, query };
		}
		if (tx === OTHER_ERROR) {
			// getTx failed for a reason OTHER than "no such tx" — e.g. a
			// misconfigured/verbose-unsupported Electrum backend or an unconfigured
			// Core RPC (cairn-37gfa). The leading-zeros check above already ruled
			// this hex out as a block hash, so it's still txid-shaped: route to the
			// tx page, which renders its own honest "needs a Bitcoin Core node" /
			// error notice, instead of misreporting a syntactically valid txid as
			// unclassifiable.
			return { type: 'tx', redirect: `/explorer/tx/${hex}`, query };
		}
		// Not a known tx — fall through to block lookup with whatever budget remains.
		const BLK = Symbol('block-miss');
		const block = await withBudget(
			chain.getBlock(hex).catch(() => BLK),
			deadline,
			BLK
		);
		if (block !== BLK) return { type: 'block-hash', redirect: `/explorer/block/${hex}`, query };
		return unknown;
	}

	// Use isExplorerAddress (not the mainnet-only isValidAddress) so the search
	// bar recognizes the same tb.../bcrt.../testnet addresses the address page
	// itself accepts — otherwise a valid testnet/regtest address pasted here
	// returns "unknown" even though /explorer/address/<addr> works (cairn-i8vr).
	if (isExplorerAddress(query)) {
		return { type: 'address', redirect: `/explorer/address/${query}`, query };
	}

	return unknown;
}
