// cairn-he4e / cairn-hwta: /api/search is the actual enforcement boundary for
// the whole explorer UI (mirrors src/routes/(app)/explorer/+layout.server.ts's
// requireFeature('explorer') gate) AND fans out to real chain RPC
// (classifySearch → getTip/getTx/getBlock), so it needs the same rate limit
// the contacts/auth endpoints already use (rateLimit.ts) to stop an
// authenticated loop from exhausting the shared Electrum/Core connection pool.
//
// Properties under test:
//   - explorer flag OFF (global or per-user) → 403, classifySearch never runs.
//   - explorer flag ON → 200 with the classifier's result.
//   - under the per-user search limit → still 200.
//   - at/over the per-user search limit → 429 rate_limited, classifySearch
//     never runs for the request that trips it.
//
// Each test uses a fresh unique user id + client IP so the module-level
// rateLimit.ts buckets (not reset between tests in this file) can't couple
// cases together — same convention as the auth endpoint tests.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

const h = vi.hoisted(() => ({ classifySearch: vi.fn() }));
vi.mock('$lib/server/search', () => ({ classifySearch: h.classifySearch }));

import { GET } from './+server';
import { noteSearchRequest } from '$lib/server/rateLimit';

let seq = 0;

function makeEvent(overrides: {
	flags?: Record<string, boolean>;
	userId?: number;
	ip?: string;
	q?: string;
} = {}) {
	const ip = overrides.ip ?? `10.1.0.${++seq}`;
	const userId = overrides.userId ?? ++seq;
	const url = new URL(`http://localhost/api/search?q=${encodeURIComponent(overrides.q ?? 'abc')}`);
	return {
		event: {
			request: new Request(url),
			url,
			locals: {
				user: { id: userId, email: `u${userId}@x.com`, displayName: 'U', isAdmin: false },
				flags: { explorer: true, ...overrides.flags }
			},
			getClientAddress: () => ip
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any,
		ip,
		userId
	};
}

beforeEach(() => {
	h.classifySearch.mockReset();
	h.classifySearch.mockResolvedValue({ type: 'unknown', redirect: null, query: 'abc' });
});

describe('GET /api/search — explorer feature gate (cairn-he4e)', () => {
	it('403s when the explorer flag is off, and never runs the classifier', async () => {
		const { event } = makeEvent({ flags: { explorer: false } });

		let caught: unknown;
		try {
			await GET(event);
		} catch (e) {
			caught = e;
		}

		expect(isHttpError(caught)).toBe(true);
		const err = caught as { status: number; body: { error?: string } };
		expect(err.status).toBe(403);
		expect(h.classifySearch).not.toHaveBeenCalled();
	});

	it('runs the search and returns 200 when the explorer flag is on', async () => {
		const { event } = makeEvent({ flags: { explorer: true }, q: 'a'.repeat(64) });
		h.classifySearch.mockResolvedValue({ type: 'tx', redirect: `/explorer/tx/${'a'.repeat(64)}`, query: 'a'.repeat(64) });

		const res = await GET(event);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.type).toBe('tx');
		expect(h.classifySearch).toHaveBeenCalledWith('a'.repeat(64));
	});
});

describe('GET /api/search — rate limiting (cairn-hwta)', () => {
	it('stays under the limit for ordinary interactive use', async () => {
		const { event } = makeEvent();

		for (let i = 0; i < 5; i++) {
			const res = await GET(event);
			expect(res.status).toBe(200);
		}
		expect(h.classifySearch).toHaveBeenCalledTimes(5);
	});

	it('429s once the per-user search limit is hit, without running the classifier', async () => {
		const { event, ip, userId } = makeEvent();
		// Prime the bucket directly to the limit (SEARCH_LIMITS.user = 120) instead
		// of looping 120 real handler calls.
		for (let i = 0; i < 120; i++) noteSearchRequest(ip, userId);

		const res = await GET(event);

		expect(res.status).toBe(429);
		const body = await res.json();
		expect(body.code).toBe('rate_limited');
		expect(h.classifySearch).not.toHaveBeenCalled();
	});

	it('a fresh user/IP pair is unaffected by another user tripping the limit', async () => {
		const { ip, userId } = makeEvent();
		for (let i = 0; i < 120; i++) noteSearchRequest(ip, userId);

		const { event: freshEvent } = makeEvent(); // new unique user id + IP
		const res = await GET(freshEvent);
		expect(res.status).toBe(200);
	});
});
