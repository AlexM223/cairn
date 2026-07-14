// Coverage for the /explorer layout gate, specifically the cairn-5yz3.3
// carve-out: /explorer/tx/[txid] must stay reachable when the `explorer`
// feature flag is off (it's the app's only tx-detail surface), while every
// other explorer sub-route (index, address, block, mempool, difficulty)
// must stay 403'd behind the flag exactly as before.
import { describe, it, expect } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { load } from './+layout.server';

type User = { id: number; email: string; displayName: string; isAdmin: boolean };
const user: User = { id: 1, email: 'a@x.com', displayName: 'A', isAdmin: false };

/** Minimal event stand-in — only the fields the load actually reads. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEvent(routeId: string, overrides: Record<string, unknown> = {}): any {
	return {
		route: { id: routeId },
		request: new Request('http://localhost/explorer'),
		url: new URL('http://localhost/explorer'),
		locals: { user, flags: { explorer: false } },
		getClientAddress: () => '127.0.0.1',
		...overrides
	};
}

describe('/explorer +layout.server load — explorer flag gate (cairn-5yz3.3)', () => {
	it('403s a non-tx explorer sub-route (e.g. the index) when the explorer flag is off', async () => {
		const event = makeEvent('/(app)/explorer');
		await expect(load(event)).rejects.toSatisfy((e: unknown) => isHttpError(e) && e.status === 403);
	});

	it('403s the block sub-route when the explorer flag is off', async () => {
		const event = makeEvent('/(app)/explorer/block/[id]');
		await expect(load(event)).rejects.toSatisfy((e: unknown) => isHttpError(e) && e.status === 403);
	});

	it('does NOT 403 /explorer/tx/[txid] when the explorer flag is off — the tx-detail exemption', async () => {
		const event = makeEvent('/(app)/explorer/tx/[txid]');
		const result = await load(event);
		expect(result).toHaveProperty('disconnected');
		expect(typeof (result as { disconnected: unknown }).disconnected).toBe('boolean');
	});

	it('still requires a logged-in user on the exempted tx-detail route', async () => {
		const event = makeEvent('/(app)/explorer/tx/[txid]', { locals: { user: null, flags: { explorer: false } } });
		await expect(load(event)).rejects.toSatisfy((e: unknown) => isHttpError(e) && e.status === 401);
	});

	it('lets every sub-route through, tx included, when the explorer flag is on', async () => {
		const onEvent = (routeId: string) =>
			makeEvent(routeId, { locals: { user, flags: { explorer: true } } });
		await expect(load(onEvent('/(app)/explorer'))).resolves.toBeDefined();
		await expect(load(onEvent('/(app)/explorer/tx/[txid]'))).resolves.toBeDefined();
	});
});
