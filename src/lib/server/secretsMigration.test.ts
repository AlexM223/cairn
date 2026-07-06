// Pins the startup plaintext-secret re-encryption (cairn-e9mz): legacy rows
// written before at-rest encryption must come out of the migration holding only
// secretKey.ts envelopes, and already-migrated rows must pass through untouched.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { decryptSecret } from './secretKey';
import { migratePlaintextSecretsAtRest } from './secretsMigration';

let userId: number;

function wipe(): void {
	db.exec(
		'DELETE FROM notification_channel_config; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

function saveChannelConfig(channel: string, cfg: Record<string, unknown>): void {
	db.prepare(
		`INSERT INTO notification_channel_config (user_id, channel, config) VALUES (?, ?, ?)`
	).run(userId, channel, JSON.stringify(cfg));
}

function rawChannelConfig(channel: string): string {
	const row = db
		.prepare(`SELECT config FROM notification_channel_config WHERE user_id = ? AND channel = ?`)
		.get(userId, channel) as { config: string } | undefined;
	return row?.config ?? '';
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	userId = registerUser({
		email: 'user@example.com',
		password: 'correct horse battery',
		displayName: 'user'
	}).id;
});

describe('migratePlaintextSecretsAtRest — ntfy access token', () => {
	it('re-encrypts a legacy plaintext accessToken and removes the plaintext key', () => {
		saveChannelConfig('ntfy', { topic: 't', accessToken: 'tk_legacy' });

		migratePlaintextSecretsAtRest();

		const raw = rawChannelConfig('ntfy');
		expect(raw).not.toContain('tk_legacy');
		const cfg = JSON.parse(raw);
		expect(cfg.accessToken).toBeUndefined();
		expect(decryptSecret(cfg.accessTokenEnc)).toBe('tk_legacy');
		expect(cfg.topic).toBe('t'); // non-secret fields untouched
	});

	it('is idempotent — a second run leaves the envelope byte-identical', () => {
		saveChannelConfig('ntfy', { topic: 't', accessToken: 'tk_legacy' });
		migratePlaintextSecretsAtRest();
		const first = rawChannelConfig('ntfy');
		migratePlaintextSecretsAtRest();
		expect(rawChannelConfig('ntfy')).toBe(first);
	});

	it('leaves token-less and already-encrypted configs untouched', () => {
		saveChannelConfig('ntfy', { topic: 'no-token' });
		migratePlaintextSecretsAtRest();
		expect(JSON.parse(rawChannelConfig('ntfy'))).toEqual({ topic: 'no-token' });
	});

	it('re-encrypts a legacy plaintext webhook secret (cairn-e9mz.2)', () => {
		saveChannelConfig('webhook', { url: 'https://example.com/hook', secret: 'legacy-hmac-key' });

		migratePlaintextSecretsAtRest();

		const raw = rawChannelConfig('webhook');
		expect(raw).not.toContain('legacy-hmac-key');
		const cfg = JSON.parse(raw);
		expect(cfg.secret).toBeUndefined();
		expect(decryptSecret(cfg.secretEnc)).toBe('legacy-hmac-key');
		expect(cfg.url).toBe('https://example.com/hook');
	});

	it('skips (and survives) a corrupt config row', () => {
		db.prepare(
			`INSERT INTO notification_channel_config (user_id, channel, config) VALUES (?, 'ntfy', ?)`
		).run(userId, 'not json{');
		expect(() => migratePlaintextSecretsAtRest()).not.toThrow();
		expect(rawChannelConfig('ntfy')).toBe('not json{');
	});
});
