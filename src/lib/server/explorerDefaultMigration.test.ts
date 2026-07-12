// UX Wave A — migrateExplorerDefault() must land explorer=off for a genuinely
// fresh/no-user install and never touch an install that already has a user,
// mirroring instanceModeMigration.test.ts's shape for the analogous
// solo/team decision (docs/UX-PLAN.md Wave A).

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { isFeatureEnabled } from './featureFlags/resolve';
import { setGlobalFlag, getGlobalFlags } from './featureFlags/admin';
import { migrateExplorerDefault } from './explorerDefaultMigration';

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
	it('defaults the explorer off for a genuinely fresh install (no users yet)', () => {
		migrateExplorerDefault();
		expect(getGlobalFlags().get('explorer')).toBe(false);
		expect(isFeatureEnabled('explorer', null)).toBe(false);
	});

	it('writes the row exactly once — a single feature_flags row for the key', () => {
		migrateExplorerDefault();
		migrateExplorerDefault();
		const rows = db.prepare('SELECT * FROM feature_flags WHERE key = ?').all('explorer');
		expect(rows.length).toBe(1);
	});

	it('never disables the explorer for an install that already has a user', async () => {
		await registerUser({ email: 'a@example.com', password: PASSWORD, displayName: 'A' });
		migrateExplorerDefault();
		expect(getGlobalFlags().has('explorer')).toBe(false); // no row written at all
		expect(isFeatureEnabled('explorer', null)).toBe(true); // registry default, untouched
	});

	it('is idempotent — running again after users appear never re-derives the decision', async () => {
		migrateExplorerDefault();
		expect(isFeatureEnabled('explorer', null)).toBe(false);

		await registerUser({ email: 'a@example.com', password: PASSWORD, displayName: 'A' });
		migrateExplorerDefault(); // a user now exists, but the decision already landed
		expect(isFeatureEnabled('explorer', null)).toBe(false);
	});

	it('never overwrites a feature_flags row that already exists for any reason', () => {
		// e.g. a restored config / provisioning script set this before any user
		// existed — a system write, hence updatedBy: null.
		setGlobalFlag('explorer', true, null);
		migrateExplorerDefault();
		expect(isFeatureEnabled('explorer', null)).toBe(true);
	});

	it('an admin turning the flag back on afterwards is honored immediately (power-user re-enable path)', async () => {
		migrateExplorerDefault();
		expect(isFeatureEnabled('explorer', null)).toBe(false);

		const admin = await registerUser({
			email: 'admin@example.com',
			password: PASSWORD,
			displayName: 'Admin'
		});
		setGlobalFlag('explorer', true, admin.id); // /admin/feature-flags toggle, simulated
		expect(isFeatureEnabled('explorer', null)).toBe(true);
	});
});
