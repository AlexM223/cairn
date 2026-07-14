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
