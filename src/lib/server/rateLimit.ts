// Fixed-window, in-memory failure throttling for authentication endpoints.
//
// Cairn is a single-process app (node:sqlite, adapter-node), so process
// memory is an adequate store: a restart clearing the counters is fine.
// Auth is passkey-only, so there is no password to guess — but the login
// endpoint still gets throttled to blunt credential-stuffing and enumeration.
//
// Deployment note: getClientAddress() only sees the reverse proxy's address
// unless the adapter is told which header carries the client IP (adapter-node:
// ADDRESS_HEADER=x-forwarded-for). Per-email limits still apply either way.

import { getUserByEmail } from './auth';
import { notify } from './notifications';
import { childLogger } from './logger';

// Security-event log so throttling/abuse is visible in /admin/logs (cairn-wbmu).
// We log normalized emails for auth events an admin must triage, but never
// passwords, tokens, or credentials.
const log = childLogger('security');

interface FailureWindow {
	count: number;
	windowStart: number;
}

const WINDOW_MS = 15 * 60_000;

const LIMITS = {
	/** Failed logins per email — tight: targets credential stuffing. */
	loginEmail: 5,
	/** Failed logins per IP — looser: tolerates a shared NAT, stops spraying. */
	loginIp: 20,
	/** Invalid invite codes per IP — stops invite-code enumeration. */
	invitesIp: 10
} as const;

const buckets = new Map<string, FailureWindow>();

function bucket(key: string): FailureWindow | undefined {
	const b = buckets.get(key);
	if (b && Date.now() - b.windowStart > WINDOW_MS) {
		buckets.delete(key);
		return undefined;
	}
	return b;
}

/** Seconds until the key's window resets, or null if under the limit. */
function retryAfter(key: string, max: number): number | null {
	const b = bucket(key);
	if (!b || b.count < max) return null;
	return Math.max(1, Math.ceil((b.windowStart + WINDOW_MS - Date.now()) / 1000));
}

function recordFailure(key: string): void {
	// Opportunistic sweep so the map can't grow without bound under attack.
	if (buckets.size > 10_000) {
		const now = Date.now();
		for (const [k, v] of buckets) if (now - v.windowStart > WINDOW_MS) buckets.delete(k);
	}
	const b = bucket(key);
	if (b) b.count++;
	else buckets.set(key, { count: 1, windowStart: Date.now() });
}

function clear(...keys: string[]): void {
	for (const key of keys) buckets.delete(key);
}

// ---------------------------------------------------------------- login

const loginKeys = (ip: string, email: string) => [
	`login:ip:${ip}`,
	`login:email:${email.trim().toLowerCase()}`
];

/** Seconds the caller must wait before another login attempt, or null. */
export function loginRetryAfter(ip: string, email: string): number | null {
	const [ipKey, emailKey] = loginKeys(ip, email);
	const wait = retryAfter(emailKey, LIMITS.loginEmail) ?? retryAfter(ipKey, LIMITS.loginIp);
	if (wait !== null) {
		log.warn(
			{ event: 'login_throttled', ip, email: email.trim().toLowerCase(), retryAfter: wait },
			'login attempt throttled by rate limiter'
		);
	}
	return wait;
}

// Remembers the windowStart of the email bucket we last fired a
// security_failed_login alert for, so a burst past the threshold produces
// exactly ONE notification per window (not one per attempt over the line).
const failedLoginNotified = new Map<string, number>();

export function noteLoginFailure(ip: string, email: string): void {
	for (const key of loginKeys(ip, email)) recordFailure(key);
	log.warn(
		{ event: 'login_failed', ip, email: email.trim().toLowerCase() },
		'failed sign-in attempt'
	);

	// security_failed_login (Unit 8, §3): fire once when THIS account crosses the
	// per-email failed-attempt threshold within the rate-limit window. Reuses the
	// limiter's own counter rather than adding a second one. Scoped to the matched
	// userId — if the email doesn't match a real account there is no one to notify,
	// so we skip (also avoids leaking which emails exist). Best-effort.
	const emailKey = `login:email:${email.trim().toLowerCase()}`;
	const b = bucket(emailKey);
	if (!b || b.count < LIMITS.loginEmail) return;

	// One alert per window: only fire the first time the count reaches the limit.
	if (failedLoginNotified.get(emailKey) === b.windowStart) return;
	failedLoginNotified.set(emailKey, b.windowStart);
	log.error(
		{ event: 'login_threshold_crossed', ip, email: email.trim().toLowerCase(), attempts: b.count },
		'per-email failed-login threshold crossed — possible credential stuffing'
	);
	// Opportunistic cleanup so this map can't grow unbounded.
	if (failedLoginNotified.size > 10_000) {
		const now = Date.now();
		for (const [k, start] of failedLoginNotified) {
			if (now - start > WINDOW_MS) failedLoginNotified.delete(k);
		}
	}

	const user = getUserByEmail(email);
	if (!user) return; // no real account — nothing (and no one) to notify

	notify({
		type: 'security_failed_login',
		userId: user.id,
		level: 'warn',
		title: 'Repeated failed sign-in attempts',
		body: `There have been ${b.count} failed sign-in attempts on your account in the last 15 minutes. If this wasn't you, your password may be under attack.`,
		detail: { attempts: b.count },
		link: '/settings'
	});
}

