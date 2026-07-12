/**
 * Scroll to the top of the page on a wizard step transition (#26 — advancing
 * a step used to leave the viewport scrolled down, hiding the new step's
 * top; the same is true stepping back).
 *
 * Always instant (`behavior: 'auto'`) rather than smooth-scrolling: it's the
 * correct behavior under `prefers-reduced-motion` and, for a step change that
 * swaps the whole panel of content, the safer default regardless — a smooth
 * scroll racing the outgoing/incoming content swap reads as janky.
 *
 * Every wizard in this app renders inside the normal document flow — the app
 * shell's content column (`.main` in the (app) layout) has no scrolling
 * container of its own, so `window` owns the scroll position. If a wizard's
 * content ever moves inside its own scrolling container, pass that element as
 * `container` and it's scrolled to the top too.
 */
export function scrollToTop(container?: Element | null): void {
	if (typeof window !== 'undefined') {
		window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
	}
	container?.scrollTo?.({ top: 0, left: 0, behavior: 'auto' });
}
