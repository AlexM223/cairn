// Fixed-window, in-memory failure throttling for authentication endpoints.
//
// Cairn is a single-process app (node:sqlite, adapter-node), so process
// memory is an adequate store: a restart clearing the counters is fine.
// scrypt already makes each guess expensive server-side; this cap stops
// sustained online guessing outright.
//
// Deployment note: getClientAddress() only sees the reverse proxy's address
// unless the adapter is told which header carries the client IP (adapter-node:
// ADDRESS_HEADER=x-forwarded-for). Per-email limits still apply either way.

interface FailureWindow {
	count: number;
	windowStart: number;
}

const WINDOW_MS = 15 * 60_000;

const LIMITS = {
	/** Failed logins per email — tight: targets credential guessing. */
	loginEmail: 5,
	/** Failed logins per IP — looser: tolerates a shared NAT, stops spraying. */
	loginIp: 20,
	/** Invalid invite codes per IP — stops invite-code enumeration. */
	invitesIp: 10,
	/** Wrong current-password attempts per user on password change. */
	passwordChange: 5
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
	return retryAfter(emailKey, LIMITS.loginEmail) ?? retryAfter(ipKey, LIMITS.loginIp);
}

export function noteLoginFailure(ip: string, email: string): void {
	for (const key of loginKeys(ip, email)) recordFailure(key);
}

export function noteLoginSuccess(ip: string, email: string): void {
	clear(...loginKeys(ip, email));
}

// ---------------------------------------------------------------- invites

export function inviteRetryAfter(ip: string): number | null {
	return retryAfter(`invite:ip:${ip}`, LIMITS.invitesIp);
}

export function noteInviteFailure(ip: string): void {
	recordFailure(`invite:ip:${ip}`);
}

// ---------------------------------------------------------- password change

export function passwordChangeRetryAfter(userId: number): number | null {
	return retryAfter(`pwchange:${userId}`, LIMITS.passwordChange);
}

export function notePasswordChangeFailure(userId: number): void {
	recordFailure(`pwchange:${userId}`);
}

export function notePasswordChangeSuccess(userId: number): void {
	clear(`pwchange:${userId}`);
}

/** Human phrasing shared by the endpoints. */
export function tooManyAttemptsMessage(seconds: number): string {
	const minutes = Math.ceil(seconds / 60);
	return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}
