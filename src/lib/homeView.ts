// Pure, tiny Home-page rendering-rule helpers (UX redesign Phase 1,
// cairn-gt05.1, docs/UX-REDESIGN-SPEC.md §2.1/§2.6b). Kept out of the Svelte
// component so the conditional-render rules (wallet count, activity
// emptiness, Health-line state) are unit-testable without mounting a
// component — mirrors portfolioViewState.ts's pattern.

import { deriveHealth } from './health';

/**
 * The wallet list only renders on Home when there's more than one wallet
 * (spec §2.1 A/B rationale: one wallet gets the clean Muun-style hero with no
 * list — there's nothing to list; 2+ wallets get the compact quiet list).
 */
export function shouldShowWalletList(walletCount: number): boolean {
	return walletCount > 1;
}

/**
 * The RECENT activity section is omitted entirely when there's nothing to
 * show (spec §2.1: "omitted entirely when empty") rather than rendering an
 * empty-state card — Home stays uncluttered for a brand-new funded wallet.
 */
export function shouldShowRecentActivity(activityCount: number): boolean {
	return activityCount > 0;
}

export interface HomeHealthInput {
	/** Wallets whose config has never been backed up (funds-risk if lost). */
	unbackedCount: number;
	/** Chain transport (Electrum/Core union) reachability, from /api/chain-health. */
	chainHealthy: boolean;
}

export interface HomeHealth {
	/** False when at least one duty needs attention — renders the amber state. */
	ok: boolean;
	/** The exact "Health · …" line copy (spec §2.6b). */
	label: string;
	/** How many distinct duties need attention. */
	issueCount: number;
}

/**
 * The Health line for Home (spec §2.6b), now a thin wrapper over the shared
 * Phase 3 Health object ($lib/health.ts) so Home's line, the layout banners,
 * and the admin Health page all read the SAME derivation — one truth, three
 * altitudes. The shape Home consumes is unchanged from Phase 1.
 */
export function deriveHomeHealth({ unbackedCount, chainHealthy }: HomeHealthInput): HomeHealth {
	const h = deriveHealth({ unbackedCount, chainHealthy });
	return { ok: h.ok, label: h.homeLabel, issueCount: h.issueCount };
}
