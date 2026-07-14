// Regression test for cairn-de7e: with the address_book flag off,
// GET /api/address-book already 403s server-side, but this load() handed
// listSavedAddresses(...) to the client regardless — the RecipientCombobox
// kept showing the saved-address autocomplete because the data was just
// there. load() now withholds the list entirely when locals.flags.address_book
// is false, matching the API's own gate.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/api', () => ({ requireFeature: vi.fn() }));
vi.mock('$lib/server/wallets', () => ({
	getWallet: vi.fn(() => ({
		id: 1,
		xpub: 'xpub-stub',
		name: 'Test wallet',
		script_type: 'p2wpkh',
		device_type: null
	})),
	getWalletDetail: vi.fn(async () => null)
}));
vi.mock('$lib/server/addressBook', () => ({ listSavedAddresses: vi.fn(() => [{ id: 1 }]) }));
vi.mock('$lib/server/transactions', () => ({
	getTransaction: vi.fn(),
	getWalletUtxos: vi.fn(async () => []),
	ownBroadcastTxids: vi.fn(() => new Set()),
	classifyUnconfirmedTrust: vi.fn(() => [])
}));
vi.mock('$lib/server/bitcoin/psbt', () => ({ summarizePsbt: vi.fn() }));
vi.mock('$lib/server/referrals', () => ({ getReferralBuyUrls: vi.fn(() => null) }));
vi.mock('$lib/server/chain', () => ({
	getChain: vi.fn(() => ({
		getFeeEstimates: vi.fn(async () => null),
		getTip: vi.fn(async () => ({ height: 0 }))
	}))
}));

import { listSavedAddresses } from '$lib/server/addressBook';
import { load } from './+page.server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(flags: Record<string, boolean> | undefined): any {
	return {
		params: { id: '1' },
		locals: { user: { id: 1 }, flags },
		url: new URL('http://localhost/wallets/1/send'),
		depends: vi.fn()
	};
}

beforeEach(() => vi.clearAllMocks());

type LoadResult = { savedAddresses: unknown[] };

describe('wallets/[id]/send load — savedAddresses gated on the address_book flag', () => {
	it('returns the saved address list when the flag is on (default/undefined)', async () => {
		const result = (await load(makeEvent(undefined))) as LoadResult;
		expect(result.savedAddresses).toEqual([{ id: 1 }]);
		expect(listSavedAddresses).toHaveBeenCalledWith(1);
	});

	it('returns the saved address list when the flag is explicitly true', async () => {
		const result = (await load(makeEvent({ address_book: true }))) as LoadResult;
		expect(result.savedAddresses).toEqual([{ id: 1 }]);
	});

	it('withholds the saved address list when the flag is off, without calling listSavedAddresses', async () => {
		const result = (await load(makeEvent({ address_book: false }))) as LoadResult;
		expect(result.savedAddresses).toEqual([]);
		expect(listSavedAddresses).not.toHaveBeenCalled();
	});
});
