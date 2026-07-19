// Stub for '$app/forms' in the jsdom vitest project (component mount tests).
// `enhance` is a Svelte action (`use:enhance`); components under test never
// actually submit the enhanced form in these tests, so a no-op action that
// satisfies the `use:` directive contract is enough.
export function enhance(_node: HTMLFormElement, _submit?: unknown): { destroy(): void } {
	return { destroy() {} };
}
