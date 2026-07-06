import { describe, it, expect, vi, beforeEach } from 'vitest';

// The real scans hit Electrum; mock them (and the DB enumeration + multisig
// loader) so this exercises only warmPortfolioCache's enumeration and its
// best-effort error resilience.
const mocks = vi.hoisted(() => ({
	scanWallet: vi.fn(),
	scanMultisig: vi.fn(),
	listMultisigs: vi.fn(),
	walletRows: [] as { xpub: string }[],
	userRows: [] as { id: number }[]
}));

vi.mock('./db', () => ({
	db: {
		prepare: (sql: string) => ({
			all: () =>
				sql.includes('FROM wallets')
					? mocks.walletRows
					: sql.includes('FROM users')
						? mocks.userRows
						: []
		})
	}
}));
vi.mock('./bitcoin/walletScan', () => ({ scanWallet: mocks.scanWallet }));
vi.mock('./multisigScan', () => ({ scanMultisig: mocks.scanMultisig }));
vi.mock('./wallets/multisig', () => ({ listMultisigs: mocks.listMultisigs }));

import { warmPortfolioCache } from './portfolioWarm';

beforeEach(() => {
	mocks.scanWallet.mockReset().mockResolvedValue(undefined);
	mocks.scanMultisig.mockReset().mockResolvedValue(undefined);
	mocks.listMultisigs.mockReset().mockReturnValue([]);
	mocks.walletRows = [];
	mocks.userRows = [];
});

describe('warmPortfolioCache (cairn-fd56)', () => {
	it('scans every distinct wallet xpub and every user’s multisigs', async () => {
		mocks.walletRows = [{ xpub: 'zpubA' }, { xpub: 'zpubB' }];
		mocks.userRows = [{ id: 1 }, { id: 2 }];
		mocks.listMultisigs.mockImplementation((userId: number) =>
			userId === 1 ? [{ id: 10 }, { id: 11 }] : []
		);

		await warmPortfolioCache();

		expect(mocks.scanWallet.mock.calls.map((c) => c[0])).toEqual(['zpubA', 'zpubB']);
		expect(mocks.listMultisigs.mock.calls.map((c) => c[0])).toEqual([1, 2]);
		expect(mocks.scanMultisig.mock.calls.map((c) => c[0].id)).toEqual([10, 11]);
	});

	it('keeps warming after a single wallet scan fails', async () => {
		mocks.walletRows = [{ xpub: 'bad' }, { xpub: 'good' }];
		mocks.userRows = [{ id: 1 }];
		mocks.listMultisigs.mockReturnValue([{ id: 42 }]);
		mocks.scanWallet.mockImplementation((xpub: string) =>
			xpub === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve(undefined)
		);

		await expect(warmPortfolioCache()).resolves.toBeUndefined();

		// Both wallets were attempted and the multisig pass still ran. The warm pass
		// force-refreshes so it replaces any persisted seed with a live scan (cairn-er1k).
		expect(mocks.scanWallet).toHaveBeenCalledTimes(2);
		expect(mocks.scanMultisig).toHaveBeenCalledWith({ id: 42 }, { forceRefresh: true });
	});

	it('keeps warming after listing one user’s multisigs throws', async () => {
		mocks.userRows = [{ id: 1 }, { id: 2 }];
		mocks.listMultisigs.mockImplementation((userId: number) => {
			if (userId === 1) throw new Error('db blip');
			return [{ id: 7 }];
		});

		await expect(warmPortfolioCache()).resolves.toBeUndefined();

		expect(mocks.scanMultisig.mock.calls.map((c) => c[0].id)).toEqual([7]);
	});
});
