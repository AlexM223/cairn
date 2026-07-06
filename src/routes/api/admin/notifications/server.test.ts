// cairn-uhc6 — cross-field SMTP guard (cairn-es32) in POST /api/admin/notifications:
// saving smtp_tls='none' while SMTP credentials are (or would remain) configured
// makes nodemailer send AUTH — username, password, and message bodies — in
// cleartext. Pre-fix each field validated independently, so tls 'none' saved
// fine right next to stored credentials. The guard must consider the EFFECTIVE
// post-save values (body wins over stored; clear flag wins over both) and reject
// before persisting anything.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '$lib/server/db';
import { registerUser } from '$lib/server/auth';
import { setSetting, getSetting, readSecretSetting } from '$lib/server/settings';
import { POST } from './+server';

function wipe(): void {
	db.exec(
		'DELETE FROM events; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings; DELETE FROM instance_secrets;'
	);
}

const PASSWORD = 'correct horse battery';
let admin: { id: number; email: string; displayName: string; isAdmin: boolean };

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	const u = registerUser({ email: 'admin@example.com', password: PASSWORD, displayName: 'admin' });
	admin = { id: u.id, email: u.email, displayName: u.displayName, isAdmin: true };
	// Stored SMTP relay with credentials, TLS on — the state the guard protects.
	setSetting('smtp_host', 'smtp.example.com');
	setSetting('smtp_user', 'relay-user');
	setSetting('smtp_pass', 'relay-secret');
	setSetting('smtp_tls', 'starttls');
});

function postEvent(body: unknown): Parameters<typeof POST>[0] {
	return {
		locals: { user: admin },
		params: {},
		request: new Request('http://localhost/api/admin/notifications', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	} as unknown as Parameters<typeof POST>[0];
}

async function post(body: unknown) {
	const res = await POST(postEvent(body));
	return { status: res.status, body: await res.json() };
}

describe('SMTP cleartext cross-field validation (cairn-uhc6)', () => {
	it('refuses smtpTls "none" while credentials are stored, and persists nothing', async () => {
		const { status, body } = await post({ smtpTls: 'none' });
		expect(status).toBe(400);
		expect(body.error).toMatch(/cleartext/i);
		expect(getSetting('smtp_tls')).toBe('starttls'); // unchanged
	});

	it('a rejected save persists NONE of the other fields in the same body', async () => {
		const { status } = await post({ smtpTls: 'none', smtpHost: 'other.example', smtpPort: 2525 });
		expect(status).toBe(400);
		expect(getSetting('smtp_host')).toBe('smtp.example.com'); // untouched
		expect(getSetting('smtp_port')).toBeNull();
	});

	it('still refuses when only a stored PASSWORD remains (username cleared in the same body)', async () => {
		// effectiveUser = '' but effectivePass = stored 'relay-secret' → still unsafe.
		const { status } = await post({ smtpUser: '', smtpTls: 'none' });
		expect(status).toBe(400);
		expect(getSetting('smtp_tls')).toBe('starttls');
		expect(getSetting('smtp_user')).toBe('relay-user'); // nothing persisted either
	});

	it('refuses a NEW password provided in the same body as tls "none"', async () => {
		db.exec("DELETE FROM settings WHERE key IN ('smtp_user', 'smtp_pass')");
		const { status } = await post({ smtpPass: 'fresh-secret', smtpTls: 'none' });
		expect(status).toBe(400);
		expect(readSecretSetting('smtp_pass')).toBeNull();
	});

	it('clearing credentials first, then setting tls "none", succeeds', async () => {
		const cleared = await post({ smtpUser: '', clearSmtpPass: true });
		expect(cleared.status).toBe(200);
		expect(getSetting('smtp_user')).toBe('');
		expect(readSecretSetting('smtp_pass')).toBe('');

		const tlsOff = await post({ smtpTls: 'none' });
		expect(tlsOff.status).toBe(200);
		expect(getSetting('smtp_tls')).toBe('none');
	});

	it('clearing credentials AND setting tls "none" in one request succeeds (effective values win)', async () => {
		const { status, body } = await post({ smtpUser: '', clearSmtpPass: true, smtpTls: 'none' });
		expect(status).toBe(200);
		expect(body.settings.smtpTls).toBe('none');
		expect(getSetting('smtp_tls')).toBe('none');
		expect(readSecretSetting('smtp_pass')).toBe('');
	});
});
