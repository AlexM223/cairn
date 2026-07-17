// Epic cairn-vn43 — migrateMiningDefault() must land mining=off for a
// genuinely fresh/no-user install and never touch an install that already
// has a user, mirroring explorerDefaultMigration.test.ts's shape for the
// analogous soft-launch decision.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { isFeatureEnabled } from './featureFlags/resolve';
import { setGlobalFlag, getGlobalFlags } from './featureFlags/admin';
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

describe('migrateMiningDefault', () => {
	it('defaults mining off for a genuinely fresh install (no users yet)', () => {
		migrateMiningDefault();
		expect(getGlobalFlags().get('mining')).toBe(false);
		expect(isFeatureEnabled('mining', null)).toBe(false);
	});

	it('writes the row exactly once — a single feature_flags row for the key', () => {
		migrateMiningDefault();
		migrateMiningDefault();
		const rows = db.prepare('SELECT * FROM feature_flags WHERE key = ?').all('mining');
		expect(rows.length).toBe(1);
	});

	it('never disables mining for an install that already has a user', async () => {
		await registerUser({ email: 'a@example.com', password: PASSWORD, displayName: 'A' });
		migrateMiningDefault();
		expect(getGlobalFlags().has('mining')).toBe(false); // no row written at all
		expect(isFeatureEnabled('mining', null)).toBe(true); // registry default, untouched
	});

	it('is idempotent — running again after users appear never re-derives the decision', async () => {
		migrateMiningDefault();
		expect(isFeatureEnabled('mining', null)).toBe(false);

		await registerUser({ email: 'a@example.com', password: PASSWORD, displayName: 'A' });
		migrateMiningDefault(); // a user now exists, but the decision already landed
		expect(isFeatureEnabled('mining', null)).toBe(false);
	});

	it('never overwrites a feature_flags row that already exists for any reason', () => {
		// e.g. a restored config / provisioning script set this before any user
		// existed — a system write, hence updatedBy: null.
		setGlobalFlag('mining', true, null);
		migrateMiningDefault();
		expect(isFeatureEnabled('mining', null)).toBe(true);
	});

	it('an admin turning the flag back on afterwards is honored immediately (power-user re-enable path)', async () => {
		migrateMiningDefault();
		expect(isFeatureEnabled('mining', null)).toBe(false);

		const admin = await registerUser({
			email: 'admin@example.com',
			password: PASSWORD,
			displayName: 'Admin'
		});
		setGlobalFlag('mining', true, admin.id); // /admin/feature-flags toggle, simulated
		expect(isFeatureEnabled('mining', null)).toBe(true);
	});
});
