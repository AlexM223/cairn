// src/lib/server/miningDefaultMigration.ts
//
// One-time decision to default the solo-mining feature off — the same
// soft-launch shape as explorerDefaultMigration.ts, for the same reason:
// `resolveAllFlags()`/`isFeatureEnabled()` (resolve.ts) always resolves an unset
// flag to the registry's `defaultEnabled: true` (a compiler-enforced guarantee —
// see registry.ts's comment — that a flag can never ship pre-disabled), so there
// is no way to make an install start with mining hidden without an explicit DB
// row. This migration writes that one row whenever the `mining` flag has NO row
// at all — covering a genuinely new install AND an upgrade from a version that
// predates the mining feature, both of which are still in the soft launch's
// "mining stays hidden until an operator opts in" state.
//
// It writes the off-row REGARDLESS of user count. The first version gated on
// `userCount() === 0` and so silently did nothing on an upgraded install (which
// by construction already has >=1 user by the time it runs this new code),
// leaving the flag unset -> registry default `true` -> the mining UI exposed to
// every upgraded user, contradicting the soft launch (cairn-guvu). The
// load-bearing invariant is the ROW check, not the user count: an install that
// already carries a `mining` row — written by this migration on a prior boot, or
// by an admin explicitly toggling the flag either way — has made its decision and
// must never be disturbed.
//
// Mirrors explorerDefaultMigration.ts's shape deliberately: runs once at server
// start from hooks.server.ts, is idempotent by construction (once a
// `feature_flags` row for 'mining' exists — whether written by this migration or
// by an admin explicitly toggling it in /admin/feature-flags — this is a no-op
// forever), and never throws. Unlike the first version it is order-independent
// relative to bootstrapAdminFromEnv(): the row check does not care whether users
// exist yet.

import { db } from './db';
import { setGlobalFlag } from './featureFlags/admin';
import { childLogger } from './logger';

const log = childLogger('mining-default-migration');

function hasMiningFlagRow(): boolean {
	return db.prepare('SELECT 1 FROM feature_flags WHERE key = ?').get('mining') !== undefined;
}

/**
 * Default solo-mining off whenever the `mining` flag has no explicit row yet —
 * on both fresh and upgraded installs, so the soft launch holds across the
 * upgrade path (cairn-guvu). An install that already carries a `mining` row
 * (written by this migration on a prior boot, or by an admin explicitly toggling
 * the flag either way) is left completely untouched. Never throws.
 */
export function migrateMiningDefault(): void {
	try {
		if (hasMiningFlagRow()) return; // already decided — by this migration or an admin

		setGlobalFlag('mining', false, null);
		log.info(
			{ event: 'mining_defaulted_off' },
			'no mining flag row: solo-mining defaulted off (soft launch, epic cairn-vn43)'
		);
	} catch (e) {
		log.error({ err: e }, 'mining default migration failed');
	}
}
