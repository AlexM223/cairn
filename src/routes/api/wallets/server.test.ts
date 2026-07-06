// cairn-k7oc — route-level regression for GET /api/wallets (fix cairn-16g):
// the endpoint requires auth and returns ONLY the calling user's wallets —
// another user's wallets must never leak into the response.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// listWallets scans every wallet via Electrum for live balances. Stub the scan
// so this route test is offline and deterministic — a scan failure is
// per-wallet and non-fatal by design (the wallet still comes back, zero-balance,
// with its message in `errors`), which is exactly the path exercised here.
vi.mock('$lib/server/bitcoin/walletScan', () => ({
	scanWallet: vi.fn(async () => {
		throw new Error('electrum offline (stubbed in test)');
	}),
	invalidateWalletCache: vi.fn(),
	findNextUnusedIndex: vi.fn(async () => 0)
}));

import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { createWallet } from '$lib/server/wallets';
import { GET } from './+server';

// A known-valid mainnet xpub (same fixture backups.test.ts uses). The wallets
// table is UNIQUE(user_id, xpub), so two different users may both import it.
const XPUB =
	'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';

function wipe(): void {
	db.exec('DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;');
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

/** Minimal RequestEvent for the GET handler. */
function getEvent(user: ReturnType<typeof registerUser> | null): Parameters<typeof GET>[0] {
	return {
		locals: { user },
		params: {},
		url: new URL('http://localhost/api/wallets'),
		request: new Request('http://localhost/api/wallets')
	} as unknown as Parameters<typeof GET>[0];
}

async function getWalletsAs(user: ReturnType<typeof registerUser>) {
	const res = await GET(getEvent(user));
	expect(res.status).toBe(200);
	return (await res.json()) as {
		wallets: { id: number; name: string; xpub: string; balance: number }[];
		errors: Record<number, string>;
	};
}

describe('GET /api/wallets', () => {
	it('rejects an unauthenticated request with 401', async () => {
		let status: number | undefined;
		try {
			await GET(getEvent(null));
		} catch (e) {
			status = (e as { status?: number }).status;
		}
		expect(status).toBe(401);
	});

	it('an authenticated user with no wallets gets 200 and an empty list', async () => {
		const alice = makeUser('alice@example.com');
		const body = await getWalletsAs(alice);
		expect(body.wallets).toEqual([]);
		expect(body.errors).toEqual({});
	});

	it('a wallet created via createWallet() appears in the response', async () => {
		const alice = makeUser('alice@example.com');
		const wallet = createWallet(alice.id, { name: 'Savings', xpub: XPUB });

		const body = await getWalletsAs(alice);
		expect(body.wallets).toHaveLength(1);
		expect(body.wallets[0]).toMatchObject({ id: wallet.id, name: 'Savings', xpub: XPUB });
		// The stubbed scan failed — non-fatally: the wallet is still listed with a
		// zeroed balance and its message lands in errors, keyed by wallet id.
		expect(body.wallets[0].balance).toBe(0);
		expect(body.errors[wallet.id]).toBeTruthy();
	});

	it("never includes another user's wallets (wrong-owner leak guard)", async () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		const aliceWallet = createWallet(alice.id, { name: 'Alice savings', xpub: XPUB });

		// Bob has nothing — Alice's wallet must not leak into his response.
		const bobEmpty = await getWalletsAs(bob);
		expect(bobEmpty.wallets).toEqual([]);

		// Even when both users imported the SAME xpub, each sees only their own row.
		const bobWallet = createWallet(bob.id, { name: 'Bob savings', xpub: XPUB });
		const aliceBody = await getWalletsAs(alice);
		const bobBody = await getWalletsAs(bob);
		expect(aliceBody.wallets.map((w) => w.id)).toEqual([aliceWallet.id]);
		expect(bobBody.wallets.map((w) => w.id)).toEqual([bobWallet.id]);
		expect(aliceBody.wallets[0].name).toBe('Alice savings');
		expect(bobBody.wallets[0].name).toBe('Bob savings');
	});
});
