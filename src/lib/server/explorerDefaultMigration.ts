// src/lib/server/explorerDefaultMigration.ts
//
// One-time decision for the in-app block explorer's fresh-install default.
// UX Simplification Wave 3 (cairn-6c91u.3, docs/UX-SIMPLIFICATION-SPEC.md §6,
// decision pending Alex confirmation — reversible any time via Settings →
// Explorer) FLIPS this to ON: the own-node explorer is the sovereignty
// payoff, needs zero operator config, and its tx-detail is already app-wide —
// high showcase value, low newcomer risk. This supersedes the original UX
// Wave A decision (docs/UX-PLAN.md) to default it OFF. The nav
// (`(app)/+layout.svelte`) and the home mempool/next-block strip
// (`(app)/+page.svelte`) already hide/show themselves off `flags.explorer !==
// false` — that hook predates this file and is unchanged. The problem this
// file solves: `resolveAllFlags()`/`isFeatureEnabled()` (resolve.ts) always
// resolve an unset flag to the registry's `defaultEnabled: true` default —
// which happens to already be the answer we now want for a fresh install, so
// this migration's only remaining job is to write that decision down
// EXPLICITLY as a row (for audit-trail parity with the mining migration and
// so a later registry default change can never silently move a fresh
// install's resolved value), and to do so ONLY when the database has never
// had a single user — i.e. before bootstrapAdminFromEnv() or an interactive
// first registration creates one — so an existing install (which by
// construction already has >=1 user by the time it runs this new code,
// post-upgrade) is never touched, and any install that previously stored an
// explicit OFF row (whether from this migration's old behavior or an admin's
// own choice) is never overwritten (R14 guard, spec §11).
//
// Mirrors instanceModeMigration.ts's shape deliberately: runs once at server
// start from hooks.server.ts, is idempotent by construction (once a
// `feature_flags` row for 'explorer' exists — whether written by this
// migration or by an admin explicitly toggling it in Settings → Explorer —
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
 * on. Must run before any user row can exist — a database that already has a
 * user by the time this runs is, by definition, not what this migration means
 * by "new," and is left completely untouched. An existing install that
 * already carries an explicit `explorer` row (ON or OFF — from this
 * migration's prior run, an admin's own toggle, or a restored/provisioned
 * config) is never touched either way (cairn-6c91u.3 R14 guard). Never throws.
 */
export function migrateExplorerDefault(): void {
	try {
		if (hasExplorerFlagRow()) return; // already decided — by this migration or an admin
		if (userCount() > 0) return; // pre-existing install — never disrupt it

		setGlobalFlag('explorer', true, null);
		log.info(
			{ event: 'explorer_defaulted_on' },
			'fresh install: block explorer defaulted on (UX Simplification Wave 3, cairn-6c91u.3)'
		);
	} catch (e) {
		log.error({ err: e }, 'explorer default migration failed');
	}
}
