import { error, redirect } from '@sveltejs/kit';
import type { Handle, HandleServerError } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';
import {
	getSessionUser,
	SESSION_COOKIE,
	bootstrapAdminFromEnv,
	cookieSecure,
	getAuthMode
} from '$lib/server/auth';
import { seedChainConfigFromEnv } from '$lib/server/chainEnvSeed';
import { probeAndSeedUmbrelElectrum } from '$lib/server/umbrelProbe';
import { probeAndDetectUmbrelCore } from '$lib/server/umbrelCoreProbe';
import { resolveAllFlags } from '$lib/server/featureFlags/resolve';
import { appGateRedirect } from '$lib/server/appGate';
import {
	childLogger,
	LEVEL,
	FILE_ENABLED,
	LOG_FILE,
	MAX_FILE_BYTES,
	MAX_FILES
} from '$lib/server/logger';
import { startNotificationQueueWorker } from '$lib/server/notificationQueue';
import { startAddressWatcher } from '$lib/server/addressWatcher';
import { startKeyHealthWatcher } from '$lib/server/keyHealth';
import { startBackupHealthWatcher } from '$lib/server/backupHealth';
import { startScheduledBackupWatcher } from '$lib/server/backup';
import { startPortfolioWarm } from '$lib/server/portfolioWarm';
import { startRetentionSweep } from '$lib/server/dataRetention';
import { startMiningEngine } from '$lib/server/mining';
import { startLiveTickers } from '$lib/server/liveTickers';
import { startFirstSync } from '$lib/server/syncStatus';
import { migratePlaintextSecretsAtRest } from '$lib/server/secretsMigration';
import { migrateInstanceMode } from '$lib/server/instanceModeMigration';
import { migrateExplorerDefault } from '$lib/server/explorerDefaultMigration';
import { migrateMiningDefault } from '$lib/server/miningDefaultMigration';
import { migrateDropEsploraUrl } from '$lib/server/esploraUrlMigration';
import { ensureDefaultAgreementVersion } from '$lib/server/disclosures';
import { httpsExternalPort } from '$lib/server/httpsPort';
import { DB_PATH } from '$lib/server/db';
import { getChainConfig, getInstanceMode } from '$lib/server/settings';
import { CURRENT_VERSION } from '$lib/server/updateCheck';

const httpLog = childLogger('http');
const errLog = childLogger('error');
const adminGuardLog = childLogger('admin-guard');
const gateLog = childLogger('gate');
const startupLog = childLogger('startup');

/**
 * Process-level crash guard (cairn-ldvt-adjacent).
 *
 * There was previously no `process.on('uncaughtException' | 'unhandledRejection')`
 * anywhere in the app, so a stray throw (e.g. inside the SSE heartbeat
 * setInterval) or rejection (e.g. an Electrum data-listener error) killed the
 * whole process for every user with no logged reason.
 *
 * hooks.server.ts is the one seam SvelteKit guarantees to load in every
 * launch mode this app supports: server.mjs's production wrapper (via its
 * `await import('./build/handler.js')`), adapter-node's own default
 * `build/index.js` entry point (unused by our Dockerfile/package.json today,
 * but a valid alternate launch mode), and `vite dev` / `vite preview`. That
 * makes this the right place for the *real*, logger-backed version of the
 * guard — server.mjs additionally installs a console.error-only fallback of
 * its own for the brief boot window before this module has loaded (DB open,
 * migrations, Electrum pool — see server.mjs's comment), since it can't
 * import $lib/server/logger from a plain, alias-unaware Node script.
 *
 * `removeAllListeners` below intentionally replaces (not stacks on top of)
 * any fallback listeners server.mjs already installed, so production logs
 * end up in the real structured logger once it's available instead of being
 * double-logged by both handlers. The `globalThis` flag guards against this
 * module's top-level code re-running more than once in the same process
 * (e.g. Vite SSR module invalidation in `vite dev`), which would otherwise
 * stack duplicate listeners on itself.
 */
