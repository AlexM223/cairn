// Chain-depth warning logic (cairn-u9ob.5). getCpfpInfo is mocked at the chain
// edge so the ancestor/descendant counting and threshold are testable without a
// network or a real mempool.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getCpfpInfoMock } = vi.hoisted(() => ({ getCpfpInfoMock: vi.fn() }));

vi.mock('./chain', () => ({
	getChain: () => ({ getCpfpInfo: getCpfpInfoMock })
}));

import {
	checkUnconfirmedChainDepth,
	checkSelectedInputsChainDepth,
	LEGACY_ANCESTOR_LIMIT
} from './chainDepth';

const TXID = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

/** A CpfpInfo with `n` ancestors and `m` descendants (txids don't matter here). */
function cpfp(n: number, m: number) {
	return {
		effectiveFeeRate: 2,
		ancestors: Array.from({ length: n }, (_, i) => `anc${i}`),
		descendants: Array.from({ length: m }, (_, i) => `desc${i}`)
	};
}

beforeEach(() => getCpfpInfoMock.mockReset());

describe('checkUnconfirmedChainDepth', () => {
	it('returns null when the chain is short', async () => {
		getCpfpInfoMock.mockResolvedValue(cpfp(2, 0));
		expect(await checkUnconfirmedChainDepth([TXID])).toBeNull();
	});

	it('warns when the ancestor count is within the margin of the limit', async () => {
		// 22 ancestors + the tx itself = 23, within 3 of the 25 cap.
		getCpfpInfoMock.mockResolvedValue(cpfp(22, 0));
		const w = await checkUnconfirmedChainDepth([TXID]);
		expect(w).not.toBeNull();
		expect(w!.kind).toBe('ancestors');
		expect(w!.count).toBe(23);
		expect(w!.limit).toBe(LEGACY_ANCESTOR_LIMIT);
		expect(w!.message).toMatch(/unconfirmed transactions/i);
	});

	it('warns on a deep descendant chain too', async () => {
		getCpfpInfoMock.mockResolvedValue(cpfp(0, 24));
		const w = await checkUnconfirmedChainDepth([TXID]);
		expect(w!.kind).toBe('descendants');
		expect(w!.count).toBe(25);
	});

	it('degrades silently (null) when the backend has no v1 CPFP data', async () => {
		getCpfpInfoMock.mockResolvedValue(null);
		expect(await checkUnconfirmedChainDepth([TXID])).toBeNull();
	});

	it('never throws on a lookup failure — skips that txid', async () => {
		getCpfpInfoMock.mockRejectedValueOnce(new Error('esplora down')).mockResolvedValue(null);
		expect(await checkUnconfirmedChainDepth([TXID])).toBeNull();
	});

	it('returns the worst (highest-count) warning across several txids', async () => {
		getCpfpInfoMock.mockImplementation((txid: string) =>
			Promise.resolve(txid === TXID ? cpfp(22, 0) : cpfp(24, 0))
		);
		const w = await checkUnconfirmedChainDepth([TXID, OTHER]);
		expect(w!.count).toBe(25); // OTHER's 24+1, deeper than TXID's 23
	});

	it('deduplicates repeated txids (one lookup)', async () => {
		getCpfpInfoMock.mockResolvedValue(cpfp(1, 1));
		await checkUnconfirmedChainDepth([TXID, TXID, TXID.toUpperCase()]);
		expect(getCpfpInfoMock).toHaveBeenCalledTimes(1);
	});
});

describe('checkSelectedInputsChainDepth', () => {
	const utxos = [
		{ txid: TXID, vout: 0, height: 0 }, // unconfirmed
		{ txid: OTHER, vout: 1, height: 800_000 } // confirmed
	];

	it('checks only the unconfirmed selected inputs (no network for all-confirmed)', async () => {
		getCpfpInfoMock.mockResolvedValue(cpfp(0, 0));
		// Selecting only the confirmed coin → no lookup at all.
		const w = await checkSelectedInputsChainDepth([{ txid: OTHER, vout: 1 }], utxos);
		expect(w).toBeNull();
		expect(getCpfpInfoMock).not.toHaveBeenCalled();
	});

	it('checks the unconfirmed input when one is selected', async () => {
		getCpfpInfoMock.mockResolvedValue(cpfp(23, 0));
		const w = await checkSelectedInputsChainDepth([{ txid: TXID, vout: 0 }], utxos);
		expect(w).not.toBeNull();
		expect(getCpfpInfoMock).toHaveBeenCalledWith(TXID);
	});
});
