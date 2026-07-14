// Pure copy/badge helpers for the transaction block-context section
// (docs/TX-BLOCK-CONTEXT-DESIGN.md §5). Kept free of Svelte + chain code so the
// plain-language summary and the confirmation badge are unit-testable in isolation.

import type { BlockContext } from '$lib/types';
import { formatNumber, formatFeeRate, formatSats } from '$lib/format';

/** Confirmation badge tone → drives the pill colour in BlockContext.svelte:
 *   'sealed'      — ≥6 confirmations, green (settled).
 *   'partial'     — 1–5 confirmations, neutral (still burying).
 *   'unconfirmed' — 0 confirmations / mempool, amber. */
export type ConfirmationTone = 'sealed' | 'partial' | 'unconfirmed';

export interface ConfirmationBadge {
	label: string;
	tone: ConfirmationTone;
}

/**
 * The confirmation badge label + tone (req 4). Alex specified the literal "6+
 * confirmations" green badge for this element — an intentional deviation from the
 * house "buried N rings" copy, which the paired BurialRings glyph still carries.
 *   ≥6 → "6+ confirmations" (green) · 1–5 → "N confirmation(s)" (neutral) ·
 *   0/unconfirmed → "Unconfirmed" (amber).
 */
export function confirmationBadge(ctx: BlockContext): ConfirmationBadge {
	if (!ctx.confirmed) return { label: 'Unconfirmed', tone: 'unconfirmed' };
	const confs = ctx.confirmations ?? 0;
	if (confs >= 6) return { label: '6+ confirmations', tone: 'sealed' };
	if (confs <= 0) return { label: 'Unconfirmed', tone: 'unconfirmed' };
	return { label: `${confs} confirmation${confs === 1 ? '' : 's'}`, tone: 'partial' };
}

/** Join 1–2 clauses with "and" (only ever two here: size + fee rate). */
function joinClauses(parts: string[]): string {
	if (parts.length <= 1) return parts[0] ?? '';
	return `${parts[0]} and ${parts[1]}`;
}

/**
 * One-sentence plain-language confirmation summary (req 3). Drops any clause whose
 * fact is unknown so a basic-tier (Electrum-only) tx still reads as a complete,
 * intentional sentence rather than one with "—" holes:
 *   full     → "Confirmed 97 blocks ago on block 948,197. With a size of 110 vB and
 *               a fee rate of 2 sat/vB, paying a 224 sat fee."
 *   basic    → "Confirmed 97 blocks ago on block 948,197." (+ size clause if vsize known)
 *   1-conf   → "Confirmed in the latest block, 948,197."
 *   mempool  → "Waiting in the mempool — not in a block yet."
 */
export function summaryLine(ctx: BlockContext): string {
	if (!ctx.confirmed) return 'Waiting in the mempool — not in a block yet.';

	const heightStr = ctx.height != null ? formatNumber(ctx.height) : null;
	// A tx with C confirmations sits C−1 blocks below the tip; C === 1 is the tip.
	const blocksAgo = Math.max(0, (ctx.confirmations ?? 1) - 1);

	let lead: string;
	if (blocksAgo === 0) {
		lead = heightStr ? `Confirmed in the latest block, ${heightStr}.` : 'Confirmed in the latest block.';
	} else {
		const ago = `${formatNumber(blocksAgo)} block${blocksAgo === 1 ? '' : 's'} ago`;
		lead = heightStr ? `Confirmed ${ago} on block ${heightStr}.` : `Confirmed ${ago}.`;
	}

	// Optional size/fee-rate clause, then the fee amount. Whichever fact is unknown
	// is simply omitted (Electrum-only txs have a known vsize but null fee/feeRate).
	const clauses: string[] = [];
	if (ctx.vsize != null) clauses.push(`a size of ${formatNumber(ctx.vsize)} vB`);
	if (ctx.feeRate != null) clauses.push(`a fee rate of ${formatFeeRate(ctx.feeRate)}`);

	let tail = '';
	if (clauses.length > 0) {
		tail = ` With ${joinClauses(clauses)}`;
		tail += ctx.fee != null ? `, paying a ${formatSats(ctx.fee)} sat fee.` : '.';
	} else if (ctx.fee != null) {
		tail = ` It paid a ${formatSats(ctx.fee)} sat fee.`;
	}

	return lead + tail;
}
