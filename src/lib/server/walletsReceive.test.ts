// Regression tests for cairn-2ic5: the receive-address "Rotate" button.
//
// nextReceiveAddress() used to call findNextUnusedIndex() -> scanWallet() on
// every click — a full BIP44 gap-limit Electrum rescan (30-40s), even just to
// advance one index the wallet already knew was unused. These tests pin the
// reuse window: peekReceiveAddress (run on every wallet-page load) seeds the
// last-scanned used-boundary, and a Rotate that lands strictly inside the known
// gap window advances WITHOUT re-scanning. Probing at/past the window ceiling,
// below the boundary, or after the reuse TTL still forces a real scan — the
// safety cases where a stale boundary could hand out the wrong index.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// findNextUnusedIndex is the only expensive seam; mock the whole walletScan
// module so no Electrum socket ever opens and we can count real scans.
const mocks = vi.hoisted(() => ({
	findNextUnusedIndex: vi.fn(),
	scanWallet: vi.fn(),
	invalidateWalletCache: vi.fn()
}));

vi.mock('./bitcoin/walletScan', () => ({
	findNextUnusedIndex: mocks.findNextUnusedIndex,
	scanWallet: mocks.scanWallet,
	invalidateWalletCache: mocks.invalidateWalletCache
}));

import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { getWallet, nextReceiveAddress, peekReceiveAddress } from './wallets';

// BIP84 test-vector account zpub — a public test key, never a real wallet.
const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

function wipe(): void {
	db.exec('DELETE FROM sessions; DELETE FROM wallets; DELETE FROM users; DELETE FROM settings;');
}

// The reuse window is a module-level Map keyed by xpub, and every test reuses the
// same ZPUB. Freeze Date (only Date — leave real timers alone) and jump an hour
// per test so any prior test's entry is guaranteed past the 5-min TTL: each test
// starts from a clean cache.
let clock = 1_700_000_000_000;

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	mocks.findNextUnusedIndex.mockReset();
	clock += 60 * 60_000;
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(clock);
});

afterEach(() => {
	vi.useRealTimers();
});

function makeUser(email: string) {
	return registerUser({
		email,
		password: 'correct horse battery',
		displayName: email.split('@')[0]
	});
}

function makeWallet(userId: number): number {
	const res = db
		.prepare("INSERT INTO wallets (user_id, name, xpub, script_type) VALUES (?, 'w', ?, 'p2wpkh')")
		.run(userId, ZPUB);
	return Number(res.lastInsertRowid);
}

describe('receive-address rotation reuse (cairn-2ic5)', () => {
	it('reuses the scanned window: repeated rotates advance without re-scanning', async () => {
		const user = await makeUser('reuse@example.com');
		const id = makeWallet(user.id);
		const row = getWallet(user.id, id)!;
		mocks.findNextUnusedIndex.mockResolvedValue(3);

		// The page load peeks the on-display address — this is the one scan.
		const peek = await peekReceiveAddress(row);
		expect(peek.index).toBe(3);
		expect(mocks.findNextUnusedIndex).toHaveBeenCalledTimes(1);

		// Three rotates, each landing inside the known gap window [3, 22]: no more
		// scans, and each hands out a fresh, advancing index.
		const r1 = await nextReceiveAddress(user.id, id, 3);
		const r2 = await nextReceiveAddress(user.id, id, r1!.index);
		const r3 = await nextReceiveAddress(user.id, id, r2!.index);
		expect([r1?.index, r2?.index, r3?.index]).toEqual([4, 5, 6]);
		expect(mocks.findNextUnusedIndex).toHaveBeenCalledTimes(1);
	});

	it('re-scans when a rotate would probe at/past the gap-window ceiling', async () => {
		const user = await makeUser('ceiling@example.com');
		const id = makeWallet(user.id);
		const row = getWallet(user.id, id)!;
		mocks.findNextUnusedIndex.mockResolvedValue(3);

		await peekReceiveAddress(row);
		expect(mocks.findNextUnusedIndex).toHaveBeenCalledTimes(1);

		// after=22 wants index 23, past the known ceiling (3 + 20 - 1 = 22): a stale
		// boundary could be wrong exactly here, so a real scan is forced.
		const r = await nextReceiveAddress(user.id, id, 22);
		expect(mocks.findNextUnusedIndex).toHaveBeenCalledTimes(2);
		// The gap clamp still pins it inside the (freshly confirmed) window.
		expect(r?.index).toBe(22);
	});

	it('safety: never serves an index below the known used-boundary from cache', async () => {
		const user = await makeUser('safety@example.com');
		const id = makeWallet(user.id);
		const row = getWallet(user.id, id)!;
		// Known boundary is 10: indices below it may already be used.
		mocks.findNextUnusedIndex.mockResolvedValue(10);

		const peek = await peekReceiveAddress(row);
		expect(peek.index).toBe(10);
		expect(mocks.findNextUnusedIndex).toHaveBeenCalledTimes(1);

		// after=2 targets index 3, below the boundary — must re-scan rather than
		// risk handing out a used address, and the result is pinned up to the
		// confirmed unused index, never below it.
		const r = await nextReceiveAddress(user.id, id, 2);
		expect(mocks.findNextUnusedIndex).toHaveBeenCalledTimes(2);
		expect(r?.index).toBe(10);
	});

	it('re-scans once the reuse window is older than its TTL', async () => {
		const user = await makeUser('ttl@example.com');
		const id = makeWallet(user.id);
		const row = getWallet(user.id, id)!;
		mocks.findNextUnusedIndex.mockResolvedValue(3);

		await peekReceiveAddress(row);
		expect(mocks.findNextUnusedIndex).toHaveBeenCalledTimes(1);

		// Six minutes later (past the 5-min reuse TTL) the boundary is treated as
		// stale, so even an in-window rotate re-scans.
		vi.setSystemTime(clock + 6 * 60_000);
		const r = await nextReceiveAddress(user.id, id, 3);
		expect(mocks.findNextUnusedIndex).toHaveBeenCalledTimes(2);
		expect(r?.index).toBe(4);
	});
});

