// UX Simplification Wave 3 (cairn-6c91u.3, docs/UX-SIMPLIFICATION-SPEC.md §6):
// migrateExplorerDefault() must land explorer=ON for a genuinely fresh/no-user
// install and never touch an install that already has a user OR an install
// that already carries an explicit `explorer` row (ON or OFF), mirroring
// instanceModeMigration.test.ts's shape for the analogous solo/team decision
// (docs/UX-PLAN.md Wave A) and miningDefaultMigration.test.ts's shape for the
// sibling mining flag.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { isFeatureEnabled } from './featureFlags/resolve';
import { setGlobalFlag, getGlobalFlags } from './featureFlags/admin';
import { migrateExplorerDefault } from './explorerDefaultMigration';
import { migrateMiningDefault } from './miningDefaultMigration';

const PASSWORD = 'correct horse battery';

function wipe(): void {
	db.exec(
		'DELETE FROM user_feature_flags; DELETE FROM feature_flags; DELETE FROM sessions; DELETE FROM users;'
	);
}

beforeEach(() => {
	wipe();
});

describe('migrateExplorerDefault', () => {
	it('defaults the explorer on for a genuinely fresh install (no users yet)', () => {
		migrateExplorerDefault();
		expect(getGlobalFlags().get('explorer')).toBe(true);
		expect(isFeatureEnabled('explorer', null)).toBe(true);
	});

	it('writes the row exactly once — a single feature_flags row for the key', () => {
		migrateExplorerDefault();
		migrateExplorerDefault();
		const rows = db.prepare('SELECT * FROM feature_flags WHERE key = ?').all('explorer');
		expect(rows.length).toBe(1);
	});

	it('leaves an install that already has a user completely untouched', async () => {
		await registerUser({ email: 'a@example.com', password: PASSWORD, displayName: 'A' });
		migrateExplorerDefault();
		expect(getGlobalFlags().has('explorer')).toBe(false); // no row written at all
		expect(isFeatureEnabled('explorer', null)).toBe(true); // registry default, untouched
	});

	it('is idempotent — running again after users appear never re-derives the decision', async () => {
		migrateExplorerDefault();
		expect(isFeatureEnabled('explorer', null)).toBe(true);

		await registerUser({ email: 'a@example.com', password: PASSWORD, displayName: 'A' });
		migrateExplorerDefault(); // a user now exists, but the decision already landed
		expect(isFeatureEnabled('explorer', null)).toBe(true);
	});

	it('never overwrites a feature_flags row that already exists for any reason (ON)', () => {
		// e.g. a restored config / provisioning script set this before any user
		// existed — a system write, hence updatedBy: null.
		setGlobalFlag('explorer', true, null);
		migrateExplorerDefault();
		expect(isFeatureEnabled('explorer', null)).toBe(true);
	});

	it('an existing install with a stored OFF row stays OFF (R14 guard) — the fresh-install ON flip never clobbers it', () => {
		// e.g. an install that upgraded from before this migration existed and
		// had an admin (or the old pre-flip migration) explicitly turn the
		// explorer off — that decision must survive the default flipping.
		setGlobalFlag('explorer', false, null);
		migrateExplorerDefault();
		const rows = db.prepare('SELECT * FROM feature_flags WHERE key = ?').all('explorer');
		expect(rows.length).toBe(1);
		expect(isFeatureEnabled('explorer', null)).toBe(false);
	});

	it('an admin turning the flag back off afterwards is honored immediately (power-user opt-out path)', async () => {
		migrateExplorerDefault();
		expect(isFeatureEnabled('explorer', null)).toBe(true);

		const admin = await registerUser({
			email: 'admin@example.com',
			password: PASSWORD,
			displayName: 'Admin'
		});
		setGlobalFlag('explorer', false, admin.id); // Settings → Explorer toggle, simulated
		expect(isFeatureEnabled('explorer', null)).toBe(false);
	});

	it('a fresh boot resolves explorer ON and mining OFF together (cairn-6c91u.3 §6/§12 W3)', () => {
		// Both migrations run back-to-back at boot (hooks.server.ts init()) —
		// prove the combined fresh-install outcome directly, not just each
		// flag in isolation.
		migrateExplorerDefault();
		migrateMiningDefault();
		expect(isFeatureEnabled('explorer', null)).toBe(true);
		expect(isFeatureEnabled('mining', null)).toBe(false);
	});
});