export function noteLoginSuccess(ip: string, email: string): void {
	clear(...loginKeys(ip, email));
}

// ---------------------------------------------------------------- recovery

// Account-recovery verify attempts. Deliberately tighter and on its OWN window
// (1 hour) than login: a lost-passkey recovery is rare, and both a phrase and a
// code are high-value secrets worth guessing. Limited on BOTH the normalized
// email AND the client IP; either hitting the cap blocks. In-memory sliding-ish
// fixed window — resets on process restart (acceptable for a single-process
// self-hosted app), same as the login limiter above.
const RECOVERY_WINDOW_MS = 60 * 60_000; // 1 hour
const RECOVERY_MAX = 5; // attempts per window, per email and per IP

const recoveryKeys = (ip: string, email: string) => [
	`recover:ip:${ip}`,
	`recover:email:${email.trim().toLowerCase()}`
];

/**
 * Seconds the caller must wait before another recovery attempt, or null if under
 * the limit. Uses the recovery window (1h), distinct from the login window.
 */
export function recoveryRetryAfter(ip: string, email: string): number | null {
	for (const key of recoveryKeys(ip, email)) {
		const b = buckets.get(key);
		if (b && Date.now() - b.windowStart > RECOVERY_WINDOW_MS) {
			buckets.delete(key);
			continue;
		}
		if (b && b.count >= RECOVERY_MAX) {
			const wait = Math.max(1, Math.ceil((b.windowStart + RECOVERY_WINDOW_MS - Date.now()) / 1000));
			log.warn(
				{ event: 'recovery_throttled', ip, email: email.trim().toLowerCase(), retryAfter: wait },
				'account-recovery attempt throttled by rate limiter'
			);
			return wait;
		}
	}
	return null;
}

/**
 * Count a recovery attempt against BOTH the email and IP buckets. Every attempt
 * counts (success or failure) so a correct-then-flood pattern can't bypass the
 * cap; a successful recovery is a one-shot flow, so counting the success is fine.
 */
export function noteRecoveryAttempt(ip: string, email: string): void {
	for (const key of recoveryKeys(ip, email)) {
		// Opportunistic sweep, mirroring recordFailure.
		if (buckets.size > 10_000) {
			const now = Date.now();
			for (const [k, v] of buckets) if (now - v.windowStart > RECOVERY_WINDOW_MS) buckets.delete(k);
		}
		const b = buckets.get(key);
		if (b && Date.now() - b.windowStart > RECOVERY_WINDOW_MS) {
			buckets.set(key, { count: 1, windowStart: Date.now() });
		} else if (b) {
			b.count++;
		} else {
			buckets.set(key, { count: 1, windowStart: Date.now() });
		}
	}
}

/** Test/utility hook: clear a key's recovery counters. */
export function clearRecovery(ip: string, email: string): void {
	clear(...recoveryKeys(ip, email));
}

// ---------------------------------------------------------------- invites

export function inviteRetryAfter(ip: string): number | null {
	return retryAfter(`invite:ip:${ip}`, LIMITS.invitesIp);
}

export function noteInviteFailure(ip: string): void {
	recordFailure(`invite:ip:${ip}`);
	log.warn({ event: 'invite_failed', ip }, 'invalid invite code submitted');
}

/** Human phrasing shared by the endpoints. */
export function tooManyAttemptsMessage(seconds: number): string {
	const minutes = Math.ceil(seconds / 60);
	return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}