declare global {
	// eslint-disable-next-line no-var
	var __cairnProcessGuardInstalled: boolean | undefined;
}
if (!globalThis.__cairnProcessGuardInstalled) {
	globalThis.__cairnProcessGuardInstalled = true;

	const processLog = childLogger('process');

	process.removeAllListeners('uncaughtException');
	process.removeAllListeners('unhandledRejection');

	process.on('uncaughtException', (err) => {
		processLog.error({ err }, 'uncaughtException — exiting');
		// A synchronous throw means the process state is unknown. This is a
		// wallet app — never keep serving requests in an undefined state.
		// Exit non-zero so the container/supervisor restart policy takes over.
		//
		// Wave 5 item 8 (log-request.md §4-G1): defer the exit by one
		// event-loop tick rather than calling process.exit(1) synchronously
		// right here. logger.ts's rotating FILE sink writes with fs.writeSync
		// (synchronous/durable — see its own comment), so the crash line is
		// already guaranteed to survive there; but the prod STDOUT stream
		// (logger.ts's `stream: process.stdout`) is frequently a pipe rather
		// than a TTY, and pipe writes are async — an immediate process.exit()
		// can tear the process down before that line reaches `docker logs`.
		// setImmediate runs after the current I/O callback queue, giving the
		// pending write a chance to flush first. Cheap, trivially reversible
		// (inline the process.exit(1) call again to roll back).
		setImmediate(() => process.exit(1));
	});

	process.on('unhandledRejection', (reason) => {
		// Log-only, deliberately NOT process.exit() here: a single benign
		// stray rejection (e.g. a fire-and-forget promise somewhere in a
		// dependency) would otherwise turn a harmless event into a crash
		// loop. uncaughtException above still exits, because a genuine
		// synchronous throw leaves the process in a genuinely unknown state,
		// which unhandledRejection does not.
		processLog.error({ err: reason }, 'unhandledRejection (not exiting — see comment)');
	});
}

