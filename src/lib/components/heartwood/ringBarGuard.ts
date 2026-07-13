// RingBar's fullness render guard, extracted to a pure module so the hardening
// in cairn-6efi.11 is unit-testable (RingBar.svelte itself has no component-test
// harness in this project — see blockTitle.ts/blockDepth.ts for the same
// extract-for-testability pattern used elsewhere in the explorer).
//
// Cardinal rule: a block's fullness is a VALUE (a width), not decoration, and
// absence must read as absence — never a false empty/zero bar. A strict
// `=== null` check let `undefined` (a missing key on an imperfect/synthetic
// snapshot) and non-finite values slip through and render as a bogus 0% bar.

/** True when `fullness` is a real, drawable value (not null/undefined/NaN/<=0). */
export function ringBarVisible(fullness: number | null | undefined): boolean {
	return fullness != null && Number.isFinite(fullness) && fullness > 0;
}

/** 0..100 integer fill percentage, clamped, or 0 when fullness isn't drawable. */
export function ringBarPct(fullness: number | null | undefined): number {
	if (!ringBarVisible(fullness)) return 0;
	return Math.round(Math.min(1, Math.max(0, fullness as number)) * 100);
}
