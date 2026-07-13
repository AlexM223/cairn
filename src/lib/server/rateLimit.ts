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

/**
 * Best-effort client IP for throttling. getClientAddress() THROWS when the
 * configured ADDRESS_HEADER is absent from the request — which is every
 * request on Cairn's own direct HTTPS listener, since no proxy fronts that
 * port (cairn-kfis: this 500'd all auth endpoints on the secure address).
 * Requests with no resolvable address fold into one shared "unknown" bucket
 * instead; the per-email limits still apply individually.
 */
export function clientIpFor(event: { getClientAddress(): string }): string {
	try {
		return event.getClientAddress();
	} catch {
		return 'unknown';
	}
}

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

// ---------------------------------------------------------------- contacts

// POST /api/contacts is limited per requesting user AND per IP to stop
// wordlist-based account enumeration (cairn-n4k4). Unlike the login/invite
// limiters, EVERY request counts (not just failures): a probe against a real
// account returns the same 200 as a miss, so there is no "failure" to key on —
// the request itself is the unit to throttle. Generous vs. legitimate use
// (adding a handful of friends), tight enough to make bulk probing impractical.
const CONTACT_LIMITS = { user: 20, ip: 60 } as const;

const contactKeys = (ip: string, userId: number) => [
	`contact:ip:${ip}`,
	`contact:user:${userId}`
];

/** Seconds the caller must wait before another contact request, or null. */
export function contactRequestRetryAfter(ip: string, userId: number): number | null {
	const [ipKey, userKey] = contactKeys(ip, userId);
	const wait = retryAfter(userKey, CONTACT_LIMITS.user) ?? retryAfter(ipKey, CONTACT_LIMITS.ip);
	if (wait !== null) {
		log.warn(
			{ event: 'contact_request_throttled', ip, userId, retryAfter: wait },
			'contact request throttled by rate limiter'
		);
	}
	return wait;
}

/** Count a contact request against both buckets (every attempt, success or not). */
export function noteContactRequest(ip: string, userId: number): void {
	for (const key of contactKeys(ip, userId)) recordFailure(key);
}

// ---------------------------------------------------------------- search

// GET /api/search fans out to real chain RPC (getTip / getTx / getBlock —
// search.ts) per request, gated only by auth (and, since cairn-he4e, the
// `explorer` feature flag) — nothing previously bounded request RATE, so an
// authenticated loop of random 64-hex queries could exhaust the shared
// Electrum/Core connection pool for every user on the instance (cairn-hwta).
// Mirrors the contacts limiter's shape: EVERY request counts (a search has no
// "failure" to key on), limited per-user AND per-IP on the same 15-minute
// window as the rest of this module. Generous enough that real interactive
// type-ahead use (a handful of searches while poking around the explorer)
// never comes close, tight enough to cap the amplification.
const SEARCH_LIMITS = { user: 120, ip: 300 } as const;

const searchKeys = (ip: string, userId: number) => [
	`search:ip:${ip}`,
	`search:user:${userId}`
];

/** Seconds the caller must wait before another search, or null if under the limit. */
export function searchRetryAfter(ip: string, userId: number): number | null {
	const [ipKey, userKey] = searchKeys(ip, userId);
	const wait = retryAfter(userKey, SEARCH_LIMITS.user) ?? retryAfter(ipKey, SEARCH_LIMITS.ip);
	if (wait !== null) {
		log.warn(
			{ event: 'search_throttled', ip, userId, retryAfter: wait },
			'search request throttled by rate limiter'
		);
	}
	return wait;
}

/** Count a search request against both buckets (every attempt, success or not). */
export function noteSearchRequest(ip: string, userId: number): void {
	for (const key of searchKeys(ip, userId)) recordFailure(key);
}

/** Human phrasing shared by the endpoints. */
export function tooManyAttemptsMessage(seconds: number): string {
	const minutes = Math.ceil(seconds / 60);
	return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}
