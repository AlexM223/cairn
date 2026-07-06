// src/lib/server/featureFlags/admin.ts
//
// Write/read helpers for the admin feature-flag UIs (global toggles in
// /admin/feature-flags, per-user overrides in /admin/users/[id]). Kept separate
// from resolve.ts (the read-path hot loop) so the route +page.server.ts files
// stay thin. Every mutation validates the key against the registry and records
// updated_by so an action this consequential (silently disabling someone's
// ability to send) is attributable.

import { db } from '../db';
import { FEATURE_FLAG_KEYS } from './registry';

function assertKnownKey(key: string): void {
	if (!FEATURE_FLAG_KEYS.has(key)) throw new Error(`Unknown feature flag: ${key}`);
}

// --- Global flags ----------------------------------------------------------

/** Current global rows as a key -> enabled map (absent keys inherit the registry default). */
export function getGlobalFlags(): Map<string, boolean> {
	const rows = db.prepare('SELECT key, enabled FROM feature_flags').all() as {
		key: string;
		enabled: number;
	}[];
	return new Map(rows.map((r) => [r.key, r.enabled === 1]));
}

/** Upsert the instance-wide value for one flag. */
export function setGlobalFlag(key: string, enabled: boolean, updatedBy: number): void {
	assertKnownKey(key);
	db.prepare(
		`INSERT INTO feature_flags (key, enabled, updated_by, updated_at)
		 VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		 ON CONFLICT(key) DO UPDATE SET
			 enabled = excluded.enabled,
			 updated_by = excluded.updated_by,
			 updated_at = excluded.updated_at`
	).run(key, enabled ? 1 : 0, updatedBy);
}

/** Per-flag count of users with an explicit override — powers the "N overrides" badge. */
export function overrideCountsByFlag(): Map<string, number> {
	const rows = db
		.prepare('SELECT key, COUNT(*) AS n FROM user_feature_flags GROUP BY key')
		.all() as { key: string; n: number }[];
	return new Map(rows.map((r) => [r.key, r.n]));
}

// --- Per-user overrides ----------------------------------------------------

/** The keys a user has an explicit override row for, as a key -> enabled map. */
export function getUserOverrides(userId: number): Map<string, boolean> {
	const rows = db
		.prepare('SELECT key, enabled FROM user_feature_flags WHERE user_id = ?')
		.all(userId) as { key: string; enabled: number }[];
	return new Map(rows.map((r) => [r.key, r.enabled === 1]));
}

/** Force a flag on/off for one user (upsert). */
export function setUserOverride(
	userId: number,
	key: string,
	enabled: boolean,
	updatedBy: number
): void {
	assertKnownKey(key);
	db.prepare(
		`INSERT INTO user_feature_flags (user_id, key, enabled, updated_by, updated_at)
		 VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		 ON CONFLICT(user_id, key) DO UPDATE SET
			 enabled = excluded.enabled,
			 updated_by = excluded.updated_by,
			 updated_at = excluded.updated_at`
	).run(userId, key, enabled ? 1 : 0, updatedBy);
}

/** Clear a user's override for one flag (back to inheriting global/registry). */
export function clearUserOverride(userId: number, key: string): void {
	assertKnownKey(key);
	db.prepare('DELETE FROM user_feature_flags WHERE user_id = ? AND key = ?').run(userId, key);
}

/** Per-user count of overrides — powers the badge on the /admin/users list. */
export function overrideCountsByUser(): Map<number, number> {
	const rows = db
		.prepare('SELECT user_id, COUNT(*) AS n FROM user_feature_flags GROUP BY user_id')
		.all() as { user_id: number; n: number }[];
	return new Map(rows.map((r) => [r.user_id, r.n]));
}
