// Concurrent logins from N clients — the SESSION TABLE ITSELF, not the
// notification/mutation angles other files already cover:
//   - sessionEdges.test.ts's "concurrent logins" block already pins that 2-3
//     sequential createSession calls all authenticate and don't revoke each
//     other.
//   - concurrentLoginsMutation.test.ts already pins that two live sessions
//     racing a WRITE to shared application state don't corrupt it.
//   - deviceTracking.test.ts already pins the new-device NOTIFICATION side of
//     multiple logins.
//
// Untested until now: whether the sessions TABLE stays correct — one row per
// login, no cross-session field bleed (user_agent/ip_address), no clobbering
// — when many logins for one user (and logins for DIFFERENT users) actually
// happen concurrently (real Promise.all, not sequential awaits), and that a
// logout for one user concurrently with reads/writes for other users never
// touches sessions it shouldn't.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser, createSession, getSessionUser, destroySession, destroyUserSessions } from './auth';
import { setSetting } from './settings';

function wipe(): void {
	db.exec('DELETE FROM sessions; DELETE FROM known_devices; DELETE FROM events; DELETE FROM users; DELETE FROM settings;');
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
});

async function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

describe('N truly concurrent logins for ONE user — session table integrity', () => {
	it('20 simultaneous createSession calls (Promise.all, not sequential) produce exactly 20 distinct rows, every token authenticates', async () => {
		const user = await makeUser('owner@example.com');
		const N = 20;
		const results = await Promise.all(
			Array.from({ length: N }, (_, i) =>
				Promise.resolve(createSession(user.id, { userAgent: `client-${i}`, ip: `10.0.0.${i}` }))
			)
		);

		const tokens = results.map((r) => r.token);
		expect(new Set(tokens).size).toBe(N); // no two clients got the same token

		const { n } = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(user.id) as {
			n: number;
		};
		expect(n).toBe(N);

		for (const token of tokens) {
			expect(getSessionUser(token)?.id).toBe(user.id);
		}
	});

	it('each concurrently-created session keeps its OWN user_agent/ip — no cross-session metadata bleed under concurrency', async () => {
		const user = await makeUser('owner@example.com');
		const clients = [
			{ userAgent: 'Client-A/1.0', ip: '10.0.0.1' },
			{ userAgent: 'Client-B/2.0', ip: '10.0.0.2' },
			{ userAgent: 'Client-C/3.0', ip: '10.0.0.3' },
			{ userAgent: 'Client-D/4.0', ip: '10.0.0.4' },
			{ userAgent: 'Client-E/5.0', ip: '10.0.0.5' }
		];
		const results = await Promise.all(clients.map((ctx) => Promise.resolve(createSession(user.id, ctx))));

		const rows = db
			.prepare('SELECT user_agent, ip_address FROM sessions WHERE user_id = ? ORDER BY id')
			.all(user.id) as { user_agent: string; ip_address: string }[];

		// Every stored (user_agent, ip_address) pair is exactly one of the
		// clients' own — no client's metadata ended up on another's row.
		const stored = rows.map((r) => `${r.user_agent}|${r.ip_address}`).sort();
		const expected = clients.map((c) => `${c.userAgent}|${c.ip}`).sort();
		expect(stored).toEqual(expected);
		expect(results).toHaveLength(clients.length);
	});
});

describe('concurrent logins across MULTIPLE users at once — no cross-user contamination', () => {
	it('3 users each logging in twice, all 6 createSession calls concurrent: every session resolves to the correct owner', async () => {
		const alice = await makeUser('alice@example.com');
		const bob = await makeUser('bob@example.com');
		const carol = await makeUser('carol@example.com');

		const jobs = [
			[alice.id, 'alice-A'],
			[alice.id, 'alice-B'],
			[bob.id, 'bob-A'],
			[bob.id, 'bob-B'],
			[carol.id, 'carol-A'],
			[carol.id, 'carol-B']
		] as const;

		const results = await Promise.all(
			jobs.map(([userId, tag]) => Promise.resolve({ tag, userId, ...createSession(userId, { userAgent: tag }) }))
		);

		for (const r of results) {
			expect(getSessionUser(r.token)?.id).toBe(r.userId);
		}
		const { n } = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
		expect(n).toBe(6);
	});

	it('destroying user A\'s sessions concurrently with user B logging in and reading their own session: B is entirely unaffected', async () => {
		const alice = await makeUser('alice@example.com');
		const bob = await makeUser('bob@example.com');
		const aliceOld = createSession(alice.id);

		const [, bobResult] = await Promise.all([
			Promise.resolve(destroyUserSessions(alice.id)),
			(async () => {
				const s = createSession(bob.id);
				return { token: s.token, user: getSessionUser(s.token) };
			})()
		]);

		expect(getSessionUser(aliceOld.token)).toBeNull();
		expect(bobResult.user?.id).toBe(bob.id);
		expect(getSessionUser(bobResult.token)?.id).toBe(bob.id);
	});

	it('destroySession for one of user A\'s sessions racing a read of another of user A\'s sessions never corrupts or drops the untouched one', async () => {
		const user = await makeUser('owner@example.com');
		const keep = createSession(user.id, { userAgent: 'keep-me' });
		const kill = createSession(user.id, { userAgent: 'kill-me' });

		const [, keptUser] = await Promise.all([
			Promise.resolve(destroySession(kill.token)),
			Promise.resolve(getSessionUser(keep.token))
		]);

		expect(keptUser?.id).toBe(user.id);
		expect(getSessionUser(kill.token)).toBeNull();
		expect(getSessionUser(keep.token)?.id).toBe(user.id);

		const { n } = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(user.id) as {
			n: number;
		};
		expect(n).toBe(1);
	});
});

describe('logout-one-leaves-others-valid, at higher fan-out than sessionEdges.test.ts\'s 2-session case', () => {
	it('destroying ONE of 10 concurrent sessions leaves the other 9 fully valid and independently destroyable', async () => {
		const user = await makeUser('owner@example.com');
		const sessions = await Promise.all(
			Array.from({ length: 10 }, (_, i) => Promise.resolve(createSession(user.id, { userAgent: `c${i}` })))
		);

		destroySession(sessions[3].token);

		sessions.forEach((s, i) => {
			if (i === 3) {
				expect(getSessionUser(s.token)).toBeNull();
			} else {
				expect(getSessionUser(s.token)?.id).toBe(user.id);
			}
		});

		const { n } = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(user.id) as {
			n: number;
		};
		expect(n).toBe(9);
	});
});
