// Guard coverage for GET /api/mining/me — must require sign-in AND the `mining`
// feature flag. The full view shape + per-user isolation is covered in
// src/lib/server/mining/readModels.test.ts.

import { describe, it, expect } from 'vitest';
import { GET } from './+server';

function makeEvent(overrides: Record<string, unknown> = {}): any {
	return {
		request: new Request('http://localhost/api/mining/me'),
		url: new URL('http://localhost/api/mining/me'),
		locals: { user: null, flags: {} },
		getClientAddress: () => '127.0.0.1',
		...overrides
	};
}

async function statusOf(fn: () => Promise<unknown>): Promise<number> {
	try {
		await fn();
	} catch (e) {
		return (e as { status: number }).status;
	}
	throw new Error('expected the handler to throw');
}

describe('GET /api/mining/me guards', () => {
	it('401 when signed out', async () => {
		expect(await statusOf(() => GET(makeEvent()))).toBe(401);
	});

	it('403 when the mining feature is disabled for the user', async () => {
		const event = makeEvent({
			locals: {
				user: { id: 1, email: 'a@x.com', displayName: 'A', isAdmin: false },
				flags: { mining: false }
			}
		});
		expect(await statusOf(() => GET(event))).toBe(403);
	});
});
