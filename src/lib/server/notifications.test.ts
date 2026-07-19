import { describe, it, expect, beforeEach, vi } from 'vitest';

// Wrap ./activity in call-through spies so notify()'s in-app write seam can be
// forced to throw in the stage-isolation tests (cairn-potk) — recordActivity's
// own contract is "never throws", so only a mock can exercise notify()'s guard.
// Everything keeps its real implementation until a test overrides it, and
// beforeEach's vi.restoreAllMocks() puts the real behavior back.
vi.mock('./activity', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./activity')>();
	return { ...actual, recordActivity: vi.fn(actual.recordActivity) };
});

import { db } from './db';
import { registerUser } from './auth';
import { setUserAdmin } from './admin';
import { setSetting } from './settings';
import { notify, resolveRecipients, DEFAULT_PREFERENCES, CHANNELS } from './notifications';
import { recordActivity } from './activity';
import { _internals } from './notificationQueue';
import type { NotificationPayload } from './notifyTypes';

function wipe(): void {
	db.exec(
		'DELETE FROM notification_queue; DELETE FROM notification_preferences; DELETE FROM notification_channel_config; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	vi.restoreAllMocks();
});

const PASSWORD = 'correct horse battery';
function makeUser(email: string) {
	return registerUser({ email, password: PASSWORD, displayName: email.split('@')[0] });
}

function payload(over: Partial<NotificationPayload> = {}): NotificationPayload {
	return {
		type: 'tx_received',
		userId: null,
		level: 'info',
		title: 'Payment received',
		body: '0.01 BTC',
		...over
	};
}

describe('resolveRecipients', () => {
	it('returns no external targets by default (DEFAULT_PREFERENCES is in-app only)', async () => {
		const u = await makeUser('a@example.com');
		// Even if a channel were configured, defaults enable only in-app.
		vi.spyOn(CHANNELS.email, 'isConfigured').mockReturnValue(true);
		const targets = resolveRecipients(payload({ userId: u.id }));
		expect(targets).toEqual([]);
	});

	it('enqueues a saved+enabled external channel only when isConfigured() is true', async () => {
		const u = await makeUser('b@example.com');
		db.prepare(
			`INSERT INTO notification_preferences (user_id, event_type, channel, enabled)
			 VALUES (?, 'tx_received', 'email', 1)`
		).run(u.id);

		// Not configured yet → no target.
		vi.spyOn(CHANNELS.email, 'isConfigured').mockReturnValue(false);
		expect(resolveRecipients(payload({ userId: u.id }))).toEqual([]);

		// Configured → one target.
		vi.spyOn(CHANNELS.email, 'isConfigured').mockReturnValue(true);
		expect(resolveRecipients(payload({ userId: u.id }))).toEqual([
			{ userId: u.id, channel: 'email' }
		]);
	});

	it('a saved enabled=0 row suppresses a channel the default would have enabled', async () => {
		const u = await makeUser('c@example.com');
		vi.spyOn(CHANNELS.email, 'isConfigured').mockReturnValue(true);
		vi.spyOn(CHANNELS.telegram, 'isConfigured').mockReturnValue(true);
		// Pretend the default for a custom event enables email; user disables it.
		// try/finally so a failed assertion can't leave the shared, exported
		// DEFAULT_PREFERENCES permanently mutated for the rest of the run (cairn-9hq7).
		const original = DEFAULT_PREFERENCES['tx_received'];
		DEFAULT_PREFERENCES['tx_received'] = ['inapp', 'email'];
		try {
			db.prepare(
				`INSERT INTO notification_preferences (user_id, event_type, channel, enabled)
				 VALUES (?, 'tx_received', 'email', 0)`
			).run(u.id);
			const targets = resolveRecipients(payload({ userId: u.id }));
			expect(targets).toEqual([]);
		} finally {
			DEFAULT_PREFERENCES['tx_received'] = original; // restore
		}
	});

	it('userId null fans out to every enabled admin, skipping disabled admins and non-admins', async () => {
		const admin1 = await makeUser('admin1@example.com'); // first user is admin by bootstrap
		const admin2 = await makeUser('admin2@example.com');
		const plainUser = await makeUser('user@example.com');
		setUserAdmin(admin2.id, true);
		// plainUser stays non-admin.

		for (const uid of [admin1.id, admin2.id, plainUser.id]) {
			db.prepare(
				`INSERT INTO notification_preferences (user_id, event_type, channel, enabled)
				 VALUES (?, 'admin_new_signup', 'ntfy', 1)`
			).run(uid);
		}
		vi.spyOn(CHANNELS.ntfy, 'isConfigured').mockReturnValue(true);

		const targets = resolveRecipients(payload({ type: 'admin_new_signup', userId: null }));
		const ids = targets.map((t) => t.userId).sort((a, b) => a - b);
		expect(ids).toEqual([admin1.id, admin2.id].sort((a, b) => a - b));
		expect(targets.every((t) => t.channel === 'ntfy')).toBe(true);
	});

	it('never enqueues the in-app channel', async () => {
		const u = await makeUser('d@example.com');
		// Force every channel configured; in-app has no plugin so it can't appear.
		for (const ch of Object.values(CHANNELS)) vi.spyOn(ch, 'isConfigured').mockReturnValue(true);
		const original = DEFAULT_PREFERENCES['tx_received'];
		DEFAULT_PREFERENCES['tx_received'] = ['inapp', 'email'];
		try {
			const targets = resolveRecipients(payload({ userId: u.id }));
			expect(targets.some((t) => (t.channel as string) === 'inapp')).toBe(false);
			expect(targets).toEqual([{ userId: u.id, channel: 'email' }]);
		} finally {
			DEFAULT_PREFERENCES['tx_received'] = original;
		}
	});
});

