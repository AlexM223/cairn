// In-memory AuthProvider snapshot (authTable.ts). resolve() is a pure Map
// lookup; refreshAuthTable() rebuilds it off the socket path from enabled
// mining_prefs rows with a payable wallet. A per-user build failure is skipped,
// never fatal to the whole rebuild.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Keep getWallet real (it reads the DB) but stub peekReceiveAddress so no chain
// backend is needed — and let a test mark specific wallets as "peek fails".
const failWalletIds = new Set<number>();
const ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
vi.mock('../wallets', async (orig) => {
	const actual = await orig<typeof import('../wallets')>();
	return {
		...actual,
		peekReceiveAddress: vi.fn(async (w: { id: number }) => {
			if (failWalletIds.has(w.id)) throw new Error('peek failed (simulated chain error)');
			return { address: ADDR, path: '0/0', index: 0 };
		})
	};
});

import { db } from '../db';
import { registerUser } from '../auth';
import { setSetting } from '../settings';
import { ensureMiningPrefs, setPayoutWallet, setUserMiningEnabled } from './prefs';
import { getAuthTable, refreshAuthTable } from './authTable';

function wipe(): void {
	db.exec(
		`DELETE FROM mining_blocks; DELETE FROM mining_stats; DELETE FROM mining_workers;
		 DELETE FROM mining_prefs; DELETE FROM wallets; DELETE FROM sessions;
		 DELETE FROM users; DELETE FROM settings;`
	);
}

async function makeUser(email: string): Promise<number> {
	return (await registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] })).id;
}

function makeWallet(userId: number, xpub: string): number {
	return Number(
		db
			.prepare(
				`INSERT INTO wallets (user_id, name, type, xpub, script_type, receive_cursor)
				 VALUES (?, ?, 'xpub', ?, 'p2wpkh', 0)`
			)
			.run(userId, `w-${xpub.slice(0, 6)}`, xpub).lastInsertRowid
	);
}

beforeEach(() => {
	failWalletIds.clear();
	wipe();
	setSetting('registration_mode', 'open');
	getAuthTable().replace(new Map());
});

describe('refreshAuthTable', () => {
	it('builds an entry for an enabled user with a payable payout wallet', async () => {
		const uid = await makeUser('a@example.com');
		const wid = makeWallet(uid, 'xpubAAAA');
		const prefs = ensureMiningPrefs(uid);
		setPayoutWallet(uid, wid);
		setUserMiningEnabled(uid, true);

		await refreshAuthTable();
		const auth = getAuthTable().resolve(prefs.miningId!);
		expect(auth).not.toBeNull();
		expect(auth!.userId).toBe(uid);
		expect(auth!.walletId).toBe(wid);
		expect(auth!.address).toBe(ADDR);
		expect(auth!.payoutScript.length).toBeGreaterThan(0);
	});

	it('omits a disabled user', async () => {
		const uid = await makeUser('b@example.com');
		const wid = makeWallet(uid, 'xpubBBBB');
		const prefs = ensureMiningPrefs(uid);
		setPayoutWallet(uid, wid);
		setUserMiningEnabled(uid, false);

		await refreshAuthTable();
		expect(getAuthTable().resolve(prefs.miningId!)).toBeNull();
	});

	it('omits an enabled user with no payout wallet', async () => {
		const uid = await makeUser('c@example.com');
		const prefs = ensureMiningPrefs(uid);
		setUserMiningEnabled(uid, true); // enabled but payout_wallet_id is null

		await refreshAuthTable();
		expect(getAuthTable().resolve(prefs.miningId!)).toBeNull();
	});

	it('skips a user whose address build fails, keeping the others', async () => {
		const good = await makeUser('good@example.com');
		const goodW = makeWallet(good, 'xpubGOOD');
		const goodPrefs = ensureMiningPrefs(good);
		setPayoutWallet(good, goodW);
		setUserMiningEnabled(good, true);

		const bad = await makeUser('bad@example.com');
		const badW = makeWallet(bad, 'xpubBAD');
		const badPrefs = ensureMiningPrefs(bad);
		setPayoutWallet(bad, badW);
		setUserMiningEnabled(bad, true);
		failWalletIds.add(badW); // this user's peek throws

		await expect(refreshAuthTable()).resolves.toBeUndefined(); // never throws
		expect(getAuthTable().resolve(goodPrefs.miningId!)).not.toBeNull();
		expect(getAuthTable().resolve(badPrefs.miningId!)).toBeNull();
	});

	it('resolve() is null for an unknown mining id', async () => {
		await refreshAuthTable();
		expect(getAuthTable().resolve('hw_deadbeef')).toBeNull();
	});
});
