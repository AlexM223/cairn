// Pure delta computation for the Home balance chart's per-range chip
// (dashboard polish, #22). Split out so the dust-level threshold rule is
// unit-testable without mounting a component — mirrors the
// portfolioViewState.ts pattern used elsewhere for the same reason.

export type BalanceDeltaDirection = 'up' | 'down' | 'flat';

export interface BalanceDelta {
	/** end balance minus the window's starting (baseline) balance, in sats. */
	sats: number;
	/** Percent change over the window, or null when the baseline was 0 (no
	 *  meaningful percentage — the chip falls back to an absolute BTC delta). */
	pct: number | null;
	dir: BalanceDeltaDirection;
	/** True when the window's balances are dust-level enough that a %/BTC
	 *  change reads as noise rather than signal (a few thousand sats moving
	 *  40% looks alarming but means nothing) — the chip renders a neutral
	 *  em-dash instead of a colored up/down badge in that case. */
	dust: boolean;
}

/** Below this starting (baseline) balance, a computed percentage swings
 *  wildly on tiny absolute moves — not a meaningful trend. */
export const DUST_BASELINE_SATS = 10_000;

/** Below this ending balance, the wallet itself is at dust level regardless
 *  of how the window started — same neutral treatment applies. */
export const DUST_END_BALANCE_SATS = 1_000;

/** Compute the chart's delta chip data for one range window. `first`/`last`
 *  are the sats balance at the start and end of the visible window. */
export function computeBalanceDelta(first: number, last: number): BalanceDelta {
	const sats = last - first;
	const pct = first > 0 ? (sats / first) * 100 : null;
	const dir: BalanceDeltaDirection = sats > 0 ? 'up' : sats < 0 ? 'down' : 'flat';
	const dust = first < DUST_BASELINE_SATS || last < DUST_END_BALANCE_SATS;
	return { sats, pct, dir, dust };
}
