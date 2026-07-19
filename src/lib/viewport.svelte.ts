// Shared viewport breakpoint — the shell's single 900px seam (HWSidebar /
// MobileTopBar / MobileTabRow all switch here). Drives aria-hidden on whichever
// nav chrome the current breakpoint hides with CSS: display:none already drops
// it from the accessibility tree in real browsers, but the explicit aria-hidden
// makes the exposure contract robust and inspectable (a11y snapshots, crawlers,
// any future CSS drift) — exactly one exposed <nav> landmark per breakpoint
// (UX-REDESIGN-SPEC.md §2.7, cairn-gt05.4).
//
// SSR renders the desktop verdict (isMobile = false); hydration corrects the
// attribute before any assistive tech can interact. Module-scope $state with
// eager init keeps reads pure (no state writes during render).

export const MOBILE_SHELL_QUERY = '(max-width: 900px)';

let isMobile = $state(false);

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
	const mq = window.matchMedia(MOBILE_SHELL_QUERY);
	isMobile = mq.matches;
	mq.addEventListener('change', (e) => {
		isMobile = e.matches;
	});
}

export const viewport = {
	/** True at/below the 900px shell breakpoint. Always false during SSR. */
	get isMobile(): boolean {
		return isMobile;
	}
};
