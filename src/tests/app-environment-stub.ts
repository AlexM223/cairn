// Stub for '$app/environment' in the jsdom vitest project (cairn-et5a0 mount
// test). SvelteKit's real module isn't resolvable outside a SvelteKit build
// context; this mirrors its shape with `browser: true` so client-only stores
// like $lib/price (subscribed to indirectly via Amount.svelte) behave as they
// would in an actual browser tab rather than during SSR.
export const browser = true;
export const dev = false;
export const building = false;
export const version = 'test';
