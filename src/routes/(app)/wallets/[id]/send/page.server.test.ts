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
	// Identity by default (real classifyUnconfirmedTrust is a pass-through-plus-tag
	// function) — the cairn-oae1.3 tests below need the coinbase/height fields
	// they hand to getWalletUtxos to survive this step unmodified.
	classifyUnconfirmedTrust: vi.fn((utxos: unknown[]) => utxos)
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
import { getWalletDetail } from '$lib/server/wallets';
import { getWalletUtxos } from '$lib/server/transactions';
import { getChain } from '$lib/server/chain';
import type { SendLiveData } from './+page.server';
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

// cairn-oae1.3: the send eyebrow's `confirmed`/`maturingTotal` split. Electrum's
// raw confirmed balance counts an immature coinbase output as spendable, but
// the build engine (psbt.ts's selectSpendCandidates) refuses it — the eyebrow
// and max-amount client validation must agree with the engine, not Electrum.
describe('wallets/[id]/send load — live.confirmed/maturingTotal (cairn-oae1.3)', () => {
	function mockTip(height: number): void {
		vi.mocked(getChain).mockReturnValue({
			getFeeEstimates: vi.fn(async () => null),
			getTip: vi.fn(async () => ({ height }))
		} as unknown as ReturnType<typeof getChain>);
	}

	it('a wallet with no coinbase is unaffected: confirmed passes through, maturingTotal is 0', async () => {
		vi.mocked(getWalletDetail).mockResolvedValue({
			scan: { confirmed: 500_000, unconfirmed: 0 }
		} as unknown as Awaited<ReturnType<typeof getWalletDetail>>);
		vi.mocked(getWalletUtxos).mockResolvedValue([
			{ txid: 'a'.repeat(64), vout: 0, value: 500_000, height: 800_000, coinbase: false }
		] as unknown as Awaited<ReturnType<typeof getWalletUtxos>>);
		mockTip(900_050);

		const result = await load(makeEvent(undefined));
		const live = (await (result as { live: Promise<SendLiveData> }).live)!;
		expect(live.confirmed).toBe(500_000);
		expect(live.maturingTotal).toBe(0);
	});

	it('an IMMATURE coinbase coin is subtracted out of confirmed and reported as maturingTotal', async () => {
		vi.mocked(getWalletDetail).mockResolvedValue({
			// Electrum counts the immature coinbase as confirmed — this is the bug.
			scan: { confirmed: 5_000_000_000, unconfirmed: 0 }
		} as unknown as Awaited<ReturnType<typeof getWalletDetail>>);
		vi.mocked(getWalletUtxos).mockResolvedValue([
			{
				txid: 'b'.repeat(64),
				vout: 0,
				value: 5_000_000_000,
				height: 900_000, // 51 confs at tip 900_050 — immature
				coinbase: true
			}
		] as unknown as Awaited<ReturnType<typeof getWalletUtxos>>);
		mockTip(900_050);

		const result = await load(makeEvent(undefined));
		const live = (await (result as { live: Promise<SendLiveData> }).live)!;
		expect(live.confirmed).toBe(0);
		expect(live.maturingTotal).toBe(5_000_000_000);
	});

	it('a MATURE coinbase coin (100+ confs) is left in confirmed; maturingTotal is 0', async () => {
		vi.mocked(getWalletDetail).mockResolvedValue({
			scan: { confirmed: 5_000_000_000, unconfirmed: 0 }
		} as unknown as Awaited<ReturnType<typeof getWalletDetail>>);
		vi.mocked(getWalletUtxos).mockResolvedValue([
			{
				txid: 'c'.repeat(64),
				vout: 0,
				value: 5_000_000_000,
				height: 800_000, // 100_051 confs at tip 900_050 — mature
				coinbase: true
			}
		] as unknown as Awaited<ReturnType<typeof getWalletUtxos>>);
		mockTip(900_050);

		const result = await load(makeEvent(undefined));
		const live = (await (result as { live: Promise<SendLiveData> }).live)!;
		expect(live.confirmed).toBe(5_000_000_000);
		expect(live.maturingTotal).toBe(0);
	});
});
