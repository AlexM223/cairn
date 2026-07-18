// Epic cairn-vn43 / cairn-guvu — migrateMiningDefault() must land mining=off
// whenever the `mining` feature_flags row is absent, on BOTH a fresh install and
// an upgrade from a version that predates the feature (users already present, no
// row yet). It must never touch a row that already exists — whether written by a
// prior run of this migration or by an admin explicitly toggling the flag.

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

	it('defaults mining off on an UPGRADED install (users present, no mining row yet) — cairn-guvu', async () => {
		// The regression: an install upgrading from a pre-mining version already
		// has >=1 user but no `mining` row. The old userCount()===0 gate skipped
		// it, leaving the registry default `true` and exposing the mining UI.
		await registerUser({ email: 'a@example.com', password: PASSWORD, displayName: 'A' });
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

	it('is idempotent — running again after users appear never re-derives the decision', async () => {
		migrateMiningDefault();
		expect(isFeatureEnabled('mining', null)).toBe(false);

		await registerUser({ email: 'a@example.com', password: PASSWORD, displayName: 'A' });
		migrateMiningDefault(); // a user now exists, but the decision already landed
		expect(isFeatureEnabled('mining', null)).toBe(false);
	});

	it('never overwrites an existing enabled row (operator explicitly turned mining on)', () => {
		// e.g. an admin/provisioning script enabled mining before this migration
		// runs — a system write, hence updatedBy: null. Must survive untouched.
		setGlobalFlag('mining', true, null);
		migrateMiningDefault();
		expect(isFeatureEnabled('mining', null)).toBe(true);
	});

	it('never overwrites an existing disabled row (already decided off)', () => {
		setGlobalFlag('mining', false, null);
		migrateMiningDefault();
		const rows = db.prepare('SELECT * FROM feature_flags WHERE key = ?').all('mining');
		expect(rows.length).toBe(1);
		expect(isFeatureEnabled('mining', null)).toBe(false);
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
