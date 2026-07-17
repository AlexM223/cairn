// Per-user mining prefs (prefs.ts): mining_id identity generation/format, and
// the payout-wallet ownership guard — a user must never be able to point their
// payout at a wallet they don't own.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import { registerUser } from '../auth';
import { setSetting } from '../settings';
import {
	ensureMiningPrefs,
	getMiningPrefs,
	setPayoutWallet,
	setUserMiningEnabled,
	regenerateMiningId
} from './prefs';

function wipe(): void {
	db.exec(
		`DELETE FROM mining_blocks; DELETE FROM mining_stats; DELETE FROM mining_workers;
		 DELETE FROM mining_prefs; DELETE FROM wallets; DELETE FROM sessions;
		 DELETE FROM users; DELETE FROM settings;`
	);
}

let alice: number;
let bob: number;

async function makeUser(email: string): Promise<number> {
	return (await registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] })).id;
}

/** Insert a wallet row directly (bypassing xpub validation; these tests only
 *  need FK-valid rows with distinct xpubs). Returns the wallet id. */
function makeWallet(userId: number, xpub: string): number {
	const info = db
		.prepare(
			`INSERT INTO wallets (user_id, name, type, xpub, script_type, receive_cursor)
			 VALUES (?, ?, 'xpub', ?, 'p2wpkh', 0)`
		)
		.run(userId, `wallet-${xpub.slice(0, 6)}`, xpub);
	return Number(info.lastInsertRowid);
}

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	alice = await makeUser('alice@example.com');
	bob = await makeUser('bob@example.com');
});

describe('mining_id', () => {
	it('generates an `hw_` + 8-lowercase-hex id on first ensure', () => {
		const prefs = ensureMiningPrefs(alice);
		expect(prefs.miningId).toMatch(/^hw_[0-9a-f]{8}$/);
		expect(prefs.enabled).toBe(false);
		expect(prefs.payoutWalletId).toBeNull();
	});

	it('is idempotent — the same id is returned on repeat ensures', () => {
		const first = ensureMiningPrefs(alice).miningId;
		const second = ensureMiningPrefs(alice).miningId;
		expect(second).toBe(first);
	});

	it('is unique across users', () => {
		const a = ensureMiningPrefs(alice).miningId;
		const b = ensureMiningPrefs(bob).miningId;
		expect(a).not.toBe(b);
	});

	it('regenerate rotates to a new valid id', () => {
		const old = ensureMiningPrefs(alice).miningId;
		const next = regenerateMiningId(alice).miningId;
		expect(next).toMatch(/^hw_[0-9a-f]{8}$/);
		expect(next).not.toBe(old);
	});
});

describe('payout wallet ownership', () => {
	it('accepts one of the caller’s own wallets', () => {
		const w = makeWallet(alice, 'xpubAAAA');
		const prefs = setPayoutWallet(alice, w);
		expect(prefs.payoutWalletId).toBe(w);
	});

	it('rejects a wallet owned by another user', () => {
		const bobWallet = makeWallet(bob, 'xpubBBBB');
		expect(() => setPayoutWallet(alice, bobWallet)).toThrow(/not found/i);
		// And nothing was persisted for alice.
		expect(getMiningPrefs(alice)?.payoutWalletId ?? null).toBeNull();
	});

	it('rejects a non-existent wallet id', () => {
		expect(() => setPayoutWallet(alice, 999999)).toThrow(/not found/i);
	});

	it('allows clearing the payout (null)', () => {
		const w = makeWallet(alice, 'xpubCCCC');
		setPayoutWallet(alice, w);
		const cleared = setPayoutWallet(alice, null);
		expect(cleared.payoutWalletId).toBeNull();
	});
});

describe('enable toggle', () => {
	it('flips the enabled flag', () => {
		expect(setUserMiningEnabled(alice, true).enabled).toBe(true);
		expect(setUserMiningEnabled(alice, false).enabled).toBe(false);
	});
});
