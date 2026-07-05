import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setUserAdmin } from './admin';
import { setSetting } from './settings';
import { resolveRecipients, DEFAULT_PREFERENCES, CHANNELS } from './notifications';
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
	it('returns no external targets by default (DEFAULT_PREFERENCES is in-app only)', () => {
		const u = makeUser('a@example.com');
		// Even if a channel were configured, defaults enable only in-app.
		vi.spyOn(CHANNELS.email, 'isConfigured').mockReturnValue(true);
		const targets = resolveRecipients(payload({ userId: u.id }));
		expect(targets).toEqual([]);
	});

	it('enqueues a saved+enabled external channel only when isConfigured() is true', () => {
		const u = makeUser('b@example.com');
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

	it('a saved enabled=0 row suppresses a channel the default would have enabled', () => {
		const u = makeUser('c@example.com');
		vi.spyOn(CHANNELS.email, 'isConfigured').mockReturnValue(true);
		vi.spyOn(CHANNELS.telegram, 'isConfigured').mockReturnValue(true);
		// Pretend the default for a custom event enables email; user disables it.
		DEFAULT_PREFERENCES['tx_received'] = ['inapp', 'email'];
		db.prepare(
			`INSERT INTO notification_preferences (user_id, event_type, channel, enabled)
			 VALUES (?, 'tx_received', 'email', 0)`
		).run(u.id);
		const targets = resolveRecipients(payload({ userId: u.id }));
		expect(targets).toEqual([]);
		DEFAULT_PREFERENCES['tx_received'] = ['inapp']; // restore
	});

	it('userId null fans out to every enabled admin, skipping disabled admins and non-admins', () => {
		const admin1 = makeUser('admin1@example.com'); // first user is admin by bootstrap
		const admin2 = makeUser('admin2@example.com');
		const plainUser = makeUser('user@example.com');
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

	it('never enqueues the in-app channel', () => {
		const u = makeUser('d@example.com');
		// Force every channel configured; in-app has no plugin so it can't appear.
		for (const ch of Object.values(CHANNELS)) vi.spyOn(ch, 'isConfigured').mockReturnValue(true);
		DEFAULT_PREFERENCES['tx_received'] = ['inapp', 'email'];
		const targets = resolveRecipients(payload({ userId: u.id }));
		expect(targets.some((t) => (t.channel as string) === 'inapp')).toBe(false);
		expect(targets).toEqual([{ userId: u.id, channel: 'email' }]);
		DEFAULT_PREFERENCES['tx_received'] = ['inapp'];
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
