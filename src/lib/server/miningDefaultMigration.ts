// src/lib/server/miningDefaultMigration.ts
//
// One-time decision to default the solo-mining feature off for genuinely new
// installs — the same soft-launch shape as explorerDefaultMigration.ts, for
// the same reason: `resolveAllFlags()`/`isFeatureEnabled()` (resolve.ts)
// always resolves an unset flag to the registry's `defaultEnabled: true` (a
// compiler-enforced guarantee — see registry.ts's comment — that a flag can
// never ship pre-disabled), so there is no way to make a fresh install start
// with mining hidden without an explicit DB row. This migration writes that
// one row, but ONLY when the database has never had a single user — i.e.
// before bootstrapAdminFromEnv() or an interactive first registration creates
// one — so an existing install (which by construction already has >=1 user by
// the time it runs this new code, post-upgrade) is never touched.
//
// Mirrors explorerDefaultMigration.ts's shape deliberately: runs once at
// server start from hooks.server.ts, is idempotent by construction (once a
// `feature_flags` row for 'mining' exists — whether written by this migration
// or by an admin explicitly toggling it in /admin/feature-flags — this is a
// no-op forever), and never throws.
//
// ORDERING: like migrateExplorerDefault(), this must run BEFORE
// bootstrapAdminFromEnv() — its "genuinely new install" test is a literal
// zero-user database. See hooks.server.ts's init() for the call site.

import { db } from './db';
import { setGlobalFlag } from './featureFlags/admin';
import { childLogger } from './logger';

const log = childLogger('mining-default-migration');

function userCount(): number {
	return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

function hasMiningFlagRow(): boolean {
	return db.prepare('SELECT 1 FROM feature_flags WHERE key = ?').get('mining') !== undefined;
}

/**
 * Decide whether a genuinely fresh install should default solo-mining off.
 * Must run before any user row can exist — a database that already has a
 * user by the time this runs is, by definition, not what this migration means
 * by "new," and is left completely untouched (existing installs keep the
 * registry default of `true` forever unless an admin explicitly changes it).
 * Never throws.
 */
export function migrateMiningDefault(): void {
	try {
		if (hasMiningFlagRow()) return; // already decided — by this migration or an admin
		if (userCount() > 0) return; // pre-existing install — never disrupt it

		setGlobalFlag('mining', false, null);
		log.info(
			{ event: 'mining_defaulted_off' },
			'fresh install: solo-mining defaulted off (soft launch, epic cairn-vn43)'
		);
	} catch (e) {
		log.error({ err: e }, 'mining default migration failed');
	}
}
