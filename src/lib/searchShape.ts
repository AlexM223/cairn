// Shared shape-detection for Explorer search queries (cairn-ioeg5).
//
// Kept out of $lib/server so the search UI (ExplorerSearch.svelte, the
// Explorer index's inline search form) can import it directly — SvelteKit
// refuses to bundle anything under $lib/server into client code.
// src/lib/server/search.ts imports these same regexes so routing decisions
// and the UI's "is this a complete candidate" check never drift apart.

/** A plain block-height candidate: 1-9 digits. */
export const HEIGHT_RE = /^\d{1,9}$/;

/** A 64-hex-char candidate: block hash or txid. */
export const HEX64_RE = /^[0-9a-fA-F]{64}$/;

/**
 * True once `q` is shaped like a *complete* search candidate (a full height
 * or a full 64-hex hash/txid) — the point past which a backend
 * `{ type: 'unknown' }` response means "looked and found nothing" rather than
 * "not a full candidate yet, keep typing".
 *
 * Used to distinguish the Explorer search bar's live-suggestion "keep
 * typing" hint (still-incomplete input) from an honest "not found" state
 * (complete input the backend definitively couldn't resolve) — see
 * cairn-ioeg5. Address candidates aren't covered: classifySearch() resolves
 * those purely syntactically, so a valid address is never `unknown`.
 */
export function isCompleteSearchCandidate(q: string): boolean {
	const query = q.trim();
	return HEIGHT_RE.test(query) || HEX64_RE.test(query);
}
