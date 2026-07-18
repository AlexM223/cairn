// Pure copy helper for the confirmation label paired with the BurialRings
// glyph. Kept in a plain .ts module (mirroring blockContext.ts) so it's
// unit-testable without going through the Svelte compiler — this project's
// vitest config doesn't run the svelte vite-plugin, so exports from a
// `<script module>` block inside a .svelte file can't be imported directly
// in tests.
//
// Plain-language confirmation copy — no burial-ring jargon in user-facing
// text (cairn-0ifm). The BurialRings glyph itself still draws the ring
// visual; only the accompanying label text is plain: 0 → "unconfirmed" ·
// 1–5 → "N confirmation(s)" · 6+ → "6+ confirmations".
export function burialRingsLabel(confirmations: number): string {
	if (confirmations <= 0) return 'unconfirmed';
	if (confirmations >= 6) return '6+ confirmations';
	return `${confirmations} confirmation${confirmations === 1 ? '' : 's'}`;
}

/**
 * Explicit confirmation-count text to pair with {@link burialRingsLabel} on
 * surfaces that want the literal tally, not just the plain-language label —
 * e.g. the explorer tx-detail page (cairn-cqch), which showed the burial-ring
 * label for an unconfirmed/confirming tx but no explicit confirmation count.
 * No hardcoded "of 6" denominator (cairn-fadz) — 6 is an internal "fully
 * buried" threshold, not a promise made to the user about how confirmations
 * work. Six is still the point Cairn treats a transaction as fully buried
 * (the BurialRings glyph caps its ring count there too, and the label above
 * already says "6+ confirmations"), so this has nothing further to add once
 * `confirmations` reaches 6 — returns null rather than printing a count a
 * user would have to double-check against the label right next to it.
 * Negative input (shouldn't happen) clamps to 0, matching the label's own
 * `<= 0` handling.
 */
export function confirmationProgress(confirmations: number): string | null {
	if (confirmations >= 6) return null;
	const n = Math.max(confirmations, 0);
	return `${n} confirmation${n === 1 ? '' : 's'}`;
}
