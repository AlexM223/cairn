// One-time re-encryption of secrets that were stored in PLAINTEXT before the
// at-rest encryption work (cairn-e9mz): walks the known plaintext locations and
// rewrites each value as a secretKey.ts envelope. Runs at server start from
// hooks.server.ts — deliberately NOT from db.ts, whose top-level migration block
// runs while secretKey.ts (which imports DB_PATH back from db.ts) may still be
// mid-initialization; a separate module imported after both breaks that cycle.
//
// Idempotent by construction: a migrated row no longer matches the plaintext
// shape, so re-running is a cheap no-op. Per-row failures are logged and
// skipped — a single corrupt config row must not block server start.

import { db } from './db';
import { childLogger } from './logger';
import { encryptSecret, isSecretEnvelope } from './secretKey';
import { getSetting, setSetting } from './settings';

const log = childLogger('secrets-migration');

/** Instance-wide `settings` keys that must hold envelopes, not plaintext. */
const SECRET_SETTINGS_KEYS = ['smtp_pass', 'core_rpc_pass', 'telegram_bot_token'];

function migrateSecretSettings(): void {
	for (const key of SECRET_SETTINGS_KEYS) {
		try {
			const raw = getSetting(key);
			if (!raw || isSecretEnvelope(raw)) continue;
			setSetting(key, encryptSecret(raw));
			log.info({ key }, 'migrated settings secret to encrypted-at-rest storage');
		} catch (e) {
			log.error({ err: e, key }, 'failed to migrate a settings secret — value left as-is');
		}
	}
}

/** channel → { plaintext field → encrypted field } in notification_channel_config. */
const CHANNEL_SECRET_FIELDS: Record<string, Record<string, string>> = {
	ntfy: { accessToken: 'accessTokenEnc' },
	webhook: { secret: 'secretEnc' }
};

function migrateChannelConfigs(): void {
	const channels = Object.keys(CHANNEL_SECRET_FIELDS);
	const rows = db
		.prepare(
			`SELECT user_id, channel, config FROM notification_channel_config
			  WHERE channel IN (${channels.map(() => '?').join(', ')})`
		)
		.all(...channels) as { user_id: number; channel: string; config: string }[];

	for (const row of rows) {
		try {
			const cfg = JSON.parse(row.config) as Record<string, unknown>;
			if (!cfg || typeof cfg !== 'object') continue;

			let changed = false;
			for (const [plainField, encField] of Object.entries(CHANNEL_SECRET_FIELDS[row.channel])) {
				const plain = cfg[plainField];
				if (typeof plain !== 'string' || plain === '') continue;
				cfg[encField] = encryptSecret(plain);
				delete cfg[plainField];
				changed = true;
			}
			if (!changed) continue;

			db.prepare(
				`UPDATE notification_channel_config SET config = ? WHERE user_id = ? AND channel = ?`
			).run(JSON.stringify(cfg), row.user_id, row.channel);
			log.info(
				{ userId: row.user_id, channel: row.channel },
				'migrated channel secret to encrypted-at-rest storage'
			);
		} catch (e) {
			log.error(
				{ err: e, userId: row.user_id, channel: row.channel },
				'failed to migrate a channel secret — row left as-is'
			);
		}
	}
}

/**
 * Re-encrypt every known legacy plaintext secret. Safe to call on every boot;
 * never throws (per-location failures are logged and skipped).
 */
export function migratePlaintextSecretsAtRest(): void {
	try {
		migrateChannelConfigs();
	} catch (e) {
		log.error({ err: e }, 'channel-config secret migration failed');
	}
	try {
		migrateSecretSettings();
	} catch (e) {
		log.error({ err: e }, 'settings-table secret migration failed');
	}
}
