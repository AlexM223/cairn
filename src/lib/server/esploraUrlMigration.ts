// src/lib/server/esploraUrlMigration.ts
//
// One-time cleanup of the `esplora_url` settings row after the Esplora backend
// was removed entirely (cairn-zoz8.16). Esplora was Cairn's old third-party HTTP
// explorer fallback; the explorer now runs purely on the operator's own Electrum
// server + Bitcoin Core RPC, and nothing reads `esplora_url` any more. An install
// upgraded from a version that stored one is left with a dead row in the
// `settings` table — harmless (getChainConfig no longer looks at it), but it
// lingers as confusing dead data and would round-trip through a settings export.
// This drops it once, at startup.
//
// Mirrors the shape of the other startup migrations (explorerDefaultMigration.ts,
// instanceModeMigration.ts): runs once from hooks.server.ts's init(), is
// idempotent by construction (a DELETE of an absent row is a no-op), and never
// throws — a cleanup failure must never keep the app from booting.

import { db } from './db';
import { childLogger } from './logger';

const log = childLogger('esplora-url-migration');

/**
 * Delete the now-dead `esplora_url` row from the settings table if present.
 * Idempotent and non-throwing. Only touches this one key — never any live chain
 * setting.
 */
export function migrateDropEsploraUrl(): void {
	try {
		const info = db.prepare('DELETE FROM settings WHERE key = ?').run('esplora_url');
		if (info.changes > 0) {
			log.info({ event: 'esplora_url_dropped' }, 'removed dead esplora_url setting (cairn-zoz8.16)');
		}
	} catch (e) {
		log.error({ err: e }, 'esplora_url cleanup migration failed');
	}
}
