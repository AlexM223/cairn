// Guard coverage for GET /api/admin/mining — must require an ADMIN. A plain
// signed-in user (or a signed-out request) must never reach the pool-wide view.

import { describe, it, expect } from 'vitest';
import { GET } from './+server';

function makeEvent(overrides: Record<string, unknown> = {}): any {
	return {
		request: new Request('http://localhost/api/admin/mining'),
		url: new URL('http://localhost/api/admin/mining'),
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

describe('GET /api/admin/mining guards', () => {
	it('401 when signed out', async () => {
		expect(await statusOf(() => GET(makeEvent()))).toBe(401);
	});

	it('403 for a non-admin signed-in user', async () => {
		const event = makeEvent({
			locals: { user: { id: 2, email: 'u@x.com', displayName: 'U', isAdmin: false }, flags: {} }
		});
		expect(await statusOf(() => GET(event))).toBe(403);
	});
});
