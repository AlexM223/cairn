// Post-login redirect target (?next=/wallets etc).
//
// cairn-9yw4: a naive `next.startsWith('/')` check accepts protocol-relative
// URLs like `//evil.com` — browsers treat a leading `//` as "same scheme,
// different host", so `goto('//evil.com')` navigates off-site. A leading
// `/\` is treated the same way (backslash normalizes to forward slash during
// URL parsing). Only a genuine same-origin path is safe.

// An arbitrary fixed base — we only ever care whether `path` resolves to
// *this same* origin, not what the origin actually is, so a placeholder
// works as well as the real `location.origin` and keeps this testable
// outside a browser (no DOM globals required).
const SAFE_BASE = 'http://cairn.internal';

/** True if `path` is a same-origin, path-only redirect target. */
export function isSafeInternalPath(path: string): boolean {
	if (!path.startsWith('/')) return false;
	try {
		// Resolving against a fixed base catches everything a manual prefix
		// check might miss (backslash variants, embedded scheme tricks, etc.)
		// — only a path that still resolves to our own placeholder origin is
		// safe. `//evil.com` and `/\evil.com` both resolve to a different host.
		return new URL(path, SAFE_BASE).origin === SAFE_BASE;
	} catch {
		return false;
	}
}

/** Resolves the `next` search param to a safe redirect path, defaulting to `/`. */
export function resolveNextUrl(next: string | null): string {
	return next && isSafeInternalPath(next) ? next : '/';
}
