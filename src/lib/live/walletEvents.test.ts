// Debounce behavior for the client-side wallet-frame invalidator
// (docs/LIVE-UPDATES-DESIGN.md §4.2, §8). The load-bearing property: a burst of
// `wallet` frames (one block touching many of a wallet's addresses) collapses
// into ONE reload, fired on the trailing edge ~800ms after the last frame.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { debounced, WALLET_DEBOUNCE_MS } from './walletEvents';

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('debounced (wallet-frame invalidation coalescing, §4.2)', () => {
	it('collapses N calls within the window into a single trailing invocation', () => {
		const fn = vi.fn();
		const kick = debounced(fn, WALLET_DEBOUNCE_MS);

		// Five frames in a tight burst, each well under the debounce window.
		for (let i = 0; i < 5; i++) {
			kick();
			vi.advanceTimersByTime(100);
		}
		// Still within the window since the last call — nothing has fired yet.
		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(WALLET_DEBOUNCE_MS);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('fires again for a second burst after the window elapses', () => {
		const fn = vi.fn();
		const kick = debounced(fn, WALLET_DEBOUNCE_MS);

		kick();
		vi.advanceTimersByTime(WALLET_DEBOUNCE_MS);
		expect(fn).toHaveBeenCalledTimes(1);

		// A later, separate event → a second, independent invocation.
		kick();
		vi.advanceTimersByTime(WALLET_DEBOUNCE_MS);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('cancel() drops a pending trailing call', () => {
		const fn = vi.fn();
		const kick = debounced(fn, WALLET_DEBOUNCE_MS);

		kick();
		kick.cancel();
		vi.advanceTimersByTime(WALLET_DEBOUNCE_MS * 2);
		expect(fn).not.toHaveBeenCalled();
	});

	it('defaults to the ~800ms window', () => {
		expect(WALLET_DEBOUNCE_MS).toBe(800);
		const fn = vi.fn();
		const kick = debounced(fn);
		kick();
		vi.advanceTimersByTime(799);
		expect(fn).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(fn).toHaveBeenCalledTimes(1);
	});
});