// Top-level init sequence (cairn-48hm). This is one async function — instead
// of a bare sequence of top-level try/catch statements — so bootstrapAdminFromEnv
// can be awaited: it's synchronous today, but an in-progress branch makes it
// async (it awaits password hashing via async crypto.scrypt). A bare, unwaited
// call would let migrateInstanceMode() race ahead of the admin-row insert
// instead of running after it as intended, and errors thrown after that first
// await would become unhandled promise rejections instead of being caught
// below. Deliberately NOT a top-level `await` (that previously broke this
// repo's production build — see the build.target='esnext' history) — init()
// is invoked once into the module-scope `initReady` promise, and `handle`
// awaits that promise as its first step instead.
async function init(): Promise<void> {
	// UX Wave A (docs/UX-PLAN.md): decide whether the block explorer defaults
	// off, before anything below can create a user. MUST run first — its
	// "genuinely new install" test is a literal zero-user database, which is
	// only true before bootstrapAdminFromEnv() (next) runs. See
	// explorerDefaultMigration.ts for the full rationale. Idempotent; never
	// throws.
	try {
		migrateExplorerDefault();
	} catch (e) {
		errLog.error({ err: e }, 'explorer default migration failed');
	}

	// Same soft-launch shape, same "genuinely new install" test, for the
	// solo-mining flag (epic cairn-vn43). Order-independent relative to the
	// explorer migration (each only touches its own feature_flags row) but
	// must, like it, run before bootstrapAdminFromEnv() below. Idempotent;
	// never throws.
	try {
		migrateMiningDefault();
	} catch (e) {
		errLog.error({ err: e }, 'mining default migration failed');
	}

	// Drop the dead `esplora_url` settings row left by installs upgraded from a
	// version that stored one (Esplora fully removed, cairn-zoz8.16). Order-
	// independent — a pure settings-table cleanup that touches no other key.
	// Idempotent; never throws.
	try {
		migrateDropEsploraUrl();
	} catch (e) {
		errLog.error({ err: e }, 'esplora_url cleanup migration failed');
	}

	// Non-interactive admin bootstrap for deployment tooling (Umbrel/Docker set
	// CAIRN_ADMIN_PASSWORD / APP_PASSWORD). Runs once at server start; never throws.
	try {
		await bootstrapAdminFromEnv();
	} catch (e) {
		errLog.error({ err: e }, 'admin bootstrap from env failed');
	}

	// Non-destructive chain-backend (Electrum/Core RPC) settings seed from env
	// (cairn-loq7) — Umbrel's bitcoin/electrs app deps arrive here as
	// CAIRN_ELECTRUM_*/CAIRN_CORE_RPC_* container env vars. Must run before
	// anything below that can construct the ChainService singleton
	// (startAddressWatcher/startFirstSync/startPortfolioWarm all call
	// getChain()), so it's synchronous and placed right after the admin
	// bootstrap, before any watcher starts. Never throws. The returned key set
	// feeds the startup summary line below (`seededThisBoot`).
	let seededKeys: string[] = [];
	try {
		seededKeys = seedChainConfigFromEnv();
	} catch (e) {
		errLog.error({ err: e }, 'chain config env seed failed');
	}

	// Umbrel zero-config Electrum auto-connect, Wave A
	// (docs/UMBREL-AUTOCONNECT-DESIGN.md). Credential-free probe
	// of the well-known Umbrel electrs/Fulcrum fixed IPs — runs right after the
	// env-based seed above so an env value always wins when present (the probe
	// itself also no-ops once connection_mode is set, which the env seed just
	// did if its vars were present). Strictly gated on CAIRN_PLATFORM=umbrel
	// inside the module; a no-op, effectively-instant return on every other
	// deployment. Never throws.
	try {
		seededKeys = seededKeys.concat(await probeAndSeedUmbrelElectrum());
	} catch (e) {
		errLog.error({ err: e }, 'umbrel electrum probe failed');
	}

	// Umbrel Bitcoin Core RPC detect-and-surface, Wave B Unit B1
	// (docs/UMBREL-AUTOCONNECT-WAVE-B-DESIGN.md §4/§5, cairn-ylz5). Unlike the
	// Electrum probe above, this NEVER connects anything — it only seeds the
	// advisory `core_rpc_detected` marker when a bitcoind HTTP-RPC listener
	// answers the well-known Umbrel address, so the settings UI can later
	// offer an assisted one-paste connect. Same slot as the Electrum probe
	// (after the env seed, so an env-provided core_rpc_url always wins and
	// short-circuits this via coreRpcConfigured()); strictly gated to
	// CAIRN_PLATFORM=umbrel inside the module. Never throws.
	try {
		seededKeys = seededKeys.concat(await probeAndDetectUmbrelCore());
	} catch (e) {
		errLog.error({ err: e }, 'umbrel core RPC detect probe failed');
	}

	// Decide instanceMode ('solo' | 'team') for installs that predate the setting.
	// Runs after bootstrap so a freshly-created single admin is counted correctly.
	try {
		migrateInstanceMode();
	} catch (e) {
		errLog.error({ err: e }, 'instance mode migration failed');
	}

	// Re-encrypt any secrets still stored in plaintext by older releases
	// (cairn-e9mz). Idempotent; runs before the queue worker so channel sends only
	// ever see the encrypted shape.
	try {
		migratePlaintextSecretsAtRest();
	} catch (e) {
		errLog.error({ err: e }, 'plaintext-secret migration failed');
	}

	// Instances on the STOCK user agreement pick up default-text revisions (e.g.
	// the cairn-5u2i.1 data-handling section) — bump the stored version once so
	// already-accepted users are re-prompted. Customized agreements are untouched.
	try {
		ensureDefaultAgreementVersion();
	} catch (e) {
		errLog.error({ err: e }, 'agreement version migration failed');
	}

	// Start the outbound notification delivery worker (idempotent, unref'd — it
	// drains notification_queue for every non-inapp channel). See §1.4 of
	// docs/NOTIFICATION-PLAN.md.
	try {
		startNotificationQueueWorker();
	} catch (e) {
		errLog.error({ err: e }, 'notification queue worker start failed');
	}

	// Event hooks (Unit 8, docs/NOTIFICATION-PLAN.md §3). The address watcher drives
	// per-address Electrum subscriptions for tx_received/tx_confirmed/tx_large; the
	// key-health watcher runs a daily scan for stale multisig keys (key_health_due).
	// Both are idempotent, unref'd, and self-contained (they never throw here).
	try {
		startAddressWatcher();
	} catch (e) {
		errLog.error({ err: e }, 'address watcher start failed');
	}
	try {
		startKeyHealthWatcher();
	} catch (e) {
		errLog.error({ err: e }, 'key health watcher start failed');
	}
	// First-sync chain-history build (cairn-koy4.11): start counting rings right
	// after boot so the once-per-install walk races the user's signup flow
	// instead of waiting for their first page view. No-op once the cache exists.
	try {
		startFirstSync();
	} catch (e) {
		errLog.error({ err: e }, 'first sync start failed');
	}
	// Daily retention sweep (cairn-zui7): purges aged/orphaned rows from the
	// unbounded tables. Idempotent, unref'd, best-effort like the watchers above.
	try {
		startRetentionSweep();
	} catch (e) {
		errLog.error({ err: e }, 'retention sweep start failed');
	}
	// Backup-health scan (cairn-evp9): fires backup_missing for never-backed-up
	// wallets and backup_stale when the instance backup ages past the reminder
	// interval — the previously-missing trigger point for those two event types.
	try {
		startBackupHealthWatcher();
	} catch (e) {
		errLog.error({ err: e }, 'backup health watcher start failed');
	}
	// Pre-warm the per-wallet/per-multisig scan caches shortly after boot so the
	// first portfolio load isn't a cold multi-second scan (cairn-fd56). Deferred and
	// unref'd; never throws here.
	try {
		startPortfolioWarm();
	} catch (e) {
		errLog.error({ err: e }, 'portfolio warm start failed');
	}
	// Opt-in scheduled instance backups (cairn-ivae.3): fires whenever the
	// configured daily/weekly interval is due. Idempotent, unref'd, no-op until an
	// admin enables it from /admin/backup.
	try {
		startScheduledBackupWatcher();
	} catch (e) {
		errLog.error({ err: e }, 'scheduled backup watcher start failed');
	}
	// Solo mining engine (epic cairn-vn43): a no-op unless the `mining` flag is on
	// instance-wide, the operator enabled it in settings, AND Bitcoin Core RPC is
	// configured. startMiningEngine() itself never throws (it records fatals
	// internally); the try/catch here matches the other watchers' best-effort
	// contract and swallows an unexpected import/synchronous failure.
	try {
		void startMiningEngine();
	} catch (e) {
		errLog.error({ err: e }, 'mining engine start failed');
	}

	// Shared process-level tickers (docs/LIVE-UPDATES-DESIGN.md §3.4) — today the
	// 5s mempool sampler behind the broadcast `mempool` topic. Unref'd and dormant
	// until a live connection actually wants the topic, so it's a no-op cost on an
	// idle instance; never throws.
	try {
		startLiveTickers();
	} catch (e) {
		errLog.error({ err: e }, 'live tickers start failed');
	}

	// Startup config summary (Wave 1 / log-request.md §5): today's boot output
	// only logs FAILURES of each step above, never a positive confirmation of
	// which env actually took effect — on a logs-only Umbrel deployment that's
	// the difference between a 5-minute and a multi-hour debug of "wrong
	// Electrum", "empty DB / wrong path", "cookies won't stick", "logs not
	// writing". One structured line, emitted once at the end of init() (after
	// every step above, including the instanceMode/chain-env migrations, so
	// the values below reflect what actually landed this boot). Deliberately
	// secret-free by construction — never include password/rpc-pass/token
	// fields, don't just rely on the logger's redact-by-key defense-in-depth.
	try {
		const chain = getChainConfig();
		startupLog.info(
			{
				version: CURRENT_VERSION,
				node: process.version,
				dbPath: DB_PATH,
				httpPort: Number(env.PORT ?? 3000),
				httpsPort: env.CAIRN_HTTPS_PORT ? Number(env.CAIRN_HTTPS_PORT) : null,
				httpsExternalPort: httpsExternalPort(),
				origin: env.CAIRN_ORIGIN?.trim() || '(derived from Host header)',
				authMode: getAuthMode(),
				rpId: env.CAIRN_RP_ID ?? null,
				chain: {
					electrumHost: chain.electrumHost,
					electrumPort: chain.electrumPort,
					electrumTls: chain.electrumTls,
					coreRpcUrl: chain.coreRpcUrl,
					coreRpcUser: chain.coreRpcUser
				},
				seededThisBoot: seededKeys.length > 0,
				log: {
					level: LEVEL,
					toFile: FILE_ENABLED,
					file: LOG_FILE,
					maxBytes: MAX_FILE_BYTES,
					maxFiles: MAX_FILES
				},
				adminBootstrapped: Boolean(env.CAIRN_ADMIN_PASSWORD ?? env.APP_PASSWORD),
				instanceMode: getInstanceMode()
			},
			'startup config honored'
		);
	} catch (e) {
		errLog.error({ err: e }, 'startup summary failed');
	}
}
const initReady = init();

