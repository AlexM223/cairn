// Auto-hop to Cairn's self-signed HTTPS listener (cairn-6uff).
//
// On plain-HTTP hosts (stock Umbrel), USB hardware signing and camera
// scanning only work on the secure address — but asking every returning user
// to click "Open the secure address" again is busywork. The trick that makes
// an automatic hop safe: a fetch() to a self-signed https origin only
// succeeds AFTER the user has clicked through the browser's certificate
// warning for that origin (subresource requests get no interstitial — they
// just fail). So probing the secure origin cleanly splits the two cases:
//
//   • first-time user  → probe fails → stay put, keep the guided
//     SecureContextHelp flow with its warning-bypass explanation;
//   • returning user   → probe succeeds → hop to the same path on the
//     secure origin, no clicks. Session cookies ignore ports, so they
//     stay signed in.
//
// Escape hatch: ?insecure=1 suppresses the hop for the rest of the tab's
// session (sessionStorage), for anyone who deliberately wants the plain-HTTP
// origin back.
//
// Wizard exception: the wallet-creation wizards (/wallets/new,
// /wallets/multisig/new) persist their resume state in sessionStorage, which
// is origin-scoped — a mid-wizard hop to the HTTPS origin silently discards
// that progress (cairn-01gq). Those pages already surface SecureContextHelp
// inline for the device-signing steps that actually need the secure
// context, so the auto-hop buys nothing there and just costs progress.

/** sessionStorage flag: "don't auto-open the secure address in this tab". */
export const SECURE_REDIRECT_SUPPRESS_KEY = 'cairn.secure-redirect.off';

/** Route prefixes where wizard resume state would be lost on a cross-origin hop. */
const WIZARD_PATH_PREFIXES = ['/wallets/new', '/wallets/multisig/new'];

/** True when the given pathname is inside a wizard that keeps origin-scoped resume state. */
function isWizardPath(pathname: string): boolean {
	return WIZARD_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** Query param that sets the suppress flag (an operator/debugging back door). */
export const SECURE_REDIRECT_OPT_OUT_PARAM = 'insecure';

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** The same page on the secure origin. Exported for tests. */
export function secureUrlFor(
	loc: { hostname: string; pathname: string; search: string; hash: string },
	port: number
): string {
	return `https://${loc.hostname}:${port}${loc.pathname}${loc.search}${loc.hash}`;
}

/**
 * Decide whether this page load should even try the probe. Pure of browser
 * globals (everything injected) so the branches are unit-testable.
 */
export function shouldAttemptSecureRedirect(opts: {
	isSecureContext: boolean;
	httpsPort: number | null;
	searchParams: URLSearchParams;
	storage: StorageLike | null;
	pathname?: string;
}): boolean {
	const { isSecureContext, httpsPort, searchParams, storage, pathname } = opts;

	// The explicit opt-out wins over everything, and persists for the tab —
	// otherwise the hop would fight a user who deliberately came back to HTTP.
	if (searchParams.has(SECURE_REDIRECT_OPT_OUT_PARAM)) {
		try {
			storage?.setItem(SECURE_REDIRECT_SUPPRESS_KEY, '1');
		} catch {
			// Private mode etc. — the param still suppresses this load.
		}
		return false;
	}
	try {
		if (storage?.getItem(SECURE_REDIRECT_SUPPRESS_KEY) === '1') return false;
	} catch {
		// Unreadable storage — treat as unset.
	}

	// Mid-wizard: a cross-origin hop would wipe the wizard's sessionStorage
	// resume state (cairn-01gq). The wizard's own device-signing steps
	// already handle the secure-context gap inline.
	if (pathname && isWizardPath(pathname)) return false;

	// Secure already (which includes localhost) or no listener advertised.
	if (isSecureContext || !httpsPort) return false;
	return true;
}

/**
 * Probe the secure origin and hop to it when reachable. Resolves true when a
 * redirect was issued. Call from onMount — never during SSR.
 */
export async function maybeRedirectToSecure(
	httpsPort: number | null,
	win: Pick<Window, 'location' | 'isSecureContext' | 'sessionStorage'> = window
): Promise<boolean> {
	let storage: StorageLike | null = null;
	try {
		storage = win.sessionStorage;
	} catch {
		storage = null; // storage access can itself throw in locked-down contexts
	}

	if (
		!shouldAttemptSecureRedirect({
			isSecureContext: win.isSecureContext,
			httpsPort,
			searchParams: new URLSearchParams(win.location.search),
			storage,
			pathname: win.location.pathname
		})
	) {
		return false;
	}

	const port = httpsPort as number;
	try {
		// no-cors: an opaque response is all we need — "resolved" already means
		// TCP + TLS + the user's standing cert bypass all check out. A 503 from
		// the starting-up placeholder still counts: the secure origin's page
		// self-refreshes into the app (cairn-qv6h).
		await fetch(`https://${win.location.hostname}:${port}/api/health`, {
			mode: 'no-cors',
			cache: 'no-store',
			signal: AbortSignal.timeout(2500)
		});
	} catch {
		return false; // not accepted yet (or unreachable) — the guided flow stays
	}

	win.location.replace(secureUrlFor(win.location, port));
	return true;
}
