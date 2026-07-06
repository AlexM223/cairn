import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the transport before importing the channel: nodemailer.createTransport
// returns a stub whose sendMail we control per-test. vi.hoisted lets the mocked
// spies be referenced from the hoisted vi.mock factory below.
const { sendMail, createTransport } = vi.hoisted(() => {
	const sendMail = vi.fn<(opts: unknown) => Promise<unknown>>();
	const close = vi.fn();
	const createTransport = vi.fn((_opts: unknown) => ({ sendMail, close }));
	return { sendMail, createTransport };
});
vi.mock('nodemailer', () => ({ default: { createTransport } }));

import { db } from '../db';
import { registerUser } from '../auth';
import { setSetting } from '../settings';
import { encryptSecret } from '../secretKey';
import emailChannel from './email';
import type { NotificationPayload } from '../notifyTypes';

function wipe(): void {
	db.exec(
		'DELETE FROM notification_channel_config; DELETE FROM user_pgp_keys; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings; DELETE FROM instance_secrets;'
	);
}

let userId: number;

const PAYLOAD: NotificationPayload = {
	type: 'tx_received',
	userId: null,
	level: 'info',
	title: 'Payment received',
	body: '0.01 BTC to Savings',
	link: '/wallets/3'
};

function configureSmtp(): void {
	setSetting('smtp_host', 'smtp.example.com');
	setSetting('smtp_port', '587');
	setSetting('smtp_user', 'relay@example.com');
	setSetting('smtp_pass', 'hunter2');
	setSetting('smtp_from', 'cairn@example.com');
	setSetting('smtp_tls', 'starttls');
}

beforeEach(() => {
	wipe();
	vi.clearAllMocks();
	setSetting('registration_mode', 'open');
	const user = registerUser({
		email: 'user@example.com',
		password: 'correct horse battery',
		displayName: 'user'
	});
	userId = user.id;
	sendMail.mockResolvedValue({ messageId: '<ok>' });
});

describe('isConfigured', () => {
	it('is false with no SMTP configured', () => {
		expect(emailChannel.isConfigured(userId)).toBe(false);
	});

	it('is true once SMTP is set and the account email resolves as destination', () => {
		configureSmtp();
		expect(emailChannel.isConfigured(userId)).toBe(true);
	});
});

/** Save a personal SMTP relay for the user (password encrypted at rest). */
function savePersonalSmtp(pass: string | null, extra: Record<string, unknown> = {}): void {
	const smtp = {
		host: 'personal.smtp.example.com',
		port: 2525,
		user: 'me@personal.example.com',
		from: 'me@personal.example.com',
		tls: 'starttls',
		passEnc: pass === null ? null : encryptSecret(pass),
		...extra
	};
	db.prepare(
		`INSERT INTO notification_channel_config (user_id, channel, config)
		 VALUES (?, 'email', ?)
		 ON CONFLICT(user_id, channel) DO UPDATE SET config = excluded.config`
	).run(userId, JSON.stringify({ smtp }));
}

