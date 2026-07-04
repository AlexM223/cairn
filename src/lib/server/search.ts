// Search classifier: turns free-text explorer queries into a destination.

import { getChain } from './chain';
import { EsploraHttpError } from './chain/esplora';
import { isValidAddress } from './bitcoin/xpub';
import type { SearchResult } from '$lib/types';

/**
 * True when an upstream chain error means "no such object" (or a malformed id)
 * rather than "chain data sources unreachable".
 */
export function isNotFoundError(e: unknown): boolean {
	if (e instanceof EsploraHttpError) return e.status === 404 || e.status === 400;
	return e instanceof Error && /not found/i.test(e.message);
}

/** Human-readable message for a failed chain call. */
export function chainErrorMessage(e: unknown): string {
	if (e instanceof Error && e.message) return e.message;
	return 'Could not reach chain data sources';
}

const HEIGHT_RE = /^\d{1,9}$/;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;

/** Classify a search query into block / tx / address / unknown. Never throws. */
export async function classifySearch(q: string): Promise<SearchResult> {
	const query = q.trim();
	const unknown: SearchResult = { type: 'unknown', redirect: null, query };
	if (query === '') return unknown;

	// Plain number: block height, if it isn't beyond the chain tip.
	if (HEIGHT_RE.test(query)) {
		const height = parseInt(query, 10);
		try {
			const tip = await getChain().getTip();
			if (height > tip.height + 1) return unknown;
		} catch {
			// Chain unreachable — classify optimistically; the block page will
			// surface the connectivity error itself.
		}
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
		try {
			await chain.getTx(hex);
			return { type: 'tx', redirect: `/explorer/tx/${hex}`, query };
		} catch {
			// Not a known tx (or unreachable) — fall through to block lookup.
		}
		try {
			await chain.getBlock(hex);
			return { type: 'block-hash', redirect: `/explorer/block/${hex}`, query };
		} catch {
			return unknown;
		}
	}

	if (isValidAddress(query)) {
		return { type: 'address', redirect: `/explorer/address/${query}`, query };
	}

	return unknown;
}
