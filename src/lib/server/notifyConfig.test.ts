// cairn-sask: notifyConfig.ts is the single source of truth for stripping
// notification-channel secrets before they reach a browser (settings loader,
// channel API, admin API, account export all funnel through it). Before this
// file, only the ntfy branch was proven (accountExport.test.ts) — a regression
// in the webhook HMAC secret, a personal-SMTP password, or the instance-wide
// SMTP password / Telegram bot token could leak to the client and nothing
// would catch it. This file drives redactChannelConfig() for every
// ConfigurableChannel and getPublicInstanceNotificationSettings() directly,
// asserting the secret value itself is never present anywhere in the output.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { setSetting, setSecretSetting } from './settings';
import { redactChannelConfig, getPublicInstanceNotificationSettings } from './notifyConfig';

beforeEach(() => {
	db.exec('DELETE FROM settings');
	db.exec("DELETE FROM instance_secrets WHERE key LIKE 'smtp_%' OR key LIKE 'telegram_%'");
});

describe('redactChannelConfig: ntfy', () => {
	it('strips the encrypted-at-rest token and exposes only a presence flag', () => {
		const out = redactChannelConfig('ntfy', {
			topic: 'my-topic',
			server: 'https://ntfy.sh',
			accessTokenEnc: 'ENCRYPTED_BLOB_abc123'
		});
		expect(out.accessTokenEnc).toBeUndefined();
		expect(out.accessToken).toBeUndefined();
		expect(out.hasAccessToken).toBe(true);
		expect(out.topic).toBe('my-topic');
		expect(out.server).toBe('https://ntfy.sh');
		expect(JSON.stringify(out)).not.toContain('ENCRYPTED_BLOB_abc123');
	});

	it('strips a legacy plaintext accessToken field the same way', () => {
		const out = redactChannelConfig('ntfy', { topic: 't', accessToken: 'tk_live_secret' });
		expect(out.accessToken).toBeUndefined();
		expect(out.hasAccessToken).toBe(true);
		expect(JSON.stringify(out)).not.toContain('tk_live_secret');
	});

	it('reports no token when neither field is set', () => {
		const out = redactChannelConfig('ntfy', { topic: 't' });
		expect(out.hasAccessToken).toBe(false);
	});
});

describe('redactChannelConfig: webhook', () => {
	it('strips the encrypted-at-rest HMAC secret and exposes only a presence flag', () => {
		const out = redactChannelConfig('webhook', {
			url: 'https://example.com/hook',
			secretEnc: 'ENCRYPTED_HMAC_xyz789'
		});
		expect(out.secretEnc).toBeUndefined();
		expect(out.secret).toBeUndefined();
		expect(out.hasSecret).toBe(true);
		expect(out.url).toBe('https://example.com/hook');
		expect(JSON.stringify(out)).not.toContain('ENCRYPTED_HMAC_xyz789');
	});

	it('strips a legacy plaintext secret field the same way', () => {
		const out = redactChannelConfig('webhook', { url: 'https://x', secret: 'whsec_live_value' });
		expect(out.secret).toBeUndefined();
		expect(out.hasSecret).toBe(true);
		expect(JSON.stringify(out)).not.toContain('whsec_live_value');
	});

	it('reports no secret when neither field is set', () => {
		const out = redactChannelConfig('webhook', { url: 'https://x' });
		expect(out.hasSecret).toBe(false);
	});
});

describe('redactChannelConfig: email (personal SMTP)', () => {
	it("strips the personal relay's encrypted password and exposes smtp.hasPass, preserving the rest of smtp", () => {
		const out = redactChannelConfig('email', {
			address: 'me@example.com',
			smtp: {
				host: 'smtp.personal.example',
				port: 587,
				user: 'me',
				from: 'me@example.com',
				tls: 'starttls',
				passEnc: 'ENCRYPTED_SMTP_PASS_secret'
			}
		});
		expect(out.address).toBe('me@example.com');
		const smtp = out.smtp as Record<string, unknown>;
		expect(smtp.passEnc).toBeUndefined();
		expect(smtp.hasPass).toBe(true);
		expect(smtp.host).toBe('smtp.personal.example');
		expect(smtp.user).toBe('me');
		expect(JSON.stringify(out)).not.toContain('ENCRYPTED_SMTP_PASS_secret');
	});

	it('reports smtp.hasPass=false for a no-auth personal relay (passEnc null)', () => {
		const out = redactChannelConfig('email', {
			smtp: { host: 'smtp.open.example', port: 25, user: null, from: 'a@b.com', tls: 'none', passEnc: null }
		});
		const smtp = out.smtp as Record<string, unknown>;
		expect(smtp.hasPass).toBe(false);
	});

	it('passes through unchanged when no personal smtp block is configured (instance relay only)', () => {
		const cfg = { address: 'me@example.com' };
		const out = redactChannelConfig('email', cfg);
		expect(out).toEqual(cfg);
		expect(out.smtp).toBeUndefined();
	});
});

describe('redactChannelConfig: channels with no per-user secrets', () => {
	it('telegram config (chatId only) passes through unchanged — nothing secret to strip', () => {
		const cfg = { chatId: '123456789' };
		const out = redactChannelConfig('telegram', cfg);
		expect(out).toEqual(cfg);
	});

	it('nostr config (pubkey + relays) passes through unchanged — nothing secret to strip', () => {
		const cfg = { recipientPubkey: 'a'.repeat(64), relays: ['wss://relay.example'] };
		const out = redactChannelConfig('nostr', cfg);
		expect(out).toEqual(cfg);
	});
});

describe('getPublicInstanceNotificationSettings', () => {
	it('never serializes the instance SMTP password, only a presence flag', () => {
		setSetting('smtp_host', 'relay.example.com');
		setSetting('smtp_from', 'noreply@example.com');
		setSecretSetting('smtp_pass', 'S3cretRelayPassword!');

		const out = getPublicInstanceNotificationSettings();
		expect(out.hasSmtpPass).toBe(true);
		expect(out.smtpHost).toBe('relay.example.com');
		expect(JSON.stringify(out)).not.toContain('S3cretRelayPassword!');
		expect(Object.keys(out)).not.toContain('smtpPass');
	});

	it('reports hasSmtpPass=false when no instance SMTP password is set', () => {
		const out = getPublicInstanceNotificationSettings();
		expect(out.hasSmtpPass).toBe(false);
	});

	it('never serializes the Telegram bot token — telegramBotToken is always the empty string', () => {
		setSecretSetting('telegram_bot_token', '123456789:AAFakeBotTokenValueSecret');

		const out = getPublicInstanceNotificationSettings();
		expect(out.hasTelegramBotToken).toBe(true);
		expect(out.telegramBotToken).toBe('');
		expect(JSON.stringify(out)).not.toContain('123456789:AAFakeBotTokenValueSecret');
	});

	it('reports hasTelegramBotToken=false when no bot token is set', () => {
		const out = getPublicInstanceNotificationSettings();
		expect(out.hasTelegramBotToken).toBe(false);
		expect(out.telegramBotToken).toBe('');
	});
});