describe('backoff schedule', () => {
	it('follows [30s, 2m, 10m, 30m, 2h] and clamps', () => {
		const { backoffMs, BACKOFF_MS } = _internals;
		expect(backoffMs(1)).toBe(30_000);
		expect(backoffMs(2)).toBe(120_000);
		expect(backoffMs(3)).toBe(600_000);
		expect(backoffMs(4)).toBe(1_800_000);
		expect(backoffMs(5)).toBe(7_200_000);
		// Clamps below and above the table.
		expect(backoffMs(0)).toBe(BACKOFF_MS[0]);
		expect(backoffMs(99)).toBe(BACKOFF_MS[BACKOFF_MS.length - 1]);
	});
});

describe('notify() stage isolation (cairn-potk, fix cairn-s0p5)', () => {
	// Pins the fix for cairn-s0p5: notify() used to run the in-app write and the
	// external-channel enqueue inside ONE try/catch, so a failure in the in-app
	// stage silently dropped ALL external delivery. Each stage is now guarded
	// independently — a failure in one must never suppress the other.

	function enableEmail(userId: number): void {
		db.prepare(
			`INSERT INTO notification_preferences (user_id, event_type, channel, enabled)
			 VALUES (?, 'tx_received', 'email', 1)`
		).run(userId);
		vi.spyOn(CHANNELS.email, 'isConfigured').mockReturnValue(true);
	}

	it('an in-app write failure does not drop the external-channel enqueue', async () => {
		const u = await makeUser('iso-a@example.com');
		enableEmail(u.id);
		// Registration itself may record activity — count only notify()'s call.
		vi.mocked(recordActivity).mockClear();
		vi.mocked(recordActivity).mockImplementation(() => {
			throw new Error('events insert exploded');
		});

		expect(() => notify(payload({ userId: u.id }))).not.toThrow();

		// The in-app stage WAS attempted (and blew up) …
		expect(recordActivity).toHaveBeenCalledTimes(1);
		// … yet the external delivery was still enqueued for the queue worker.
		const rows = db
			.prepare('SELECT user_id, channel, event_type FROM notification_queue')
			.all() as { user_id: number; channel: string; event_type: string }[];
		expect(rows).toEqual([{ user_id: u.id, channel: 'email', event_type: 'tx_received' }]);
	});

	it('an external-enqueue failure does not prevent the in-app write', async () => {
		const u = await makeUser('iso-b@example.com');
		db.exec('DELETE FROM events'); // clear any signup noise before asserting
		enableEmail(u.id);
		// Pin the REAL in-app write (don't rely on restoreAllMocks reinstating the
		// call-through implementation after the previous test's throw override).
		const actual = await vi.importActual<typeof import('./activity')>('./activity');
		vi.mocked(recordActivity).mockImplementation(actual.recordActivity);

		// Break the enqueue stage at the DB level: the INSERT INTO
		// notification_queue prepared inside notify() now throws.
		db.exec('ALTER TABLE notification_queue RENAME TO notification_queue_hidden');
		try {
			expect(() => notify(payload({ userId: u.id }))).not.toThrow();
		} finally {
			db.exec('ALTER TABLE notification_queue_hidden RENAME TO notification_queue');
		}

		// The in-app activity-feed record still landed.
		const events = db
			.prepare('SELECT user_id, type, message FROM events WHERE user_id = ?')
			.all(u.id) as { user_id: number; type: string; message: string }[];
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('tx_received');
		expect(events[0].message).toContain('Payment received');
	});
});

