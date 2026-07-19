// cairn-gt05.2 — the /wallets/[id]/settings subpage (spec §2.2): rename is
// friction-free; remove-wallet is CONFIRMATION-GATED server-side (a bare POST
// cannot remove a wallet) and redirects to /wallets on success.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting } from '$lib/server/settings';
import { createWallet, getWallet } from '$lib/server/wallets';
import { load, actions } from './+page.server';

const XPUB =
	'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';

function wipe(): void {
	db.exec(
		'DELETE FROM wallet_snapshots; DELETE FROM wallet_backups; DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
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

function baseEvent(id: number, body?: Record<string, string>) {
	const form = new URLSearchParams(body ?? {});
	return {
		params: { id: String(id) },
		locals: { user: { id: userId, email: 'user@example.com', isAdmin: false } },
		depends: () => {},
		request: new Request(`http://localhost/wallets/${id}/settings`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: form
		})
	} as unknown as Parameters<(typeof actions)['delete']>[0];
}

describe('/wallets/[id]/settings load()', () => {
	it('returns the wallet, backup status and an (empty pre-sync) address list', async () => {
		const data = (await load(baseEvent(walletId) as never)) as {
			wallet: { id: number; name: string; xpub: string };
			backedUp: boolean;
			addresses: unknown[];
		};
		expect(data.wallet.id).toBe(walletId);
		expect(data.wallet.name).toBe('Savings');
		expect(data.wallet.xpub).toBe(XPUB);
		expect(data.backedUp).toBe(false);
		expect(data.addresses).toEqual([]);
	});
});

describe('?/rename', () => {
	it('renames the wallet', async () => {
		const res = await actions.rename(baseEvent(walletId, { name: 'Cold Storage' }));
		expect(res).toEqual({ renamed: true });
		expect(getWallet(userId, walletId)?.name).toBe('Cold Storage');
	});

	it('rejects a blank name without touching the row', async () => {
		const res = (await actions.rename(baseEvent(walletId, { name: '   ' }))) as {
			status: number;
			data: { renameError: string };
		};
		expect(res.status).toBe(400);
		expect(getWallet(userId, walletId)?.name).toBe('Savings');
	});
});

describe('?/delete (confirmation-gated remove)', () => {
	it('refuses a bare POST without the confirmation field — the wallet survives', async () => {
		const res = (await actions.delete(baseEvent(walletId))) as { status: number };
		expect(res.status).toBe(400);
		expect(getWallet(userId, walletId)).toBeTruthy();
	});

	it('removes the wallet and redirects once confirmed', async () => {
		await expect(
			actions.delete(baseEvent(walletId, { confirmed: 'yes' }))
		).rejects.toMatchObject({ status: 303, location: '/wallets' });
		expect(getWallet(userId, walletId)).toBeFalsy();
	});
});