// ---- cairn-2qa4: concurrent issuance must never hand out the same address -----
//
// nextReceiveAddress reads the cursor, awaits a (possibly slow) gap scan, then
// writes the cursor back. Two concurrent callers used to both read the same
// stale cursor before either wrote, derive the same index, and hand out the
// same address. It's now serialized per wallet (keyedLock.ts) and the cursor
// write is monotonic (MAX) as defense-in-depth.
describe('nextReceiveAddress concurrency and cursor safety (cairn-2qa4)', () => {
	it('two concurrent calls for the same wallet serialize and hand out different indexes', async () => {
		const user = await makeUser('race@example.com');
		const id = makeWallet(user.id);
		let scans = 0;
		// A real (short) delay stands in for the slow Electrum gap scan: it opens
		// an actual async gap between the two callers' read-scan-derive-write
		// critical sections, so this exercises the same interleaving window a
		// live 30s scan would.
		mocks.findNextUnusedIndex.mockImplementation(async () => {
			scans++;
			await new Promise((resolve) => setTimeout(resolve, 10));
			return 3;
		});

		const [r1, r2] = await Promise.all([
			nextReceiveAddress(user.id, id),
			nextReceiveAddress(user.id, id)
		]);

		expect(r1!.index).not.toBe(r2!.index);
		expect([r1!.index, r2!.index].sort()).toEqual([3, 4]);
		expect(r1!.address).not.toBe(r2!.address);
		// The lock made the second caller wait for the first's write, so it saw
		// the already-known (still fresh) gap window and never needed its own scan.
		expect(scans).toBe(1);
		expect(getWallet(user.id, id)!.receive_cursor).toBe(5);
	});

	it('never regresses the cursor: a late/lower write loses to MAX()', async () => {
		const user = await makeUser('monotonic@example.com');
		const id = makeWallet(user.id);
		mocks.findNextUnusedIndex.mockResolvedValue(10);

		const r = await nextReceiveAddress(user.id, id);
		expect(r?.index).toBe(10);
		expect(getWallet(user.id, id)!.receive_cursor).toBe(11);

		// Simulate a late/out-of-order writer proposing a lower cursor directly —
		// the MAX() in the UPDATE must refuse to regress it.
		db.prepare('UPDATE wallets SET receive_cursor = MAX(receive_cursor, ?) WHERE id = ?').run(2, id);
		expect(getWallet(user.id, id)!.receive_cursor).toBe(11);

		// A genuinely higher write still advances it normally.
		db.prepare('UPDATE wallets SET receive_cursor = MAX(receive_cursor, ?) WHERE id = ?').run(20, id);
		expect(getWallet(user.id, id)!.receive_cursor).toBe(20);
	});
});