describe('send', () => {
	it('returns a non-retryable error when SMTP is not configured', async () => {
		const res = await emailChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
		expect(res.error).toContain('No SMTP configured');
		expect(sendMail).not.toHaveBeenCalled();
	});

	it('sends to the account email by default and appends the link', async () => {
		configureSmtp();
		const res = await emailChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(true);
		expect(sendMail).toHaveBeenCalledTimes(1);
		const opts = sendMail.mock.calls[0][0] as {
			to: string;
			subject: string;
			text: string;
			from: string;
		};
		expect(opts.to).toBe('user@example.com');
		expect(opts.from).toBe('cairn@example.com');
		expect(opts.subject).toBe('Payment received');
		expect(opts.text).toContain('0.01 BTC to Savings');
		expect(opts.text).toContain('/wallets/3');
	});

	it('honours an explicit per-user address override', async () => {
		configureSmtp();
		db.prepare(
			`INSERT INTO notification_channel_config (user_id, channel, config) VALUES (?, 'email', ?)`
		).run(userId, JSON.stringify({ address: 'alt@example.com' }));
		await emailChannel.send(userId, PAYLOAD);
		const opts = sendMail.mock.calls[0][0] as { to: string };
		expect(opts.to).toBe('alt@example.com');
	});

	it('classifies an SMTP auth failure as non-retryable', async () => {
		configureSmtp();
		sendMail.mockRejectedValueOnce(Object.assign(new Error('bad auth'), { code: 'EAUTH' }));
		const res = await emailChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
		expect(res.error).toContain('bad auth');
	});

	it('classifies a connection timeout as retryable', async () => {
		configureSmtp();
		sendMail.mockRejectedValueOnce(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
		const res = await emailChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(true);
	});
});

describe('per-user SMTP resolution (cairn-l512.2)', () => {
	it('routes through the user personal relay even when instance SMTP is also set', async () => {
		configureSmtp(); // instance relay present
		savePersonalSmtp('personal-pass');
		const res = await emailChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(true);
		const opts = createTransport.mock.calls.at(-1)![0] as {
			host: string;
			port: number;
			auth?: { user: string; pass: string };
		};
		// Personal relay wins over the instance relay.
		expect(opts.host).toBe('personal.smtp.example.com');
		expect(opts.port).toBe(2525);
		// The stored password is decrypted for the actual send.
		expect(opts.auth?.pass).toBe('personal-pass');
	});

	it('falls back to instance SMTP when the user has no personal relay', async () => {
		configureSmtp();
		const res = await emailChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(true);
		const opts = createTransport.mock.calls.at(-1)![0] as { host: string };
		expect(opts.host).toBe('smtp.example.com'); // the instance host
	});

	it('supports a no-auth personal relay (no user, passEnc null)', async () => {
		savePersonalSmtp(null, { user: null });
		const res = await emailChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(true);
		const opts = createTransport.mock.calls.at(-1)![0] as { auth?: unknown };
		expect(opts.auth).toBeUndefined();
	});

	it('returns a clear non-retryable error (no throw) when the saved password is corrupt', async () => {
		// A row whose passEnc is not a valid envelope — decryptSecret will throw
		// inside resolution; the channel must translate that, not crash the tick.
		db.prepare(
			`INSERT INTO notification_channel_config (user_id, channel, config) VALUES (?, 'email', ?)`
		).run(
			userId,
			JSON.stringify({
				smtp: {
					host: 'personal.smtp.example.com',
					port: 2525,
					user: 'me@personal.example.com',
					from: 'me@personal.example.com',
					tls: 'starttls',
					passEnc: 'this-is-not-a-valid-envelope'
				}
			})
		);
		const res = await emailChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
		expect(res.error).toMatch(/could not be read/i);
		expect(sendMail).not.toHaveBeenCalled();
	});

	it('isConfigured is true from a personal relay alone (no instance SMTP), without decrypting', () => {
		savePersonalSmtp('personal-pass');
		expect(emailChannel.isConfigured(userId)).toBe(true);
	});
});

describe('PGP encryption', () => {
	// A real, small ECC public key generated for this test so openpgp.encrypt runs
	// the true path rather than a mock.
	it('encrypts the body and keeps the subject generic when a key is on file', async () => {
		const openpgp = await import('openpgp');
		const { publicKey } = await openpgp.generateKey({
			type: 'ecc',
			curve: 'curve25519' as never,
			userIDs: [{ name: 'User', email: 'user@example.com' }],
			format: 'armored'
		});
		configureSmtp();
		db.prepare(
			'INSERT INTO user_pgp_keys (user_id, public_key, fingerprint) VALUES (?, ?, ?)'
		).run(userId, publicKey, 'deadbeef');

		const res = await emailChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(true);
		const opts = sendMail.mock.calls[0][0] as { subject: string; text: string };
		expect(opts.subject).toBe('Cairn notification');
		expect(opts.text).toContain('BEGIN PGP MESSAGE');
		expect(opts.text).not.toContain('0.01 BTC to Savings');
	});

	it('fails non-retryably on an unreadable PGP key rather than sending plaintext', async () => {
		configureSmtp();
		db.prepare(
			'INSERT INTO user_pgp_keys (user_id, public_key, fingerprint) VALUES (?, ?, ?)'
		).run(userId, 'not a real key', 'deadbeef');
		const res = await emailChannel.send(userId, PAYLOAD);
		expect(res.ok).toBe(false);
		expect(res.retryable).toBe(false);
		expect(sendMail).not.toHaveBeenCalled();
	});
});

describe('test()', () => {
	it('sends a canned message through the same path', async () => {
		configureSmtp();
		const res = await emailChannel.test(userId);
		expect(res.ok).toBe(true);
		const opts = sendMail.mock.calls[0][0] as { subject: string };
		expect(opts.subject).toContain('Test notification');
	});
});
