// cairn-7t0z.1 — instanceMode must land 'solo' for a fresh/lone-user install
// and 'team' for an install that already shows evidence of multi-user usage,
// so an upgrade never hides a surface an existing operator relies on. Also
// pins that the migration runs exactly once: it must not re-decide after an
// admin has explicitly toggled instance_mode.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { getSetting, setSetting, getInstanceSettings } from './settings';
import { migrateInstanceMode } from './instanceModeMigration';

const PASSWORD = 'correct horse battery';

function wipe(): void {
	db.exec(
		'DELETE FROM multisig_shares; DELETE FROM invites; DELETE FROM contacts; ' +
			'DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open'); // let these tests register >1 user freely
});

describe('migrateInstanceMode', () => {
	it('decides solo for a brand-new install (no users yet)', () => {
		migrateInstanceMode();
		expect(getSetting('instance_mode')).toBe('solo');
		expect(getInstanceSettings().instanceMode).toBe('solo');
	});

	it('decides solo for a lone existing user with no collaboration data', async () => {
		await registerUser({ email: 'solo@example.com', password: PASSWORD, displayName: 'Solo' });
		migrateInstanceMode();
		expect(getSetting('instance_mode')).toBe('solo');
	});

	it('decides team when more than one user already exists', async () => {
		await registerUser({ email: 'a@example.com', password: PASSWORD, displayName: 'A' });
		await registerUser({ email: 'b@example.com', password: PASSWORD, displayName: 'B' });
		migrateInstanceMode();
		expect(getSetting('instance_mode')).toBe('team');
	});

	it('decides team when an invite row exists, even with only one user', async () => {
		await registerUser({ email: 'a@example.com', password: PASSWORD, displayName: 'A' });
		const a = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number };
		db.prepare(
			`INSERT INTO invites (code, created_by, max_uses, used_count) VALUES ('ABC123', ?, 1, 0)`
		).run(a.id);
		migrateInstanceMode();
		expect(getSetting('instance_mode')).toBe('team');
	});

	it('decides team when a contacts row exists', async () => {
		const a = await registerUser({ email: 'a@example.com', password: PASSWORD, displayName: 'A' });
		const b = await registerUser({ email: 'b@example.com', password: PASSWORD, displayName: 'B' });
		db.prepare(
			`INSERT INTO contacts (user_id, contact_user_id, status) VALUES (?, ?, 'pending')`
		).run(a.id, b.id);
		migrateInstanceMode();
		expect(getSetting('instance_mode')).toBe('team');
	});

	it('is idempotent — running again never overwrites an already-decided value', async () => {
		migrateInstanceMode();
		expect(getSetting('instance_mode')).toBe('solo');

		await registerUser({ email: 'a@example.com', password: PASSWORD, displayName: 'A' });
		await registerUser({ email: 'b@example.com', password: PASSWORD, displayName: 'B' });
		migrateInstanceMode(); // more users now exist, but the decision already landed
		expect(getSetting('instance_mode')).toBe('solo');
	});

	it('never re-evaluates after an admin has explicitly toggled instance_mode', () => {
		setSetting('instance_mode', 'team'); // explicit admin toggle, no users/shares at all
		migrateInstanceMode();
		expect(getSetting('instance_mode')).toBe('team');
	});
});
