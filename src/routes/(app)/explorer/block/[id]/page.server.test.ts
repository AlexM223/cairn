import { describe, it, expect, beforeEach, vi } from 'vitest';

// The explorer block-detail loader (src/routes/(app)/explorer/block/[id]/+page.server.ts)
// had zero coverage. This pins the "honest branches" the .svelte template
// derives from `data.chain` (see +page.svelte L50-58): `notFound`, `error`
// (rendered as `chainError`), and the separate top-level `coreRpcConfigured`
// flag that gates whether a chain error renders CoreRpcRequiredNotice or a
// generic error banner. ChainService is fully stubbed (no Electrum/Core
// network calls); getEpochStrip's own getChain().getTip() call is covered by
// the same mock.

const h = vi.hoisted(() => {
	const chain = {
		getBlock: vi.fn(),
		getTip: vi.fn(async () => ({ height: 800_000, hash: 'f'.repeat(64) })),
		getBlockTxs: vi.fn(async () => ({ txs: [], total: 0 }))
	};
	return { chain };
});

vi.mock('$lib/server/chain', () => ({ getChain: () => h.chain }));

import { db } from '$lib/server/db';
import { setSetting } from '$lib/server/settings';
import { load } from './+page.server';
import type { BlockDetail } from '$lib/types';

function makeBlock(over: Partial<BlockDetail> = {}): BlockDetail {
	return {
		height: 800_000,
		hash: 'a'.repeat(64),
		time: 1_700_000_000,
		txCount: 2000,
		size: 1_200_000,
		weight: 3_990_000,
		medianFee: 5,
		feeRange: [1, 50],
		total_out: 100_000_000,
		fullness: 0.998,
		prevHash: 'b'.repeat(64),
		merkleRoot: 'c'.repeat(64),
		nonce: 12345,
		bits: '17034219',
		difficulty: 90_000_000_000_000,
		version: 536_870_912,
		totalFees: 50_000_000,
		reward: 362_500_000,
		...over
	} as BlockDetail;
}

function loadEvent(id: string, search = '') {
	return {
		params: { id },
		url: new URL(`http://localhost/explorer/block/${id}${search}`),
		locals: {}
	} as unknown as Parameters<typeof load>[0];
}

/** load()'s `chain` field is a streamed promise (never awaited by SvelteKit
 *  itself); resolve it directly the way the .svelte's `$effect` does. */
async function runChain(id: string, search = '') {
	const data = (await load(loadEvent(id, search))) as unknown as {
		coreRpcConfigured: boolean;
		isAdmin: boolean;
		chain: Promise<{
			block: BlockDetail | null;
			notFound: boolean;
			error: string | null;
			txs: unknown[];
			txTotal: number;
			tipHeight: number | null;
		}>;
		strip: Promise<unknown>;
	};
	const chain = await data.chain;
	return { data, chain };
}

beforeEach(() => {
	db.exec("DELETE FROM settings; DELETE FROM instance_secrets; DELETE FROM chain_snapshot;");
	h.chain.getBlock.mockReset();
	h.chain.getTip.mockReset().mockResolvedValue({ height: 800_000, hash: 'f'.repeat(64) });
	h.chain.getBlockTxs.mockReset().mockResolvedValue({ txs: [], total: 0 });
});

describe('explorer block load() — syntactic 404 (route-level, no chain call)', () => {
	it('throws a route error(404) for an id that is neither a height nor a 64-hex hash', async () => {
		h.chain.getBlock.mockRejectedValue(new Error('should never be called'));
		await expect(load(loadEvent('not-a-valid-id'))).rejects.toBeTruthy();
		expect(h.chain.getBlock).not.toHaveBeenCalled();
	});
});

describe('explorer block load() — Core RPC unconfigured, backend throws', () => {
	it('renders the honest chainError branch (coreRpcConfigured:false drives CoreRpcRequiredNotice) and never rejects', async () => {
		// No core_rpc_url set => coreRpcConfigured() is false.
		h.chain.getBlock.mockRejectedValue(new Error('Core RPC required for block detail'));

		const { data, chain } = await runChain('800000');

		expect(data.coreRpcConfigured).toBe(false);
		expect(chain.notFound).toBe(false);
		expect(chain.error).toBe('Core RPC required for block detail');
		expect(chain.block).toBeNull();
	});
});

describe('explorer block load() — Core RPC configured, backend throws (genuine chain error)', () => {
	it('surfaces chainError with coreRpcConfigured:true (a real outage, not a "go configure Core" nudge)', async () => {
		setSetting('core_rpc_url', 'http://127.0.0.1:8332');
		h.chain.getBlock.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:8332'));

		const { data, chain } = await runChain('800000');

		expect(data.coreRpcConfigured).toBe(true);
		expect(chain.notFound).toBe(false);
		expect(chain.error).toContain('ECONNREFUSED');
		expect(chain.block).toBeNull();
	});
});

describe('explorer block load() — genuine not-found (valid syntax, no such block)', () => {
	it('sets notFound:true and error:null (distinct from a chain outage) regardless of coreRpcConfigured', async () => {
		setSetting('core_rpc_url', 'http://127.0.0.1:8332');
		h.chain.getBlock.mockRejectedValue(new Error('Block not found'));

		const { data, chain } = await runChain(String(9_999_999));

		expect(data.coreRpcConfigured).toBe(true);
		expect(chain.notFound).toBe(true);
		expect(chain.error).toBeNull();
	});
});

describe('explorer block load() — success path threads coreRpcConfigured + block data', () => {
	it('resolves block/txs/tipHeight with no error/notFound when the backend answers', async () => {
		setSetting('core_rpc_url', 'http://127.0.0.1:8332');
		h.chain.getBlock.mockResolvedValue(makeBlock());
		h.chain.getBlockTxs.mockResolvedValue({ txs: [], total: 0 });

		const { data, chain } = await runChain('800000');

		expect(data.coreRpcConfigured).toBe(true);
		expect(chain.notFound).toBe(false);
		expect(chain.error).toBeNull();
		expect(chain.block?.height).toBe(800_000);
		expect(chain.tipHeight).toBe(800_000);
	});
});

describe('explorer block load() — never-rejecting contract', () => {
	it('the streamed `chain` field never rejects even when every chain call fails', async () => {
		h.chain.getBlock.mockRejectedValue(new Error('total outage'));
		h.chain.getTip.mockRejectedValue(new Error('tip unreachable too'));
		h.chain.getBlockTxs.mockRejectedValue(new Error('unreachable'));

		const { chain } = await runChain('800000');
		expect(chain.error).toBe('total outage');
	});

	it('a getBlockTxs failure (block itself resolved) degrades txError, not a hang/reject', async () => {
		setSetting('core_rpc_url', 'http://127.0.0.1:8332');
		h.chain.getBlock.mockResolvedValue(makeBlock());
		h.chain.getBlockTxs.mockRejectedValue(new Error('tx index unavailable'));

		const data = (await load(loadEvent('800000'))) as unknown as {
			chain: Promise<{ block: BlockDetail | null; txError: string | null; error: string | null }>;
		};
		const chain = await data.chain;

		expect(chain.block).not.toBeNull();
		expect(chain.error).toBeNull();
		expect(chain.txError).toBe('tx index unavailable');
	});

	it('the `strip` field never rejects even when getTip fails', async () => {
		h.chain.getTip.mockRejectedValue(new Error('tip down'));
		h.chain.getBlock.mockResolvedValue(makeBlock());

		const data = (await load(loadEvent('800000'))) as unknown as { strip: Promise<unknown> };
		await expect(data.strip).resolves.toBeNull();
	});
});
