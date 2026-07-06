// Integration coverage for the notification queue worker's state machine
// (processRow/tick), which had NO test coverage before this file — only the
// pure helpers (backoffMs, takeToken) were tested. This exercises the real
// path: notify() enqueues rows, tick() drains them through the REAL channel
// plugins (with each channel's outbound transport mocked at the network edge,
// same as each channel's own unit tests), and asserts the queue row's status
// transitions match the plugin's ChannelSendResult.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { notify } from './notifications';
import { _internals } from './notificationQueue';
import { _transport } from './channels/ssrf';

// The ntfy/webhook channels resolve their target host through node:dns/promises
// before pinning the socket; mock it so the SSRF gate is deterministic and does
// no real lookup for the example hosts used here.
const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
	lookup: (...args: unknown[]) => lookupMock(...args)
}));

const { tick } = _internals;

// Mock nodemailer (used by the email channel) the same way email.test.ts does.
const { sendMail, createTransport } = vi.hoisted(() => {
	const sendMail = vi.fn<(opts: unknown) => Promise<unknown>>();
	const close = vi.fn();
	const createTransport = vi.fn(() => ({ sendMail, close }));
	return { sendMail, createTransport };
});
vi.mock('nodemailer', () => ({ default: { createTransport } }));

function wipe(): void {
	db.exec(
		`DELETE FROM notification_queue; DELETE FROM notification_preferences;
		 DELETE FROM notification_channel_config; DELETE FROM sessions;
		 DELETE FROM users; DELETE FROM settings;`
	);
}

function enableChannel(userId: number, eventType: string, channel: string): void {
	db.prepare(
		`INSERT INTO notification_preferences (user_id, event_type, channel, enabled)
		 VALUES (?, ?, ?, 1)`
	).run(userId, eventType, channel);
}

function queueRows(): Array<{ status: string; channel: string; attempts: number; last_error: string | null }> {
	return db
		.prepare('SELECT status, channel, attempts, last_error FROM notification_queue ORDER BY id')
		.all() as never;
}

let userId: number;

beforeEach(() => {
	wipe();
	vi.clearAllMocks();
	// The rate-limit token buckets are a module-level singleton (by design —
	// see notificationQueue.ts) and would otherwise leak state across tests.
	_internals.buckets.clear();
	setSetting('registration_mode', 'open');
	userId = registerUser({
		email: 'user@example.com',
		password: 'correct horse battery',
		displayName: 'user'
	}).id;
	sendMail.mockResolvedValue({ messageId: '<ok>' });
});

describe('notify() -> queue -> tick() end-to-end', () => {
	it('marks a row sent when the channel plugin succeeds', async () => {
		setSetting('smtp_host', 'smtp.example.com');
		setSetting('smtp_from', 'cairn@example.com');
		enableChannel(userId, 'tx_received', 'email');

		notify({ type: 'tx_received', userId, level: 'info', title: 'Payment received', body: '0.01 BTC' });
		expect(queueRows()).toHaveLength(1);
		expect(queueRows()[0].status).toBe('pending');

		await tick();

		const rows = queueRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('sent');
		expect(sendMail).toHaveBeenCalledTimes(1);
	});

	it('marks a row failed (not retried) on a non-retryable error', async () => {
		// SMTP IS configured (so isConfigured() is true and the row gets
		// enqueued), but the send itself fails with a config error (bad auth) —
		// classified non-retryable by the channel plugin.
		setSetting('smtp_host', 'smtp.example.com');
		setSetting('smtp_from', 'cairn@example.com');
		enableChannel(userId, 'tx_received', 'email');
		sendMail.mockRejectedValue(Object.assign(new Error('bad auth'), { code: 'EAUTH' }));

		notify({ type: 'tx_received', userId, level: 'info', title: 'Payment received', body: '0.01 BTC' });
		await tick();

		const rows = queueRows();
		expect(rows[0].status).toBe('failed');
		expect(rows[0].last_error).toMatch(/bad auth/);
		expect(sendMail).toHaveBeenCalledTimes(1);
	});

	it('schedules a retry (stays pending, attempts++) on a retryable error, then goes dead after MAX_ATTEMPTS', async () => {
		setSetting('smtp_host', 'smtp.example.com');
		setSetting('smtp_from', 'cairn@example.com');
		enableChannel(userId, 'tx_received', 'email');
		sendMail.mockRejectedValue(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));

		notify({ type: 'tx_received', userId, level: 'info', title: 'Payment received', body: '0.01 BTC' });

		// Force next_attempt_at into the past on every retry so consecutive
		// tick() calls in this test don't have to wait on real backoff timers.
		for (let i = 0; i < _internals.MAX_ATTEMPTS; i++) {
			db.prepare(
				`UPDATE notification_queue SET next_attempt_at = '2000-01-01T00:00:00.000Z'`
			).run();
			await tick();
		}

		const rows = queueRows();
		expect(rows[0].status).toBe('dead');
		expect(rows[0].attempts).toBe(_internals.MAX_ATTEMPTS);
		expect(sendMail).toHaveBeenCalledTimes(_internals.MAX_ATTEMPTS);
	});

	it('only enqueues/sends the channel the user actually enabled (preference gating)', async () => {
		setSetting('smtp_host', 'smtp.example.com');
		setSetting('smtp_from', 'cairn@example.com');
		setSetting('ntfy_default_server', 'https://ntfy.sh');

		// email explicitly disabled, ntfy explicitly enabled.
		db.prepare(
			`INSERT INTO notification_preferences (user_id, event_type, channel, enabled) VALUES (?, 'tx_large', 'email', 0)`
		).run(userId);
		enableChannel(userId, 'tx_large', 'ntfy');
		db.prepare(
			`INSERT INTO notification_channel_config (user_id, channel, config) VALUES (?, 'ntfy', ?)`
		).run(userId, JSON.stringify({ topic: 'my-topic' }));

		// ntfy delivers through the pinned-socket transport; mock it (and DNS) so no
		// real network is touched, mirroring the channel's own unit test.
		lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
		const sendMock = vi
			.spyOn(_transport, 'pinnedRequest')
			.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' });
		try {
			notify({ type: 'tx_large', userId, level: 'warn', title: 'Large payment', body: '1.5 BTC' });

			const rows = queueRows();
			expect(rows).toHaveLength(1);
			expect(rows[0].channel).toBe('ntfy');

			await tick();
			expect(sendMock).toHaveBeenCalledTimes(1);
			expect(sendMail).not.toHaveBeenCalled();
			expect(queueRows()[0].status).toBe('sent');
		} finally {
			sendMock.mockRestore();
		}
	});

	it('does not enqueue anything for an event type/channel that is not configured', async () => {
		// email preference enabled, but SMTP never configured on the instance ->
		// isConfigured() is false -> resolveRecipients() must not emit a target.
		enableChannel(userId, 'tx_received', 'email');
		notify({ type: 'tx_received', userId, level: 'info', title: 'Payment received', body: '0.01 BTC' });
		expect(queueRows()).toHaveLength(0);
	});
});
