// Task 4 (batch-request audit): getWalletUtxos must fetch every candidate
// address's UTXOs in ONE batched Electrum call (client.batchRequest), NOT one
// blockchain.scripthash.listunspent round-trip per address. These tests mock the
// chain + scan so the assertion is purely "one batched call vs N individual
// calls" and that the caller's `lane` is threaded through to the pool.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (declared before importing the module under test) ----------------
// vi.hoisted so these spies exist when the (hoisted) vi.mock factories run.
const { batchRequest, listUnspent, scanWallet } = vi.hoisted(() => ({
	batchRequest: vi.fn(),
	listUnspent: vi.fn(),
	scanWallet: vi.fn()
}));
vi.mock('./chain', () => ({ getChain: () => ({ electrum: { batchRequest, listUnspent } }) }));
vi.mock('./bitcoin/walletScan', () => ({
	scanWallet,
	findNextUnusedIndex: vi.fn()
}));
// Identity annotate — keep the coinbase pass out of the way (it would otherwise
// call getChain().getTx for each distinct funding tx).
vi.mock('./bitcoin/coinbaseScan', () => ({
	annotateCoinbase: (utxos: unknown[]) => utxos
}));
// Stub the scripthash derivation so the fake addresses don't have to be real
// bech32; the value only has to be stable per address.
vi.mock('./bitcoin/xpub', async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	return { ...actual, addressToScripthash: (a: string) => `sh:${a}` };
});

import { getWalletUtxos } from './transactions';

const THREE_USED_ADDRS = {
	addresses: [
		{ address: 'a0', used: true, balance: 0, change: false, index: 0 },
		{ address: 'a1', used: true, balance: 0, change: false, index: 1 },
		{ address: 'a2', used: true, balance: 0, change: true, index: 0 }
	],
	txs: [],
	confirmed: 0,
	unconfirmed: 0
};

describe('getWalletUtxos — real batching (task 4)', () => {
	beforeEach(() => {
		batchRequest.mockReset();
		listUnspent.mockReset();
		scanWallet.mockReset();
	});

	it('issues ONE batched listunspent call for all candidate addresses, not N', async () => {
		scanWallet.mockResolvedValue(THREE_USED_ADDRS);
		// One UTXO on the first address, none on the others.
		batchRequest.mockResolvedValue([
			[{ tx_hash: 'txA', tx_pos: 0, value: 1000, height: 100 }],
			[],
			[]
		]);

		const utxos = await getWalletUtxos('xpub-under-test');

		// The crux: exactly one wire call carrying all 3 sub-requests, and the
		// per-address facade method never used.
		expect(batchRequest).toHaveBeenCalledTimes(1);
		expect(listUnspent).not.toHaveBeenCalled();

		const [items, lane] = batchRequest.mock.calls[0];
		expect(items).toHaveLength(3);
		expect(items.every((i: { method: string }) => i.method === 'blockchain.scripthash.listunspent')).toBe(
			true
		);
		expect(items.map((i: { params: string[] }) => i.params[0])).toEqual(['sh:a0', 'sh:a1', 'sh:a2']);
		// Default lane is interactive (send-flow caller).
		expect(lane).toBe('interactive');

		// Response order is preserved → the single UTXO maps back to address a0.
		expect(utxos).toHaveLength(1);
		expect(utxos[0]).toMatchObject({ txid: 'txA', vout: 0, value: 1000, address: 'a0', index: 0 });
	});

	it('threads the caller lane through to scan + batchRequest', async () => {
		scanWallet.mockResolvedValue(THREE_USED_ADDRS);
		batchRequest.mockResolvedValue([[], [], []]);

		await getWalletUtxos('xpub-bg', 'background');

		expect(scanWallet).toHaveBeenCalledWith('xpub-bg', { lane: 'background' });
		expect(batchRequest.mock.calls[0][1]).toBe('background');
	});

	it('skips Electrum entirely when there are no candidate addresses', async () => {
		scanWallet.mockResolvedValue({ addresses: [], txs: [], confirmed: 0, unconfirmed: 0 });

		const utxos = await getWalletUtxos('xpub-empty');

		expect(utxos).toEqual([]);
		expect(batchRequest).not.toHaveBeenCalled();
		expect(listUnspent).not.toHaveBeenCalled();
	});
});