describe('notify() persists payload.link into events.detail (cairn-ay45q)', () => {
	// Root cause: notify()'s recordActivity() call only forwarded payload.detail
	// and silently dropped payload.link, so NotificationPanel.svelte's linkFor()
	// — which reads detail.link — never saw a link for any non-tx notification
	// type (sign_session_waiting, cosigner_left, security_new_passkey, ...).

	it('merges payload.link into the persisted detail JSON, alongside existing detail fields', async () => {
		const u = await makeUser('link-a@example.com');
		db.exec('DELETE FROM events');

		notify(
			payload({
				type: 'sign_session_waiting',
				userId: u.id,
				detail: { multisigId: 5, txId: 9 },
				link: '/wallets/multisig/5/send?tx=9'
			})
		);

		const row = db
			.prepare('SELECT detail FROM events WHERE user_id = ? AND type = ?')
			.get(u.id, 'sign_session_waiting') as { detail: string };
		const detail = JSON.parse(row.detail) as Record<string, unknown>;
		expect(detail.link).toBe('/wallets/multisig/5/send?tx=9');
		expect(detail.multisigId).toBe(5);
		expect(detail.txId).toBe(9);
	});

	it('persists a link with no other detail fields', async () => {
		const u = await makeUser('link-b@example.com');
		db.exec('DELETE FROM events');

		notify(payload({ type: 'security_new_passkey', userId: u.id, detail: undefined, link: '/settings/security' }));

		const row = db
			.prepare('SELECT detail FROM events WHERE user_id = ? AND type = ?')
			.get(u.id, 'security_new_passkey') as { detail: string };
		expect(JSON.parse(row.detail)).toEqual({ link: '/settings/security' });
	});

	it('a legacy row written without a link key stays link-less (no crash, no fabricated link)', async () => {
		const u = await makeUser('link-c@example.com');
		db.exec('DELETE FROM events');

		// Simulate a pre-fix row: detail JSON with no "link" key at all, exactly
		// what the old (broken) notify() implementation used to write.
		db.prepare(
			`INSERT INTO events (user_id, type, level, message, detail) VALUES (?, 'sign_session_waiting', 'info', 'legacy', ?)`
		).run(u.id, JSON.stringify({ multisigId: 1, txId: 1, collected: 1, required: 2 }));

		const row = db
			.prepare('SELECT detail FROM events WHERE user_id = ? AND type = ?')
			.get(u.id, 'sign_session_waiting') as { detail: string };
		const detail = JSON.parse(row.detail) as Record<string, unknown>;
		expect(detail.link).toBeUndefined();
	});

	it('no detail and no link persists a null detail column, same as before', async () => {
		const u = await makeUser('link-d@example.com');
		db.exec('DELETE FROM events');

		notify(payload({ type: 'tx_received', userId: u.id, detail: undefined, link: undefined }));

		const row = db
			.prepare('SELECT detail FROM events WHERE user_id = ? AND type = ?')
			.get(u.id, 'tx_received') as { detail: string | null };
		expect(row.detail).toBeNull();
	});
});

describe('token bucket rate limit', () => {
	it('allows a burst up to bucket size then denies until refill', () => {
		const { takeToken, buckets } = _internals;
		buckets.clear();
		const t0 = 1_000_000;
		// Bucket size is 5 — first 5 succeed at the same instant, 6th fails.
		for (let i = 0; i < 5; i++) expect(takeToken('email', t0)).toBe(true);
		expect(takeToken('email', t0)).toBe(false);
		// After ~1s, ~5 tokens refill (5/sec) → allowed again.
		expect(takeToken('email', t0 + 1000)).toBe(true);
		buckets.clear();
	});
});
