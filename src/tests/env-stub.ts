// Test stand-in for SvelteKit's `$env/dynamic/private` (aliased in vitest.config.ts).
export const env = process.env as Record<string, string | undefined>;
