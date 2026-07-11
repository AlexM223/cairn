// Unconfirmed-chain depth warnings (cairn-u9ob.5, docs/CPFP-UNCONFIRMED-PLAN.md §5).
//
// Once a wallet can spend unconfirmed coins (cairn-u9ob.1), a user can chain
// unconfirmed sends — spend change before it confirms, repeatedly — until the
// node rejects the next one at broadcast with an opaque policy error. We count
// the chain depth BEFORE that happens and warn (never block).
//
// Two mempool-policy regimes coexist in the wild and Cairn can't reliably tell
// which a given node runs:
//   • Legacy (Bitcoin Core ≤ 30.x): 25 unconfirmed ancestors, 25 descendants,
//     101,000 vB package size.
//   • Cluster mempool (Core 31.0+, April 2026): per-tx ancestor/descendant
//     counts removed; a whole cluster may hold up to 64 txs / 101,000 vB.
// We default to the LEGACY, more conservative count — warning early on a
// cluster-mempool node is a harmless false positive (its real ceiling is
// looser), whereas warning late on a legacy node means an unexplained broadcast
// rejection, the worse outcome. The signal comes from ChainService.getCpfpInfo —
// now backed by the operator's own Bitcoin Core mempool (getmempoolentry +
// getmempoolancestors/descendants, cairn-zoz8.12), with an optional Esplora
// fallback. When neither backend can serve it (no Core RPC configured) getCpfpInfo
// returns null and we degrade silently (no warning), as before.

import { getChain } from './chain';
import { childLogger } from './logger';

const log = childLogger('chain-depth');

/** Legacy per-tx caps — the conservative default when the regime is unknown. */
export const LEGACY_ANCESTOR_LIMIT = 25;
export const LEGACY_DESCENDANT_LIMIT = 25;

/** Warn once the count is within this many of the cap (so the user has room to
 *  act before the hard rejection). */
const COUNT_WARN_MARGIN = 3;

export type ChainDepthKind = 'ancestors' | 'descendants';

export interface ChainDepthWarning {
	/** The unconfirmed tx whose chain is close to the limit. */
	txid: string;
	kind: ChainDepthKind;
	/** Unconfirmed txs already in that direction of the chain, INCLUDING this tx. */
	count: number;
	/** The cap `count` is measured against. */
	limit: number;
	/** Plain-language, non-blocking warning (Cairn UX: no jargon in the primary copy). */
	message: string;
}

function warnMessage(kind: ChainDepthKind, count: number, limit: number): string {
	// Deliberately avoids "ancestor/descendant/mempool package" jargon in the
	// primary sentence — the number and the consequence are what the user needs.
	if (kind === 'ancestors') {
		return (
			`This coin is part of a long chain of ${count} unconfirmed transactions, close to the ` +
			`network's limit of ${limit}. Spending it may be rejected until some of them confirm — ` +
			`waiting a little, or spending a confirmed coin instead, avoids that.`
		);
	}
	return (
		`This transaction already has ${count} unconfirmed follow-on transactions, close to the ` +
		`network's limit of ${limit}. Adding another may be rejected until some confirm — ` +
		`waiting a little avoids that.`
	);
}

function maybeWarn(
	txid: string,
	kind: ChainDepthKind,
	count: number,
	limit: number
): ChainDepthWarning | null {
	if (count < limit - COUNT_WARN_MARGIN) return null;
	return { txid, kind, count, limit, message: warnMessage(kind, count, limit) };
}

/** Keep the warning with the higher count (closest to its cap). */
function worse(a: ChainDepthWarning | null, b: ChainDepthWarning | null): ChainDepthWarning | null {
	if (!a) return b;
	if (!b) return a;
	return b.count > a.count ? b : a;
}

/**
 * Check the unconfirmed ancestor/descendant depth of each given txid and return
 * the single most-concerning warning, or null when nothing is close to a limit
 * OR the data isn't available (degrade silently). Confirmed txids naturally
 * return no CPFP package and are skipped, so passing a mix of confirmed and
 * unconfirmed input txids is safe — only genuinely deep unconfirmed chains warn.
 *
 * Never throws: a per-txid lookup failure is logged at debug and skipped.
 */
export async function checkUnconfirmedChainDepth(
	txids: string[]
): Promise<ChainDepthWarning | null> {
	const chain = getChain();
	let worst: ChainDepthWarning | null = null;
	for (const txid of [...new Set(txids.map((t) => t.toLowerCase()))]) {
		let info;
		try {
			info = await chain.getCpfpInfo(txid);
		} catch (e) {
			log.debug({ err: e, txid }, 'chain-depth lookup failed (skipped)');
			continue;
		}
		if (!info) continue; // no v1 /cpfp data (or nothing in-mempool) — degrade silently
		// +1 counts the queried tx itself alongside its ancestors / descendants.
		worst = worse(worst, maybeWarn(txid, 'ancestors', info.ancestors.length + 1, LEGACY_ANCESTOR_LIMIT));
		worst = worse(
			worst,
			maybeWarn(txid, 'descendants', info.descendants.length + 1, LEGACY_DESCENDANT_LIMIT)
		);
	}
	return worst;
}

/**
 * Given the inputs a draft actually selected plus the classified UTXO set (which
 * carries `height`), return a chain-depth warning if any SELECTED input spends an
 * unconfirmed coin whose chain is near a limit. Only pays the network cost when
 * an unconfirmed coin was actually selected — a normal all-confirmed send does no
 * extra work.
 */
export async function checkSelectedInputsChainDepth(
	selectedInputs: { txid: string; vout: number }[],
	utxos: { txid: string; vout: number; height: number }[]
): Promise<ChainDepthWarning | null> {
	const unconfirmed = new Set(
		utxos.filter((u) => u.height <= 0).map((u) => `${u.txid.toLowerCase()}:${u.vout}`)
	);
	const txids = [
		...new Set(
			selectedInputs
				.filter((i) => unconfirmed.has(`${i.txid.toLowerCase()}:${i.vout}`))
				.map((i) => i.txid)
		)
	];
	if (txids.length === 0) return null;
	return checkUnconfirmedChainDepth(txids);
}
