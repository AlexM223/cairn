import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import {
	recordActivity,
	listUserFeed,
	listAllActivity,
	isUserFeedType,
	unreadUserFeedCount,
	markUserFeedRead
} from './activity';

function wipe(): void {
	db.exec('DELETE FROM events; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;');
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

/** Registering the 2nd+ user fires an admin_new_signup event; clear the slate so
 *  each test counts only the events it records. */
function clearEvents(): void {
	db.exec('DELETE FROM events');
}

describe('activity user feed vs admin log split', () => {
	it('classifies user-relevant vs operational event types', () => {
		// User-relevant
		for (const t of ['tx_received', 'tx_confirmed', 'broadcast', 'backup_downloaded', 'sign_session_waiting', 'security_new_passkey']) {
			expect(isUserFeedType(t)).toBe(true);
		}
		// Operational / admin-only
		for (const t of ['network_up', 'network_down', 'new_block', 'electrum_switched', 'scan_complete', 'admin_new_signup', 'admin_server_health']) {
			expect(isUserFeedType(t)).toBe(false);
		}
		// Fail-closed: an unknown type is never in the user feed.
		expect(isUserFeedType('some_future_operational_event')).toBe(false);
	});

	it('user feed shows only the user OWN relevant events — no instance, operational, or other-user events', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');

		clearEvents();
		recordActivity({ type: 'tx_received', userId: alice.id, message: 'Payment received — 0.05 BTC' });
		recordActivity({ type: 'broadcast', userId: alice.id, message: 'You sent a transaction' });
		// Operational, user-scoped → hidden from the user feed.
		recordActivity({ type: 'scan_complete', userId: alice.id, message: 'Wallet scan finished' });
		// Instance-wide operational → hidden.
		recordActivity({ type: 'new_block', userId: null, message: 'New block #850000' });
		recordActivity({ type: 'network_down', userId: null, message: 'Network connection lost' });
		// Another user's event → never visible to alice.
		recordActivity({ type: 'tx_received', userId: bob.id, message: "Bob's payment" });
		// Admin broadcast → hidden.
		recordActivity({ type: 'admin_new_signup', userId: null, message: 'A new user signed up' });

		const feed = listUserFeed(alice.id);
		const messages = feed.map((e) => e.message).sort();
		expect(messages).toEqual(['Payment received — 0.05 BTC', 'You sent a transaction']);
		// No instance-scoped rows leaked in.
		expect(feed.every((e) => e.scope === 'you')).toBe(true);
	});

	it('admin log sees EVERYTHING — all users, instance-wide, and operational events', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		clearEvents();
		recordActivity({ type: 'tx_received', userId: alice.id, message: 'Alice payment' });
		recordActivity({ type: 'tx_received', userId: bob.id, message: 'Bob payment' });
		recordActivity({ type: 'new_block', userId: null, message: 'New block' });
		recordActivity({ type: 'network_down', level: 'warn', userId: null, message: 'Network lost' });

		const { events, total } = listAllActivity();
		expect(total).toBe(4);
		expect(events).toHaveLength(4);
		// Owning user is attributed (or null for instance-wide).
		const aliceRow = events.find((e) => e.message === 'Alice payment');
		expect(aliceRow?.userId).toBe(alice.id);
		expect(aliceRow?.userEmail).toBe('alice@example.com');
		const blockRow = events.find((e) => e.message === 'New block');
		expect(blockRow?.userId).toBeNull();
	});

	it('admin log withholds raw detail by default; includeDetail restores it (cairn-o1dp.5)', () => {
		const alice = makeUser('alice@example.com');
		clearEvents();
		recordActivity({
			type: 'broadcast',
			userId: alice.id,
			message: 'Transaction sent',
			detail: { txid: 'a'.repeat(64), multisigId: 7 }
		});

		// Default shape matches what the admin UI renders: message only, no detail.
		const dflt = listAllActivity();
		expect(dflt.events[0].message).toBe('Transaction sent');
		expect(dflt.events[0].detail).toBeNull();
		expect(JSON.stringify(dflt.events)).not.toContain('a'.repeat(64));

		// Explicit support/debugging opt-in restores the full payload.
		const full = listAllActivity({ includeDetail: true });
		expect(full.events[0].detail).toEqual({ txid: 'a'.repeat(64), multisigId: 7 });
	});

	it('admin log filters by type, level, user, and message search', () => {
		const alice = makeUser('alice@example.com');
		const bob = makeUser('bob@example.com');
		clearEvents();
		recordActivity({ type: 'tx_received', userId: alice.id, message: 'Alice payment received' });
		recordActivity({ type: 'broadcast', level: 'success', userId: alice.id, message: 'Alice sent funds' });
		recordActivity({ type: 'tx_received', userId: bob.id, message: 'Bob payment received' });
		recordActivity({ type: 'network_down', level: 'warn', userId: null, message: 'Network lost' });

		expect(listAllActivity({ type: 'tx_received' }).total).toBe(2);
		expect(listAllActivity({ level: 'warn' }).total).toBe(1);
		expect(listAllActivity({ userId: alice.id }).total).toBe(2);
		expect(listAllActivity({ userId: null }).total).toBe(1); // instance-wide only
		expect(listAllActivity({ search: 'payment' }).total).toBe(2);
		expect(listAllActivity({ search: 'ALICE' }).total).toBe(2); // case-insensitive
	});

	it('unread count and mark-read operate on the user feed only', () => {
		const alice = makeUser('alice@example.com');
		clearEvents();
		recordActivity({ type: 'tx_received', userId: alice.id, message: 'p1' });
		recordActivity({ type: 'tx_confirmed', userId: alice.id, message: 'p2' });
		// Operational + instance rows must NOT count toward the user's unread badge.
		recordActivity({ type: 'scan_complete', userId: alice.id, message: 'scan' });
		recordActivity({ type: 'new_block', userId: null, message: 'block' });

		expect(unreadUserFeedCount(alice.id)).toBe(2);
		markUserFeedRead(alice.id);
		expect(unreadUserFeedCount(alice.id)).toBe(0);
	});
});
