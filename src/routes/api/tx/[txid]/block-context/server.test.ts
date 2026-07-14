// GET /api/tx/[txid]/block-context (docs/TX-BLOCK-CONTEXT-DESIGN.md §3). The endpoint
// is a thin auth + validation wrapper over ChainService.getTxBlockContext (which never
// throws), so these tests pin the wrapper contract: 401 unauthenticated, 404 on a
// malformed txid, and a 200 pass-through of the BlockContext (incl. richness:'none').

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockContext } from '$lib/types';

const getTxBlockContext = vi.fn<(txid: string) => Promise<BlockContext>>();

vi.mock('$lib/server/chain', () => ({
	getChain: () => ({ getTxBlockContext })
}));

import { GET } from './+server';

const VALID_TXID = 'a'.repeat(64);

function event(txid: string, authed = true): Parameters<typeof GET>[0] {
	return {
		locals: { user: authed ? { id: 1, email: 'u@x', displayName: 'u', isAdmin: false } : null },
		params: { txid },
		request: new Request(`http://localhost/api/tx/${txid}/block-context`)
	} as unknown as Parameters<typeof GET>[0];
}

function fullCtx(over: Partial<BlockContext> = {}): BlockContext {
	return {
		richness: 'basic',
		confirmed: true,
		height: 100,
		confirmations: 3,
		tipHeight: 102,
		position: 1,
		positionTotal: 4,
		positionEstimated: true,
		neighbors: [],
		vsize: 141,
		fee: null,
		feeRate: null,
		coreConfigured: false,
		...over
	};
}

beforeEach(() => {
	getTxBlockContext.mockReset();
});

describe('GET /api/tx/[txid]/block-context', () => {
	it('401 when unauthenticated (never reaches the chain)', async () => {
		// requireUser throws an HttpError (SvelteKit catches it into a 401 response)
		// rather than returning — so the chain is never touched.
		await expect(GET(event(VALID_TXID, false))).rejects.toMatchObject({ status: 401 });
		expect(getTxBlockContext).not.toHaveBeenCalled();
	});

	it('404 on a malformed txid without calling the chain', async () => {
		const res = await GET(event('not-a-txid'));
		expect(res.status).toBe(404);
		expect(getTxBlockContext).not.toHaveBeenCalled();
	});

	it('200 passes the BlockContext through, lowercasing the txid', async () => {
		const ctx = fullCtx({ richness: 'full', height: 948_197 });
		getTxBlockContext.mockResolvedValue(ctx);

		const res = await GET(event('A'.repeat(64)));
		expect(res.status).toBe(200);
		expect(getTxBlockContext).toHaveBeenCalledWith('a'.repeat(64));
		expect(await res.json()).toEqual(ctx);
	});

	it('200 with richness "none" surfaces the honest connecting state (never an error)', async () => {
		getTxBlockContext.mockResolvedValue(
			fullCtx({ richness: 'none', confirmed: false, height: null, confirmations: null, tipHeight: null })
		);

		const res = await GET(event(VALID_TXID));
		expect(res.status).toBe(200);
		expect((await res.json()).richness).toBe('none');
	});
});
