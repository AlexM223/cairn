// test-units finding 10 — /api/health had ZERO test coverage. This is an
// unauthenticated liveness endpoint polled by container orchestrators and
// reverse proxies; the 503 branch is the one that actually matters and, pre-
// this-file, was entirely unexercised (the invisible-failure class the sprint
// brief calls out).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { db } from '$lib/server/db';
import { GET } from './+server';

type Ev = Parameters<typeof GET>[0];

function makeEvent(): Ev {
	return {} as unknown as Ev;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('GET /api/health', () => {
	it('returns 200 {status:"ok"} when the DB responds', async () => {
		const res = await GET(makeEvent());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'ok' });
	});

	it('returns 503 {status:"degraded"} when the DB check throws', async () => {
		const spy = vi.spyOn(db, 'prepare').mockImplementationOnce(() => {
			throw new Error('db down');
		});

		const res = await GET(makeEvent());
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ status: 'degraded' });
		expect(spy).toHaveBeenCalledWith('SELECT 1');
	});
});
