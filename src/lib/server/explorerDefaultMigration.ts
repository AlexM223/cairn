// src/lib/server/explorerDefaultMigration.ts
//
// One-time decision to default the in-app block explorer off for genuinely new
// installs (UX Wave A, docs/UX-PLAN.md — "declutter the newcomer's default
// surface"). The nav (`(app)/+layout.svelte`) and the home mempool/next-block
// strip (`(app)/+page.svelte`) already hide themselves whenever
// `flags.explorer !== false` — that hook predates this file. The problem this
// file solves: `resolveAllFlags()`/`isFeatureEnabled()` (resolve.ts) always
// resolve an unset flag to the registry's `defaultEnabled: true` (a
// compiler-enforced guarantee — see registry.ts's comment — that a flag can
// never ship pre-disabled), so there is no way to make a fresh install start
// with the explorer hidden without an explicit DB row. This migration writes
// that one row, but ONLY when the database has never had a single user — i.e.
// before bootstrapAdminFromEnv() or an interactive first registration creates
// one — so an existing install (which by construction already has >=1 user by
// the time it runs this new code, post-upgrade) is never touched.
//
// Mirrors instanceModeMigration.ts's shape deliberately: runs once at server
// start from hooks.server.ts, is idempotent by construction (once a
// `feature_flags` row for 'explorer' exists — whether written by this
// migration or by an admin explicitly toggling it in /admin/feature-flags —
// this is a no-op forever), and never throws.
//
// ORDERING (important): unlike migrateInstanceMode() (which intentionally runs
// AFTER bootstrapAdminFromEnv() so a freshly-bootstrapped solo admin is already
// counted), this migration must run BEFORE bootstrapAdminFromEnv() — its
// "genuinely new install" test is a literal zero-user database, not "one solo
// admin and no team data." See hooks.server.ts's init() for the call site.

import { db } from './db';
import { setGlobalFlag } from './featureFlags/admin';
import { childLogger } from './logger';

const log = childLogger('explorer-default-migration');

function userCount(): number {
	return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

function hasExplorerFlagRow(): boolean {
	return db.prepare('SELECT 1 FROM feature_flags WHERE key = ?').get('explorer') !== undefined;
}

/**
 * Decide whether a genuinely fresh install should default the block explorer
 * off. Must run before any user row can exist — a database that already has a
 * user by the time this runs is, by definition, not what this migration means
 * by "new," and is left completely untouched (existing installs keep the
 * registry default of `true` forever unless an admin explicitly changes it).
 * Never throws.
 */
export function migrateExplorerDefault(): void {
	try {
		if (hasExplorerFlagRow()) return; // already decided — by this migration or an admin
		if (userCount() > 0) return; // pre-existing install — never disrupt it

		setGlobalFlag('explorer', false, null);
		log.info(
			{ event: 'explorer_defaulted_off' },
			'fresh install: block explorer defaulted off (UX Wave A)'
		);
	} catch (e) {
		log.error({ err: e }, 'explorer default migration failed');
	}
}
