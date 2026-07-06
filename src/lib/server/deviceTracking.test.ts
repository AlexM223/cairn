import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser, createSession } from './auth';
import { setSetting } from './settings';
import { describeUserAgent } from './deviceTracking';

function wipe(): void {
	db.exec(
		`DELETE FROM notification_queue; DELETE FROM events; DELETE FROM known_devices;
		 DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;`
	);
}

function newDeviceEvents(): { user_id: number | null; message: string }[] {
	return db
		.prepare("SELECT user_id, message FROM events WHERE type = 'security_new_device' ORDER BY id")
		.all() as never;
}

function knownCount(userId: number): number {
	return (db.prepare('SELECT COUNT(*) AS n FROM known_devices WHERE user_id = ?').get(userId) as {
		n: number;
	}).n;
}

const UA_A = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120';
const UA_B = 'Mozilla/5.0 (iPhone; iOS 17) Safari/605';

let userId: number;

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	userId = registerUser({ email: 'u@example.com', password: 'correct horse battery', displayName: 'u' }).id;
});

describe('new-device detection (cairn-5gpv.6)', () => {
	it('does not alert on the first device ever seen', () => {
		createSession(userId, { userAgent: UA_A, ip: '1.1.1.1' });
		expect(newDeviceEvents()).toHaveLength(0);
		expect(knownCount(userId)).toBe(1);
	});

	it('does not alert on a repeat sign-in from a known device', () => {
		createSession(userId, { userAgent: UA_A, ip: '1.1.1.1' });
		createSession(userId, { userAgent: UA_A, ip: '1.1.1.2' }); // same UA, different IP
		expect(newDeviceEvents()).toHaveLength(0);
		expect(knownCount(userId)).toBe(1);
	});

	it('alerts when a second, unrecognized device signs in', () => {
		createSession(userId, { userAgent: UA_A, ip: '1.1.1.1' });
		createSession(userId, { userAgent: UA_B, ip: '2.2.2.2' });
		const evs = newDeviceEvents();
		expect(evs).toHaveLength(1);
		expect(evs[0].user_id).toBe(userId);
		expect(knownCount(userId)).toBe(2);
	});

	it('skips tracking entirely when no user-agent is available', () => {
		createSession(userId, { userAgent: null, ip: '3.3.3.3' });
		createSession(userId); // no context at all
		expect(newDeviceEvents()).toHaveLength(0);
		expect(knownCount(userId)).toBe(0);
	});

	it('stores the user-agent on the session row', () => {
		createSession(userId, { userAgent: UA_A, ip: '1.1.1.1' });
		const row = db
			.prepare('SELECT user_agent, ip_address FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1')
			.get(userId) as { user_agent: string | null; ip_address: string | null };
		expect(row.user_agent).toBe(UA_A);
		expect(row.ip_address).toBe('1.1.1.1');
	});
});

describe('describeUserAgent', () => {
	it('extracts a friendly browser + OS label', () => {
		expect(describeUserAgent(UA_A)).toBe('Chrome on Windows');
		expect(describeUserAgent(UA_B)).toBe('Safari on iOS');
	});
	it('falls back to a trimmed raw string when unrecognized', () => {
		expect(describeUserAgent('curl/8.0')).toBe('curl/8.0');
	});
});
