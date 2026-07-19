// cairn-gt05.2 — the canonical /wallets/[id]/receive subpage (spec §2.4):
// Home's and the wallet-detail page's Receive buttons both route here, so the
// load contract (wallet identity + snapshot-backed receive + neverFunded) is
// pinned down, including the ownership 404.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { createWallet } from '$lib/server/wallets';
import { load } from './+page.server';

const XPUB =
	'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';

function wipe(): void {
	db.exec(
		'DELETE FROM wallet_snapshots; DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

let userId: number;
let walletId: number;

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	userId = (
		await registerUser({
			email: 'user@example.com',
			password: 'correct horse battery',
			displayName: 'user'
		})
	).id;
	walletId = createWallet(userId, { name: 'Savings', xpub: XPUB }).id;
});

function loadEvent(id: number, uid = userId) {
	return {
		params: { id: String(id) },
		locals: { user: { id: uid, email: 'user@example.com', isAdmin: false } },
		depends: () => {}
	} as unknown as Parameters<typeof load>[0];
}

describe('/wallets/[id]/receive load()', () => {
	it('returns the wallet identity and a null receive before any sync', async () => {
		const data = (await load(loadEvent(walletId))) as {
			wallet: { id: number; name: string };
			receive: unknown;
			neverFunded: boolean;
		};
		expect(data.wallet).toEqual({ id: walletId, name: 'Savings' });
		// No snapshot yet — the panel renders its calm waiting state, not a crash.
		expect(data.receive).toBeNull();
		// Unknown scan ≠ never funded — the confidence line stays off.
		expect(data.neverFunded).toBe(false);
	});

	it("404s another user's wallet", async () => {
		const otherId = (
			await registerUser({
				email: 'other@example.com',
				password: 'correct horse battery',
				displayName: 'other'
			})
		).id;
		// load() is synchronous — the 404 HttpError is thrown, not rejected.
		expect(() => load(loadEvent(walletId, otherId))).toThrowError();
		try {
			load(loadEvent(walletId, otherId));
			expect.unreachable('load should have thrown');
		} catch (e) {
			expect(e).toMatchObject({ status: 404 });
		}
	});

	it('404s a garbage id', () => {
		try {
			load(loadEvent(999999));
			expect.unreachable('load should have thrown');
		} catch (e) {
			expect(e).toMatchObject({ status: 404 });
		}
	});
});
