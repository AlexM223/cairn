// The three explicit render states an SWR wallet page (list or detail) can be in
// — never a silently-zeroed balance when a real snapshot is genuinely absent.
// Pure + tiny so the decision is unit-testable without a component (cairn-2zxt).

export type PortfolioViewState = 'first-sync' | 'unreachable' | 'ready';

/**
 * Decide the render state from the two signals the SWR pages carry:
 *
 *   • ready       — a real snapshot exists (`lastSyncedAt` set): render the
 *                   cached balance/rows plus a "synced Xs ago" indicator. Once
 *                   we have ANY good data we stay here even if a later refresh
 *                   fails — that's the whole point of stale-while-revalidate.
 *   • first-sync  — never synced AND the background refresh has not failed yet
 *                   (still in flight, or not yet attempted): show the syncing
 *                   skeleton ("Syncing with the network for the first time…").
 *   • unreachable — never synced AND the refresh has failed: show an explicit
 *                   "couldn't reach the server — retry" affordance, NEVER a
 *                   fake zero balance.
 *
 * `lastSyncedAt` wins over `refreshFailed` so a stale-but-present snapshot is
 * always shown rather than hidden behind an error.
 */
export function portfolioViewState(o: {
	lastSyncedAt: number | null;
	refreshFailed: boolean;
}): PortfolioViewState {
	if (o.lastSyncedAt !== null) return 'ready';
	return o.refreshFailed ? 'unreachable' : 'first-sync';
}