// Static assets and build output aren't worth a log line each (and the SPA
// fetches a lot of them). Everything else — pages, API, form actions — is.
function isAsset(pathname: string): boolean {
	if (pathname.startsWith('/_app/')) return true;
	if (pathname === '/favicon.ico' || pathname === '/favicon.png' || pathname === '/robots.txt')
		return true;
	return /\.(?:js|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot)$/i.test(pathname);
}

// Bitcoin lookups are sensitive: a request path can carry a txid, block hash, or
// address that ties a user to on-chain activity. Truncate those before they
// reach the logs (which an operator may ship elsewhere). Non-sensitive segments
// pass through untouched.
function redactSegment(seg: string): string {
	if (/^[0-9a-fA-F]{64}$/.test(seg)) return `${seg.slice(0, 8)}…`; // txid / block hash
	if (/^(bc1|tb1|bcrt1)[a-z0-9]{6,}$/i.test(seg)) return `${seg.slice(0, 10)}…`; // bech32
	if (/^[13mn2][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(seg)) return `${seg.slice(0, 8)}…`; // base58
	return seg;
}

function redactPath(pathname: string): string {
	return pathname.split('/').map(redactSegment).join('/');
}

// Security response headers (cairn-ia2y). This is a wallet app that authorizes
// real Bitcoin transactions via Sign/Send buttons — with no framing defense an
// attacker could iframe the app on a malicious page and clickjack a user into
// approving a transaction. Applied to EVERY response `handle` returns
// (assets included) rather than gated to specific routes, so there is one
// place to audit and no route can accidentally ship without it.
//
// CSP: SvelteKit always injects its own inline hydration-bootstrap `<script>`
// into every rendered page, and that script's contents are per-response-dynamic
// (it embeds page data), so it can never be allow-listed by a fixed hash. A
// `script-src 'self'` CSP with no nonce/hash therefore blocks it outright —
// this constant used to claim otherwise ("app.html has no inline <script>...")
// and shipped exactly that bug (cairn-ed01): hydration silently never ran, on
// any page, in any deployment. The real fix is `kit.csp` (mode: 'auto') in
// vite.config.ts's `sveltekit()` call — that's SvelteKit's own mechanism for
// stamping a matching nonce onto both its generated script and the
// `Content-Security-Policy` header of the actual page response, and it runs
// (via `resolve()`) BEFORE this module's `applySecurityHeaders`. This `CSP`
// constant is now only the fallback for responses that never go through
// SvelteKit's page-render pipeline — the `isAsset` fast-path above and any
// `+server.ts` JSON endpoint — so `applySecurityHeaders` below only sets it
// when the response doesn't already carry one (see its own comment). Keep
// this directive list in sync with the one in vite.config.ts; they're
// deliberately near-identical. style-src still needs 'unsafe-inline' for the
// inline `style="display: contents"` attribute in app.html, and img-src still
// needs `data:` for canvas-rendered QR codes (QrSigner.svelte /
// JadeQrSigner.svelte). No route calls out to a third-party origin at
// fetch/XHR/EventSource/WebSocket time (referral/support links in
// referrals.ts are plain `<a>` navigations, not fetched by the page, and the
// single /api/live multiplexed SSE stream is a same-origin `EventSource`
// call) — so `connect-src 'self'` is sufficient and
// hardware-wallet communication (WebUSB/WebHID) is unaffected either way,
// since those are browser-mediated device transports, not network requests
// subject to connect-src. `frame-ancestors 'none'` is the modern, CSP-level
// replacement for X-Frame-Options and is what actually stops framing in
// current browsers; X-Frame-Options: DENY is kept alongside it for defense in
// depth on the (now vanishingly rare) UA that ignores CSP.
const CSP =
	"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
	"base-uri 'self'; form-action 'self'";

// Widen a rendered page's connect-src to allow secureRedirect.ts's probe
// fetch (cairn-lme4, follow-up to cairn-ed01). connect-src 'self' only
// matches the page's own exact scheme+host+port, but maybeRedirectToSecure()
// deliberately fetches a DIFFERENT port — Cairn's own HTTPS listener, which
// Umbrel maps to a different external port than plain HTTP (httpsPort.ts) —
// to detect whether this browser has already trusted that listener's
// self-signed cert. Unwidened, the fetch was blocked outright at the CSP
// layer (it never even reached the network), so the auto-hop silently never
// fired for anyone. A wildcard host + the specific port is as narrow as CSP3
// host-source syntax allows: nothing changes when no HTTPS listener is
// configured, and even when one is, only that exact port becomes reachable.
// No-op if the port is already present, so repeat calls on one response are
// harmless.
function widenConnectSrcForHttpsListener(csp: string): string {
	const port = httpsExternalPort();
	if (port === null) return csp;

	const source = `https://*:${port}`;
	return csp.replace(/connect-src([^;]*)/, (match, rest: string) => {
		const already = rest.trim().split(/\s+/).filter(Boolean).includes(source);
		return already ? match : `connect-src${rest} ${source}`;
	});
}

function applySecurityHeaders(response: Response, isHttps: boolean): Response {
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	// Only set the fallback CSP when the response doesn't already carry one.
	// For a real rendered page, SvelteKit's own kit.csp (vite.config.ts,
	// mode: 'auto') already set a correctly-nonced Content-Security-Policy
	// header during resolve(event) — an unconditional .set() here would
	// silently overwrite it with this nonce-less fallback and reintroduce the
	// exact hydration-blocking bug (cairn-ed01) kit.csp exists to fix.
	if (!response.headers.has('Content-Security-Policy')) {
		response.headers.set('Content-Security-Policy', CSP);
	} else {
		const existing = response.headers.get('Content-Security-Policy');
		if (existing) {
			response.headers.set('Content-Security-Policy', widenConnectSrcForHttpsListener(existing));
		}
	}
	// Only over HTTPS (mirrors auth.ts's cookieSecure() protocol check) — an
	// Umbrel/LAN deployment that intentionally runs plain HTTP must not get an
	// HSTS header telling browsers to force HTTPS on it forever.
	if (isHttps) {
		response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
	}
	return response;
}

/**
 * True for any state-changing (non-GET/HEAD) request to /admin or an
 * /admin/* route — the boundary the Layer-2 backstop below blocks. Exported
 * as a pure predicate so it's unit-testable without driving the full
 * handle() pipeline. Exact boundary match (`=== '/admin'` or
 * `startsWith('/admin/')`), NOT a bare `startsWith('/admin')` — the latter
 * would also catch an unrelated future route like `/admin-help`.
 *
 * Matches against the DECODED path, the same way SvelteKit's router resolves
 * a request to a route/action. Without this, a percent-encoded spelling like
 * `/%61dmin/users` (%61 = 'a') would slip past a raw string compare here while
 * the router still decodes and dispatches it to the real /admin/users action —
 * a silent hole in the backstop. `decodeURI` (not `decodeURIComponent`)
 * mirrors SvelteKit's own decode_pathname: it leaves reserved chars like %2F
 * encoded, so `/admin%2Fusers` stays non-matching here AND 404s in the router,
 * i.e. the two agree. A malformed %-escape makes decodeURI throw; we fail safe
 * to the raw path (which, for an /admin* target, still matches and blocks).
 */
export function isAdminMutationRequest(method: string, pathname: string): boolean {
	if (method === 'GET' || method === 'HEAD') return false;
	let decoded = pathname;
	try {
		decoded = decodeURI(pathname);
	} catch {
		/* malformed %-escape — keep the raw path; an /admin* target still blocks */
	}
	return decoded === '/admin' || decoded.startsWith('/admin/');
}

export const handle: Handle = async ({ event, resolve }) => {
	await initReady;

	const { pathname } = event.url;

	// Static assets and build output (cairn-isda) never need the session/flags
	// lookups below, so this check now runs BEFORE any of that — previously it
	// ran after, meaning every asset request (and the SPA fetches a lot of
	// them) paid for getSessionUser (1 query) + resolveAllFlags (2 queries) for
	// nothing. locals.user/locals.flags are left unset here; nothing downstream
	// of an asset response reads them.
	if (isAsset(pathname)) return applySecurityHeaders(await resolve(event), cookieSecure(event.url));

	event.locals.user = getSessionUser(event.cookies.get(SESSION_COOKIE));
	// Resolve feature flags once per request, right after the user is known, so
	// every route guard and load function reads the same object instead of
	// re-querying. A logged-out/system context (null) gets the global values.
	event.locals.flags = resolveAllFlags(event.locals.user?.id ?? null);

	const method = event.request.method;

	// Layer-2 defense-in-depth ONLY (cairn-fame, cairn-jnlx, cairn-bgv1). The
	// real fix is Layer 1: SvelteKit form `actions` do NOT run a parent route's
	// load(), so /admin/+layout.server.ts's isAdmin gate never fires for a POST
	// (or other state-changing) request to an admin action — only a GET page
	// load runs the layout. Three admin actions shipped without their own
	// requireAdmin/isAdmin re-check and were exploitable by an unauthenticated
	// caller. This hook blocks any non-GET/HEAD request under /admin as a
	// backstop, but it must NEVER be treated as sufficient on its own. The
	// predicate below now matches against the DECODED path (see its doc
	// comment), so an encoded spelling like `/%61dmin/users` is caught and no
	// longer slips past — but that hardening only closes one gap; it doesn't
	// make this hook a substitute for real authorization. Layer 1 — the
	// per-action requireUser/requireAdmin re-check present in every admin
	// action — remains the actual enforcement boundary and must never be
	// relaxed just because this hook exists.
	if (isAdminMutationRequest(method, pathname)) {
		const user = event.locals.user;
		if (!user) {
			adminGuardLog.warn(
				{ method, path: redactPath(pathname) },
				'admin guard: blocked unauthenticated non-GET request'
			);
			error(401, 'Authentication required');
		}
		if (!user.isAdmin) {
			adminGuardLog.warn(
				{ method, path: redactPath(pathname), userId: user.id },
				'admin guard: blocked non-admin non-GET request'
			);
			error(403, 'Admin access required');
		}
	}

	// The vault → multisig-wallet rename moved every /vaults route; old
	// bookmarks and history entries should land on the equivalent page, not a
	// 404. Permanent redirect so browsers update stored URLs; the query string
	// is preserved so a /vaults/[id]/send?tx=N resume link still resumes.
	if (pathname === '/vaults' || pathname.startsWith('/vaults/')) {
		const rest = pathname.slice('/vaults'.length);
		const target = rest === '' || rest === '/' ? '/wallets' : `/wallets/multisig${rest}`;
		// This throw jumps straight over the httpLog block below (Wave 1 /
		// log-request.md §1-F) — without a line here, every /vaults hit was
		// silent in the logs. Info level: a 301 to a known-good target isn't a
		// problem, just worth being able to see.
		gateLog.info(
			{ method, path: redactPath(pathname), target },
			'gate: /vaults legacy redirect'
		);
		redirect(301, `${target}${event.url.search}`);
	}

	// (app) route group access gates (cairn-v84z). These used to live inline in
	// (app)/+layout.server.ts's load(), gated on a `url` read that made
	// SvelteKit re-run that load (a full server round trip, ~13-15 sequential
	// SQLite queries) on every client-side navigation. Running the same checks
	// here once per request — scoped by event.route.id, NOT a pathname
	// string-match — lets the layout load become a pure `locals` read that
	// SvelteKit caches across navs, while gate behavior stays identical.
	// event.route.id is populated by SvelteKit's router before handle() runs,
	// and is null for anything that isn't a matched route (assets already
	// returned above; a 404 stays ungated, same as before). The `/(app)` id
	// prefix only matches routes under the (app) group, so the gate targets
	// themselves — /login, /disclosure, /agreement, /setup-admin (all
	// top-level, outside the group) — plus /api/*, SSE, etc. are automatically
	// excluded, which is what prevents a redirect loop. (app)/recovery-setup
	// IS in-group; appGateRedirect's own pathname check is what skips it,
	// exactly as the old layout load did.
	if (event.route.id?.startsWith('/(app)')) {
		const target = appGateRedirect(event.locals.user, pathname);
		if (target) {
			if (method === 'GET' || method === 'HEAD') {
				// Silent today (Wave 1 / log-request.md §1-F) — this throw jumps
				// straight over the httpLog block below. Info level: a 302 to a
				// known gate target isn't itself a failure.
				gateLog.info({ method, path: redactPath(pathname), target }, 'gate: (app) redirect');
				redirect(302, target);
			}
			// A thrown redirect() breaks use:enhance's applyAction for a form
			// action (non-GET/HEAD) — mirror the isAdminMutationRequest backstop
			// above and fail the action with a plain error() instead. This is an
			// intentional bonus: actions never ran the parent layout's load() at
			// all (SvelteKit doesn't run parent loads for actions), so they were
			// previously ungated entirely. 401 mirrors "not authenticated" the
			// same way the admin-mutation backstop above does; 403 covers every
			// other gate (reset/disclosure/agreement/recovery) — the caller IS
			// authenticated but blocked pending required setup.
			//
			// This error() branch is the highest-priority line in this wave: it's
			// the use:enhance-swallowed form-action case an operator previously
			// had ZERO visibility into ("my action returns 403 and the form just
			// resets").
			const user = event.locals.user;
			if (!user) {
				gateLog.warn(
					{ method, path: redactPath(pathname), target },
					'gate: (app) action blocked — unauthenticated'
				);
				error(401, 'Authentication required');
			}
			gateLog.warn(
				{ method, path: redactPath(pathname), target, userId: user.id },
				'gate: (app) action blocked pending required setup'
			);
			error(403, 'Action blocked pending required setup');
		}
	}

	const path = redactPath(pathname);
	const start = performance.now();

	const response = applySecurityHeaders(await resolve(event), cookieSecure(event.url));

	const ms = Math.round(performance.now() - start);
	const status = response.status;
	const userId = event.locals.user?.id;
	const line = `${method} ${path} ${status} ${ms}ms${userId ? ` user=${userId}` : ''}`;
	const fields = { method, path, status, ms, userId };

	// Level scales with the outcome so an operator can filter to just the trouble.
	if (status >= 500) httpLog.error(fields, line);
	else if (status >= 400) httpLog.warn(fields, line);
	else httpLog.info(fields, line);

	return response;
};

/**
 * Runs for errors thrown while handling a request. Only 5xx failures are true
 * server errors: those get a full stack logged under a short error ID, and the
 * client sees only "Something went wrong" + that ID so an operator can grep the
 * logs for the exact failure without leaking internals. 404s and other <500s
 * reach here in this SvelteKit version but are expected — the request-logging
 * above already recorded them, so we leave SvelteKit's default error shape
 * untouched (no stack, no error ID on a plain "not found" page).
 */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	if (status < 500) return;

	const errorId = randomBytes(4).toString('hex');
	errLog.error(
		{
			err: error,
			errorId,
			status,
			method: event.request.method,
			path: redactPath(event.url.pathname),
			userId: event.locals.user?.id
		},
		message || 'Unhandled server error'
	);

	return { message: 'Something went wrong', errorId };
};
