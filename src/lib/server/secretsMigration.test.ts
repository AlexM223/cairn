// Pins the startup plaintext-secret re-encryption (cairn-e9mz): legacy rows
// written before at-rest encryption must come out of the migration holding only
// secretKey.ts envelopes, and already-migrated rows must pass through untouched.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting, getSetting } from './settings';
import { encryptSecret, decryptSecret } from './secretKey';
import { migratePlaintextSecretsAtRest } from './secretsMigration';

let userId: number;

function wipe(): void {
	db.exec(
		'DELETE FROM notification_channel_config; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings; DELETE FROM instance_secrets;'
	);
}

/** Raw at-rest form in the typed secrets table (null = no row). */
function rawInstanceSecret(key: string): string | null {
	const row = db.prepare('SELECT value_enc FROM instance_secrets WHERE key = ?').get(key) as
		| { value_enc: string }
		| undefined;
	return row?.value_enc ?? null;
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

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	userId = (
		await registerUser({
			email: 'user@example.com',
			password: 'correct horse battery',
			displayName: 'user'
		})
	).id;
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

describe('migratePlaintextSecretsAtRest — settings → instance_secrets move (cairn-e9mz.3/.4)', () => {
	const KEYS = ['smtp_pass', 'core_rpc_pass', 'telegram_bot_token', 'nostr_sender_privkey'];

	it.each(KEYS)('moves a legacy plaintext %s into instance_secrets, encrypted', (key) => {
		setSetting(key, 'legacy-secret-value');

		migratePlaintextSecretsAtRest();

		expect(getSetting(key)).toBeNull(); // gone from the plain settings table
		const raw = rawInstanceSecret(key)!;
		expect(raw).not.toContain('legacy-secret-value');
		expect(decryptSecret(raw)).toBe('legacy-secret-value');
	});

	it('moves an already-encrypted legacy envelope without re-wrapping it', () => {
		// Exactly what the pre-split (cairn-e9mz.3-era) code stored in `settings`.
		setSetting('smtp_pass', encryptSecret('relay-secret'));
		migratePlaintextSecretsAtRest();
		expect(getSetting('smtp_pass')).toBeNull();
		expect(decryptSecret(rawInstanceSecret('smtp_pass')!)).toBe('relay-secret');
	});

	it('is idempotent, keeps the clear sentinel, and never clobbers a newer instance_secrets row', () => {
		setSetting('smtp_pass', ''); // explicit-clear sentinel, legacy location
		migratePlaintextSecretsAtRest();
		expect(getSetting('smtp_pass')).toBeNull();
		expect(rawInstanceSecret('smtp_pass')).toBe('');

		setSetting('telegram_bot_token', 'BOT:token');
		migratePlaintextSecretsAtRest();
		const first = rawInstanceSecret('telegram_bot_token');
		migratePlaintextSecretsAtRest();
		expect(rawInstanceSecret('telegram_bot_token')).toBe(first);

		// A stale legacy row must not overwrite a value written post-split.
		setSetting('core_rpc_pass', 'stale-old-password');
		db.prepare("INSERT INTO instance_secrets (key, value_enc) VALUES ('core_rpc_pass', ?)").run(
			encryptSecret('current-password')
		);
		migratePlaintextSecretsAtRest();
		expect(getSetting('core_rpc_pass')).toBeNull(); // legacy row still removed
		expect(decryptSecret(rawInstanceSecret('core_rpc_pass')!)).toBe('current-password');
	});

	it('does not touch non-secret settings keys', () => {
		setSetting('smtp_host', 'smtp.example.com');
		migratePlaintextSecretsAtRest();
		expect(getSetting('smtp_host')).toBe('smtp.example.com');
	});
});
