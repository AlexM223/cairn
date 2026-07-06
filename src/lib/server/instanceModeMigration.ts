// One-time decision of instanceMode for installs that predate the setting
// (docs/SOLO-MODE-UMBREL-AUTOADMIN-PLAN.md Part 2). Runs at server start from
// hooks.server.ts, right after bootstrapAdminFromEnv() so a freshly-bootstrapped
// single admin is already counted.
//
// Idempotent by construction: once an `instance_mode` row exists — whether
// written by this migration or by an admin explicitly toggling "Unlock team
// features" — this is a no-op forever. That also means the decision never
// gets re-evaluated after an explicit toggle; an admin who unlocks team mode
// and later deletes their only cosigner's contact must not get silently
// narrowed back to solo on the next restart.

import { db } from './db';
import { getSetting, setSetting } from './settings';
import { childLogger } from './logger';

const log = childLogger('instance-mode-migration');

function count(table: string): number {
	return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/**
 * Decide and persist instanceMode for an install that doesn't have one yet.
 * New install (0-1 users, no collaboration data) → 'solo'. An install that
 * already shows evidence of multi-user usage → 'team', so upgrading never
 * hides a surface an existing operator relies on. Never throws.
 */
export function migrateInstanceMode(): void {
	try {
		if (getSetting('instance_mode') !== null) return;

		const users = count('users');
		const shares = count('multisig_shares');
		const invites = count('invites');
		const contacts = count('contacts');
		const mode = users > 1 || shares > 0 || invites > 0 || contacts > 0 ? 'team' : 'solo';

		setSetting('instance_mode', mode);
		log.info({ mode, users, shares, invites, contacts }, 'instance mode decided');
	} catch (e) {
		log.error({ err: e }, 'instance mode migration failed');
	}
}
