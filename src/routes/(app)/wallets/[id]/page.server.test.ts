// Regression test for cairn-q1z9: the single-sig wallet detail page must expose
// the SERVER-tracked backup status (wallet_backups via isBackedUp()) as
// data.backedUp. This wiring was added in cairn-xvze (fd7427e) and then silently
// deleted the same day by an unrelated refactor (61e1b9d) that mislabeled it as
// dead state — so this test pins the contract down.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { createWallet } from '$lib/server/wallets';
import { markBackedUp } from '$lib/server/backups';

// The network half of load() (Electrum scan, receive address, chain tip) is
// irrelevant to backup status. Stub the scan as "unreachable" so load() takes
// its offline fallback branch, which still carries the base payload — including
// backedUp — that we're pinning here.
vi.mock('$lib/server/wallets', async (importOriginal) => {
	const mod = await importOriginal<typeof import('$lib/server/wallets')>();
	return {
		...mod,
		getWalletDetail: vi.fn(async () => {
			throw new Error('Electrum server unreachable', { cause: 'unreachable' });
		})
	};
});

import { load } from './+page.server';

const XPUB =
	'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';

function wipe(): void {
	db.exec(
		'DELETE FROM wallet_backups; DELETE FROM multisigs; DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
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

function loadEvent(id: number) {
	return {
		params: { id: String(id) },
		locals: { user: { id: userId, email: 'user@example.com', isAdmin: false } },
		url: new URL(`http://localhost/wallets/${id}`),
		depends: vi.fn()
	} as unknown as Parameters<typeof load>[0];
}

describe('single-sig wallet detail load() backup status (cairn-q1z9)', () => {
	it('reports backedUp: false when wallet_backups has no row', async () => {
		const data = (await load(loadEvent(walletId))) as { backedUp: boolean };
		expect(data.backedUp).toBe(false);
	});

	it('reports backedUp: true once the config download is recorded server-side', async () => {
		markBackedUp(userId, 'wallet', walletId);
		const data = (await load(loadEvent(walletId))) as { backedUp: boolean };
		expect(data.backedUp).toBe(true);
	});

	it('is scoped by wallet kind — a multisig backup with the same id does not count', async () => {
		// Force a multisig row whose id collides numerically with the wallet's.
		db.prepare(
			'INSERT INTO multisigs (id, user_id, name, threshold, script_type, source) VALUES (?, ?, ?, 2, ?, ?)'
		).run(walletId, userId, 'Vault', 'p2wsh', 'created');
		markBackedUp(userId, 'multisig', walletId);

		const data = (await load(loadEvent(walletId))) as { backedUp: boolean };
		expect(data.backedUp).toBe(false);
	});
});
