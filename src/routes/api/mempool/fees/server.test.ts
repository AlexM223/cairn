// cairn-wb63 — /api/mempool/fees was returning the raw Electrum error string
// (e.g. "Electrum connection closed (electrum.blockstream.info:50002)")
// verbatim in its JSON error field, leaking backend host:port to any
// authenticated user. This pins the sanitizeChainError boundary: a
// connectivity-class failure collapses to the stable plain-language message,
// while a non-connectivity error's own text still passes through unchanged.

import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ getFeeEstimates: vi.fn() }));

vi.mock('$lib/server/chain', () => ({ getChain: () => h }));

import { GET } from './+server';
import { DEFAULT_CHAIN_ERROR_MESSAGE } from '$lib/server/chainErrors';

function event() {
	return {
		locals: { user: { id: 1, email: 'x@example.com', isAdmin: false } }
	} as unknown as Parameters<typeof GET>[0];
}

describe('/api/mempool/fees error sanitization (cairn-wb63)', () => {
	it('collapses a connectivity-class error to the sanitized message, never the raw host:port', async () => {
		h.getFeeEstimates.mockRejectedValueOnce(
			new Error('Electrum connection closed (electrum.blockstream.info:50002)')
		);
		const res = await GET(event());
		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body.error).toBe(DEFAULT_CHAIN_ERROR_MESSAGE);
		expect(body.error).not.toContain('electrum.blockstream.info');
		expect(body.error).not.toContain('50002');
	});

	it('passes a non-connectivity error message through unchanged', async () => {
		h.getFeeEstimates.mockRejectedValueOnce(new Error('Mempool fees require a synced backend'));
		const res = await GET(event());
		expect(res.status).toBe(502);
		const body = await res.json();
		expect(body.error).toBe('Mempool fees require a synced backend');
	});

	it('returns fee estimates on success', async () => {
		h.getFeeEstimates.mockResolvedValueOnce({ fast: 20, medium: 10, slow: 2 });
		const res = await GET(event());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ fast: 20, medium: 10, slow: 2 });
	});
});
