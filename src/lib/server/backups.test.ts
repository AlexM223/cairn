import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { createWallet } from './wallets';
import {
	markBackedUp,
	isBackedUp,
	listUnbackedWallets,
	shouldShowBackupReminder,
	dismissBackupReminder,
	nextEligibleAt,
	getDueBackupNudge,
	escalateBackupNudge,
	BACKUP_NUDGE_BUCKET
} from './backups';

// A known-valid mainnet xpub (same fixture family the xpub tests use).
const XPUB =
	'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';

function wipe(): void {
	db.exec(
		'DELETE FROM wallet_backups; DELETE FROM backup_reminders; DELETE FROM backup_nudges; DELETE FROM multisigs; DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

/** Insert a bare multisig row with a given source ('created' | 'imported'). */
function makeMultisig(userId: number, name: string, source: 'created' | 'imported' = 'created'): number {
	const info = db
		.prepare(
			'INSERT INTO multisigs (user_id, name, threshold, script_type, source) VALUES (?, ?, 2, ?, ?)'
		)
		.run(userId, name, 'p2wsh', source);
	return Number(info.lastInsertRowid);
}

describe('wallet-config backup tracking', () => {
	it('only multisigs CREATED from scratch need a backup — single-sig never nags', async () => {
		const user = await makeUser('a@example.com');
		createWallet(user.id, { name: 'Savings', xpub: XPUB }); // single-sig
		const ms = makeMultisig(user.id, 'Family vault', 'created');

		const unbacked = listUnbackedWallets(user.id);
		expect(unbacked).toHaveLength(1);
		expect(unbacked[0]).toMatchObject({ kind: 'multisig', id: ms, name: 'Family vault' });
	});

	it('an IMPORTED multisig never appears in the unbacked list', async () => {
		const user = await makeUser('a@example.com');
		makeMultisig(user.id, 'Imported vault', 'imported');
		expect(listUnbackedWallets(user.id)).toHaveLength(0);
	});

	it('markBackedUp drops a created multisig from the unbacked list', async () => {
		const user = await makeUser('a@example.com');
		const ms = makeMultisig(user.id, 'Family vault', 'created');
		expect(listUnbackedWallets(user.id)).toHaveLength(1);

		markBackedUp(user.id, 'multisig', ms);

		expect(isBackedUp('multisig', ms)).toBe(true);
		expect(listUnbackedWallets(user.id)).toHaveLength(0);
	});

	it('markBackedUp is idempotent but refreshes downloaded_at (single-sig, table mechanics)', async () => {
		const user = await makeUser('a@example.com');
		const wallet = createWallet(user.id, { name: 'Savings', xpub: XPUB });

		markBackedUp(user.id, 'wallet', wallet.id);
		db.prepare(
			"UPDATE wallet_backups SET downloaded_at = '2000-01-01T00:00:00.000Z' WHERE wallet_kind = 'wallet' AND wallet_id = ?"
		).run(wallet.id);
		markBackedUp(user.id, 'wallet', wallet.id);

		const rows = db
			.prepare("SELECT downloaded_at FROM wallet_backups WHERE wallet_kind = 'wallet' AND wallet_id = ?")
			.all(wallet.id) as { downloaded_at: string }[];
		expect(rows).toHaveLength(1); // idempotent — one row
		expect(rows[0].downloaded_at).not.toBe('2000-01-01T00:00:00.000Z'); // refreshed
	});

	it('unbacked list is scoped per user', async () => {
		const alice = await makeUser('alice@example.com');
		const bob = await makeUser('bob@example.com');
		makeMultisig(alice.id, 'Alice vault', 'created');
		makeMultisig(bob.id, "Bob's vault", 'created');

		expect(listUnbackedWallets(alice.id)).toHaveLength(1);
		expect(listUnbackedWallets(bob.id)).toHaveLength(1);
		expect(listUnbackedWallets(alice.id)[0].name).toBe('Alice vault');
	});

	describe('90-day reminder (created multisig only)', () => {
		it('stays quiet when the user has no created-multisig backups', async () => {
			const user = await makeUser('a@example.com');
			// Single-sig + imported multisig backups do NOT drive the reminder.
			const wallet = createWallet(user.id, { name: 'Savings', xpub: XPUB });
			markBackedUp(user.id, 'wallet', wallet.id);
			const imp = makeMultisig(user.id, 'Imported', 'imported');
			markBackedUp(user.id, 'multisig', imp);
			db.prepare("UPDATE wallet_backups SET downloaded_at = '2000-01-01T00:00:00.000Z'").run();

			expect(shouldShowBackupReminder(user.id)).toBe(false);
		});

		it('fires when a created multisig backup is older than the window and undismissed', async () => {
			const user = await makeUser('a@example.com');
			const ms = makeMultisig(user.id, 'Family vault', 'created');
			markBackedUp(user.id, 'multisig', ms);
			db.prepare(
				"UPDATE wallet_backups SET downloaded_at = '2000-01-01T00:00:00.000Z' WHERE wallet_id = ?"
			).run(ms);

			expect(shouldShowBackupReminder(user.id)).toBe(true);
		});

		it('is silenced by a recent dismissal, then returns once the dismissal ages out', async () => {
			const user = await makeUser('a@example.com');
			const ms = makeMultisig(user.id, 'Family vault', 'created');
			markBackedUp(user.id, 'multisig', ms);
			db.prepare(
				"UPDATE wallet_backups SET downloaded_at = '2000-01-01T00:00:00.000Z' WHERE wallet_id = ?"
			).run(ms);

			dismissBackupReminder(user.id);
			expect(shouldShowBackupReminder(user.id)).toBe(false);

			db.prepare(
				"UPDATE backup_reminders SET dismissed_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?"
			).run(user.id);
			expect(shouldShowBackupReminder(user.id)).toBe(true);
		});
	});

	// cairn-gt05.5 — decaying, polymorphic, state-driven backup-nudge cadence.
	// docs/UX-BACKUP-NUDGE-AND-FIRST-DEPOSIT-SPEC.md Spec A.
	describe('nextEligibleAt (pure decay-schedule function)', () => {
		const DAY = 24 * 60 * 60 * 1000;
		const HOUR = 60 * 60 * 1000;

		it('is due immediately when never shown', () => {
			expect(nextEligibleAt(null, 0)).toBe(0);
		});

		it('follows the +3 / +10 / +30 / +90 day ladder', () => {
			const t0 = 1_000_000;
			expect(nextEligibleAt(t0, 1)).toBe(t0 + 3 * DAY);
			expect(nextEligibleAt(t0, 2)).toBe(t0 + 10 * DAY);
			expect(nextEligibleAt(t0, 3)).toBe(t0 + 30 * DAY);
			expect(nextEligibleAt(t0, 4)).toBe(t0 + 90 * DAY);
		});

		it('caps at the quarterly rung for any shownCount beyond 4 — cadence never shortens', () => {
			const t0 = 1_000_000;
			expect(nextEligibleAt(t0, 5)).toBe(t0 + 90 * DAY);
			expect(nextEligibleAt(t0, 12)).toBe(t0 + 90 * DAY);
		});

		it('rung 0 (+3 days) equals the 72h hard cap — the equivalence escalation relies on', () => {
			const t0 = 1_000_000;
			expect(nextEligibleAt(t0, 1) - t0).toBe(72 * HOUR);
		});

		it('shownCount 0 with a real timestamp (the pending-escalation sentinel) still waits the 72h cap, not immediately', () => {
			const t0 = 1_000_000;
			expect(nextEligibleAt(t0, 0)).toBe(t0 + 72 * HOUR);
		});
	});

	describe('getDueBackupNudge / escalateBackupNudge (decaying amber banner)', () => {
		it('shows once at creation with the earned-moment V1 variant, then decays (no re-show same session)', async () => {
			const user = await makeUser('a@example.com');
			const ms = makeMultisig(user.id, 'Family vault', 'created');

			const first = getDueBackupNudge(user.id);
			expect(first).toMatchObject({ walletId: ms, variantId: 'V1', tone: 'calm', unbackedCount: 1 });

			// Immediately again: decayed, not due.
			expect(getDueBackupNudge(user.id)).toBeNull();
		});

		it('rotates through the calm copy variants across widening intervals, never repeating consecutively', async () => {
			const user = await makeUser('a@example.com');
			const ms = makeMultisig(user.id, 'Family vault', 'created');

			const seen: string[] = [];
			const n1 = getDueBackupNudge(user.id);
			seen.push(n1!.variantId);

			// Force each subsequent showing due by rewinding last_shown_at well past
			// its interval — mirrors decay elapsing, without a real multi-day wait.
			for (let i = 0; i < 4; i++) {
				db.prepare(
					"UPDATE backup_nudges SET last_shown_at = '2000-01-01T00:00:00.000Z' WHERE wallet_id = ?"
				).run(ms);
				const n = getDueBackupNudge(user.id);
				expect(n).not.toBeNull();
				seen.push(n!.variantId);
			}

			expect(seen).toEqual(['V1', 'V2', 'V3', 'V4', 'V5']);
			for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
		});

		it('a second unbacked wallet escalates to E-MULTI once due, with the correct count', async () => {
			const user = await makeUser('a@example.com');
			const msA = makeMultisig(user.id, 'Vault A', 'created');
			getDueBackupNudge(user.id); // shows V1 for A, stamps last_shown_at

			makeMultisig(user.id, 'Vault B', 'created');
			// A's cap hasn't elapsed yet — MULTI is recorded but not shown yet.
			expect(getDueBackupNudge(user.id)?.walletId).not.toBe(msA);

			// Once A's 72h cap elapses, its nudge is due again with E-MULTI.
			db.prepare(
				"UPDATE backup_nudges SET last_shown_at = '2000-01-01T00:00:00.000Z' WHERE wallet_id = ?"
			).run(msA);
			const escalated = getDueBackupNudge(user.id);
			expect(escalated).toMatchObject({ walletId: msA, variantId: 'E-MULTI', tone: 'escalated', unbackedCount: 2 });
		});

		it('funds arriving on an unbacked wallet escalates to E-FUNDED, but never within 72h of the last showing', async () => {
			const user = await makeUser('a@example.com');
			const ms = makeMultisig(user.id, 'Family vault', 'created');
			getDueBackupNudge(user.id); // V1, stamps last_shown_at = now

			escalateBackupNudge(user.id, ms, BACKUP_NUDGE_BUCKET.FUNDED);
			// Within the 72h cap of the real showing above — must not fire yet.
			expect(getDueBackupNudge(user.id)).toBeNull();

			// Cap elapsed: now due, with the escalated copy.
			db.prepare(
				"UPDATE backup_nudges SET last_shown_at = '2000-01-01T00:00:00.000Z' WHERE wallet_id = ?"
			).run(ms);
			const nudge = getDueBackupNudge(user.id);
			expect(nudge).toMatchObject({ walletId: ms, variantId: 'E-FUNDED', tone: 'escalated' });
		});

		it('escalateBackupNudge no-ops for an imported multisig (never nudged at all)', async () => {
			const user = await makeUser('a@example.com');
			const ms = makeMultisig(user.id, 'Imported vault', 'imported');
			escalateBackupNudge(user.id, ms, BACKUP_NUDGE_BUCKET.FUNDED);
			expect(getDueBackupNudge(user.id)).toBeNull();
		});

		it('marking the wallet backed up removes it from the nudge entirely', async () => {
			const user = await makeUser('a@example.com');
			const ms = makeMultisig(user.id, 'Family vault', 'created');
			getDueBackupNudge(user.id);
			markBackedUp(user.id, 'multisig', ms);

			db.prepare(
				"UPDATE backup_nudges SET last_shown_at = '2000-01-01T00:00:00.000Z' WHERE wallet_id = ?"
			).run(ms);
			expect(getDueBackupNudge(user.id)).toBeNull();
		});

		it('decay state survives being re-read fresh (timestamp-persisted, not in-process)', async () => {
			const user = await makeUser('a@example.com');
			const ms = makeMultisig(user.id, 'Family vault', 'created');
			getDueBackupNudge(user.id);

			const row = db
				.prepare('SELECT last_shown_at, shown_count FROM backup_nudges WHERE wallet_id = ?')
				.get(ms) as { last_shown_at: string; shown_count: number };
			expect(row.shown_count).toBe(1);
			expect(row.last_shown_at).toEqual(expect.any(String));
		});
	});
});
