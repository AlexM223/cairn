// cachedNavBundle (cairn-t72a) — TTL cache wrapping the (app) layout's
// per-user nav-chrome bundle (unbacked wallets / backup reminder /
// announcements). Pins the cache-hit, per-key isolation, TTL-expiry, and
// reset behavior so a refactor can't quietly turn this back into three
// synchronous SQLite reads on every navigation.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cachedNavBundle, resetNavBundleCacheForTests, type NavBundle } from './navBundleCache';

function bundle(tag: string): NavBundle {
	return {
		unbackedWallets: [],
		showBackupReminder: false,
		announcements: [{ tag } as unknown as NavBundle['announcements'][number]]
	};
}

describe('cachedNavBundle', () => {
	beforeEach(() => {
		resetNavBundleCacheForTests();
	});

	it('invokes the loader on the first call for a userId and returns its value', () => {
		const load = vi.fn(() => bundle('first'));
		const result = cachedNavBundle(1, load);
		expect(load).toHaveBeenCalledTimes(1);
		expect(result).toEqual(bundle('first'));
	});

	it('returns the cached value without re-invoking the loader within the TTL', () => {
		const load = vi.fn(() => bundle('warm'));
		cachedNavBundle(1, load);
		const second = cachedNavBundle(1, load);
		expect(load).toHaveBeenCalledTimes(1);
		expect(second).toEqual(bundle('warm'));
	});

	it('gives a different userId its own independent cache entry', () => {
		const loadA = vi.fn(() => bundle('userA'));
		const loadB = vi.fn(() => bundle('userB'));
		cachedNavBundle(1, loadA);
		const resultB = cachedNavBundle(2, loadB);
		expect(loadA).toHaveBeenCalledTimes(1);
		expect(loadB).toHaveBeenCalledTimes(1);
		expect(resultB).toEqual(bundle('userB'));
	});

	it('re-invokes the loader once the TTL has elapsed', () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(0);
			const load = vi.fn(() => bundle('stale-check'));
			cachedNavBundle(1, load);
			expect(load).toHaveBeenCalledTimes(1);

			// Still within the 15s TTL.
			vi.setSystemTime(14_999);
			cachedNavBundle(1, load);
			expect(load).toHaveBeenCalledTimes(1);

			// TTL elapsed.
			vi.setSystemTime(15_001);
			const fresh = cachedNavBundle(1, load);
			expect(load).toHaveBeenCalledTimes(2);
			expect(fresh).toEqual(bundle('stale-check'));
		} finally {
			vi.useRealTimers();
		}
	});

	it('resetNavBundleCacheForTests clears every entry', () => {
		const load = vi.fn(() => bundle('reset-check'));
		cachedNavBundle(1, load);
		expect(load).toHaveBeenCalledTimes(1);

		resetNavBundleCacheForTests();

		cachedNavBundle(1, load);
		expect(load).toHaveBeenCalledTimes(2);
	});
});
