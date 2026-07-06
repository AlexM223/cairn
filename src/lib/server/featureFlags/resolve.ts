// src/lib/server/featureFlags/resolve.ts
//
// Feature-flag resolution: registry default -> global row -> per-user row,
// where a level's ABSENCE means "inherit the level below it" and a per-user
// row wins in either direction. See docs/FEATURE-FLAGS-PLAN.md §1.2/§2.
//
// Deliberately synchronous — Cairn's node:sqlite DatabaseSync is synchronous
// everywhere else (getSetting, getSessionUser, ...); an async signature here
// would be the one inconsistent call site in the server codebase.

import { db } from '../db';
import { FEATURE_FLAGS, FEATURE_FLAGS_BY_KEY } from './registry';

/** The instance-wide value for a flag: the global row if set, else the registry default. */
function globalEnabled(key: string): boolean {
	const def = FEATURE_FLAGS_BY_KEY.get(key);
	if (!def) throw new Error(`Unknown feature flag: ${key}`);
	const row = db.prepare('SELECT enabled FROM feature_flags WHERE key = ?').get(key) as
		| { enabled: number }
		| undefined;
	return row ? row.enabled === 1 : def.defaultEnabled;
}

/**
 * Resolve one flag for one user (or `null` for a logged-out/system context,
 * which gets the global value). An unknown key THROWS rather than silently
 * resolving true/false — a typo'd key at a call site should fail loudly in
 * dev/CI, not silently grant or deny a feature in production.
 */
export function isFeatureEnabled(key: string, userId: number | null): boolean {
	if (userId == null) return globalEnabled(key);
	const row = db
		.prepare('SELECT enabled FROM user_feature_flags WHERE user_id = ? AND key = ?')
		.get(userId, key) as { enabled: number } | undefined;
	return row ? row.enabled === 1 : globalEnabled(key);
}

/**
 * Resolve EVERY registered flag for a user in one pass — this is what gets
 * attached to event.locals.flags once per request. Two small queries + an
 * in-memory overlay, mirroring getEffectivePreferences() in notifications.ts.
 */
export function resolveAllFlags(userId: number | null): Record<string, boolean> {
	const globals = new Map(
		(db.prepare('SELECT key, enabled FROM feature_flags').all() as {
			key: string;
			enabled: number;
		}[]).map((r) => [r.key, r.enabled === 1])
	);
	const overrides =
		userId == null
			? new Map<string, boolean>()
			: new Map(
					(
						db
							.prepare('SELECT key, enabled FROM user_feature_flags WHERE user_id = ?')
							.all(userId) as { key: string; enabled: number }[]
					).map((r) => [r.key, r.enabled === 1])
				);
	const out: Record<string, boolean> = {};
	for (const def of FEATURE_FLAGS) {
		out[def.key] = overrides.get(def.key) ?? globals.get(def.key) ?? def.defaultEnabled;
	}
	return out;
}
