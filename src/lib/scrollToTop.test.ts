import { describe, it, expect, vi, afterEach } from 'vitest';
import { scrollToTop } from './scrollToTop';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('scrollToTop', () => {
	it('is a no-op (and never throws) when there is no window — SSR safety', () => {
		// The test environment has no DOM globals by default, same as SSR.
		expect(typeof window).toBe('undefined');
		expect(() => scrollToTop()).not.toThrow();
	});

	it('scrolls the window to the top instantly (no smooth-scroll)', () => {
		const scrollTo = vi.fn();
		vi.stubGlobal('window', { scrollTo });
		scrollToTop();
		expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });
	});

	it('also scrolls a given scrolling container to the top', () => {
		vi.stubGlobal('window', { scrollTo: vi.fn() });
		const containerScrollTo = vi.fn();
		const container = { scrollTo: containerScrollTo } as unknown as Element;
		scrollToTop(container);
		expect(containerScrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });
	});

	it('tolerates a container missing scrollTo (defensive optional-chain)', () => {
		vi.stubGlobal('window', { scrollTo: vi.fn() });
		expect(() => scrollToTop({} as Element)).not.toThrow();
	});

	it('skips the container entirely when none is passed', () => {
		const windowScrollTo = vi.fn();
		vi.stubGlobal('window', { scrollTo: windowScrollTo });
		expect(() => scrollToTop(null)).not.toThrow();
		expect(windowScrollTo).toHaveBeenCalledTimes(1);
	});
});
