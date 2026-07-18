// Single source of confirmation math (docs/LIVE-UPDATES-DESIGN.md §4.3).
//
// Confirmation-count bugs (the cairn-1n11 class) have historically come from
// several places independently computing "how many confirmations does this tx
// have" slightly differently, or reading the tip at different times. This pure
// function is the ONE definition every confirmation display in the app renders
// through, fed by the shared `tipHeight` rune (src/lib/live/tipHeight.svelte.ts).
//
// No I/O, no hidden state — trivially unit-testable and safe to call anywhere
// (client or server, in a reactive derived or a hot loop).

/**
 * Confirmations for a transaction included at `txBlockHeight`, given chain tip
 * `tip`. A confirmed tx in the tip block itself has 1 confirmation.
 *
 * - Unconfirmed / unknown height (null, undefined, 0, or negative) → 0.
 * - Unknown tip (0 or negative) → 0.
 * - Reorg clamp: if the tip has moved *below* the tx's height (a deep reorg),
 *   the result is clamped to 0 rather than going negative.
 */
export function confirmationsFor(txBlockHeight: number | null | undefined, tip: number): number {
	if (txBlockHeight == null || txBlockHeight <= 0) return 0;
	if (tip <= 0) return 0;
	return Math.max(0, tip - txBlockHeight + 1);
}
