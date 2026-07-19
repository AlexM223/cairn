// Stub for '$app/state' in the jsdom vitest project (component mount tests,
// e.g. cairn-bm7c2's MiningConnectionCard.dom.test.ts). SvelteKit's real
// module isn't resolvable outside a SvelteKit build context — mirrors
// `page.url` / `page.data` are read directly (not via runes) here, which is
// enough for tests that mutate this object BEFORE mounting a fresh component
// instance; it is not reactive across an already-mounted component the way
// the real $app/state store is.
export const page = {
	url: new URL('http://localhost/mining'),
	data: {} as Record<string, unknown>
};
