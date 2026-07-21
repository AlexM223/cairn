#!/usr/bin/env node
// Durable QA gate (Wave-5R piece 1): authenticated route crawl against a real
// production boot, backed by a throwaway regtest chain — then proves the
// "Electrum is down" degraded path also renders cleanly instead of 5xx-ing.
//
// Flow:
//   1. Spawn a throwaway regtest bitcoind (mining-regtest-node.mjs — fresh
//      datadir, probed-free RPC port, never collides with a dev's own node).
//   2. Mine ~110 blocks so the chain has real height/coinbase maturity.
//   3. Start the electrum-shim (in-process, this repo's scripts/qa/electrum-shim.mjs)
//      pointed at that bitcoind, on its own probed-free port.
//   4. Production build + boot `node server.mjs` (same prod-boot-smoke.mjs
//      boot mode) against a fresh throwaway DB, with CAIRN_ELECTRUM_HOST/PORT
//      pointed at the shim.
//   5. Seed an admin user + session directly into the fresh DB (INSERT-only —
//      see qa-harness.mjs's seedAdminAndSession).
//   6. Authenticated GET-crawl a fixed route list. Assert every response is
//      200, body has no "Internal Error" / raw JS stack trace, and
//      GET /api/health is 200.
//   6a. GET-crawl the deleted-page redirect stubs (`/admin/settings`,
//      `/admin/feature-flags` — UX Simplification Wave 2, cairn-6c91u.2,
//      docs/UX-SIMPLIFICATION-SPEC.md §5/§9) with redirect:'manual' and
//      assert each is a 307 to its documented `/settings#...` anchor target,
//      not just "not a 5xx" — a page-that-used-to-render silently turning
//      into an unasserted redirect would otherwise slip through.
//   7. Kill the electrum shim (simulating the node going unreachable) and
//      re-crawl a subset of routes. Assert still no 5xx, health still 200,
//      and the chain-down copy string appears on /.
//   8. Teardown everything (app, shim, bitcoind, temp dirs) in try/finally —
//      runs even on assertion failure.
//
// Usage: node scripts/qa/route-crawl.mjs
// Env: CAIRN_QA_SKIP_BUILD=1 to skip the production build for fast local
//   iteration on this script itself (NEVER set in CI — the build is half the
//   gate, same rationale as prod-boot-smoke.mjs).

import { startRegtestNode } from './mining-regtest-node.mjs';
import { startElectrumShim } from './electrum-shim.mjs';
import {
	buildForProduction,
	bootApp,
	seedAdminAndSession,
	getWithCookie,
	cleanupDir,
	findFreePort
} from './qa-harness.mjs';

const CHAIN_DOWN_COPY = "Can't reach your Bitcoin node";

// SvelteKit's default unhandled-error page text, plus a conservative regex for
// a raw Node/JS stack frame ("at foo (file.js:12:34)") leaking into the body.
const STACK_MARKERS = ['Internal Error'];
const STACK_FRAME_RE = /\n\s*at\s+\S+\s*\(?[^\s()]+:\d+:\d+\)?/;

// docs/UX-SIMPLIFICATION-SPEC.md §2/§9: primary nav is now dynamic — Mining
// and Explorer only join it when their instance flag resolves true — but the
// routes underneath are always the right shape for an admin session to hit
// directly regardless of nav visibility, so they stay in this fixed crawl
// list. `/explorer/tx/[txid]` is exempt from the explorer flag app-wide
// (spec §9 R6, src/routes/(app)/explorer/+layout.server.ts) — it's crawled
// here on a random, guaranteed-nonexistent txid purely to prove the route
// itself renders a graceful "not found" page rather than a 5xx, independent
// of any real transaction data (this throwaway instance seeds no wallets).
const NONEXISTENT_TXID = 'ff'.repeat(32);
const AUTHED_ROUTES = [
	'/',
	'/wallets',
	'/wallets/new',
	'/settings',
	'/admin',
	'/explorer',
	`/explorer/tx/${NONEXISTENT_TXID}`
];
const POST_OUTAGE_ROUTES = ['/', '/wallets', '/explorer'];

// docs/UX-SIMPLIFICATION-SPEC.md §5.3/§9: both pages were deleted outright —
// `/admin/feature-flags` (the 25-row toggle grid) and `/admin/settings` (node
// connection / registration / factory reset) — and replaced with tiny
// `+page.server.ts` redirect(307, ...) stubs so old bookmarks and
// notification/health deep links still resolve, into the one merged
// `/settings` page's admin groups.
const REDIRECT_ROUTES = [
	{ from: '/admin/settings', toPrefix: '/settings#node-connection' },
	{ from: '/admin/feature-flags', toPrefix: '/settings#mining' }
];

const failures = [];
function assertTrue(cond, msg) {
	if (!cond) failures.push(msg);
	else console.log(`  ok: ${msg}`);
}

function bodyLooksBroken(text) {
	if (STACK_MARKERS.some((m) => text.includes(m))) return true;
	if (STACK_FRAME_RE.test(text)) return true;
	return false;
}

async function crawl(base, cookie, routes, label) {
	for (const route of routes) {
		const { status, text } = await getWithCookie(`${base}${route}`, cookie);
		console.log(`[route-crawl] ${label} GET ${route} -> ${status}`);
		assertTrue(status < 500, `${label} GET ${route} is not a 5xx (got ${status})`);
		assertTrue(!bodyLooksBroken(text), `${label} GET ${route} body has no "Internal Error" / raw stack trace`);
	}
}

async function crawlRedirects(base, cookie, routes) {
	for (const { from, toPrefix } of routes) {
		const { status, headers } = await getWithCookie(`${base}${from}`, cookie);
		console.log(`[route-crawl] redirect-stub GET ${from} -> ${status} ${headers?.location ?? ''}`);
		assertTrue(status === 307, `redirect-stub GET ${from} is a 307 (got ${status})`);
		assertTrue(
			typeof headers?.location === 'string' && headers.location.startsWith(toPrefix),
			`redirect-stub GET ${from} Location starts with "${toPrefix}" (got ${headers?.location})`
		);
	}
}

async function main() {
	let regtest = null;
	let shim = null;
	let app = null;

	try {
		console.log('[route-crawl] starting throwaway regtest bitcoind...');
		regtest = await startRegtestNode();
		console.log(`[route-crawl] bitcoind up (${regtest.kind}) on RPC port ${regtest.port}`);

		await regtest.rpc.call('createwallet', ['qa-route-crawl']).catch(() => {
			// Some bitcoind builds auto-create a default wallet; ignore "already exists".
		});
		const minerAddr = await regtest.rpc.call('getnewaddress', []);
		console.log('[route-crawl] mining 110 blocks...');
		await regtest.rpc.call('generatetoaddress', [110, minerAddr]);

		const shimPort = await findFreePort(19173);
		shim = startElectrumShim({
			rpcUrl: `http://127.0.0.1:${regtest.port}/`,
			rpcUser: 'heartwoodqa',
			rpcPass: 'heartwoodqa',
			host: '127.0.0.1',
			port: shimPort
		});
		console.log(`[route-crawl] electrum shim up on ${shim.host}:${shim.port}`);

		await buildForProduction();

		app = await bootApp({ electrumHost: shim.host, electrumPort: shim.port });
		console.log(`[route-crawl] app ready at ${app.base}`);

		const session = await seedAdminAndSession(app.dbPath, { email: 'qa-route-crawl@test.local' });
		console.log(`[route-crawl] seeded admin user id=${session.userId}`);

		console.log('[route-crawl] --- authenticated crawl (chain up) ---');
		await crawl(app.base, session.cookie, AUTHED_ROUTES, 'chain-up');

		console.log('[route-crawl] --- deleted-page redirect stubs ---');
		await crawlRedirects(app.base, session.cookie, REDIRECT_ROUTES);

		const health = await getWithCookie(`${app.base}/api/health`, session.cookie);
		assertTrue(health.status === 200, `GET /api/health is 200 (got ${health.status})`);

		console.log('[route-crawl] killing electrum shim (simulating node outage)...');
		await shim.stop();
		shim = null;
		// Give the app's connection layer a moment to notice the drop.
		await new Promise((r) => setTimeout(r, 3000));

		console.log('[route-crawl] --- authenticated crawl (chain down) ---');
		await crawl(app.base, session.cookie, POST_OUTAGE_ROUTES, 'chain-down');

		const healthDown = await getWithCookie(`${app.base}/api/health`, session.cookie);
		assertTrue(healthDown.status === 200, `GET /api/health is still 200 with chain down (got ${healthDown.status})`);

		// cairn-favlc: root-caused as an SSR gap, not a timing race. The
		// ChainHealthBanner was entirely client-JS-rendered (its live store's
		// `.health` getter is hard-coded null during SSR), so a hydration-less
		// fetch like this one never saw the banner no matter how long it waited.
		// Fixed by seeding the banner from the (app) layout's server load (the
		// same getNetworkHealth() union /api/chain-health serves), so the very
		// first response already carries the correct verdict. Hard assertion
		// restored now that the gap is closed.
		const root = await getWithCookie(`${app.base}/`, session.cookie);
		assertTrue(
			root.text.includes(CHAIN_DOWN_COPY),
			`GET / body contains chain-down copy "${CHAIN_DOWN_COPY}"`
		);

		if (failures.length > 0) {
			console.error(`\n[route-crawl] FAIL — ${failures.length} assertion(s) failed:`);
			for (const f of failures) console.error(`  - ${f}`);
			process.exitCode = 1;
		} else {
			console.log('\n[route-crawl] PASS — all assertions held.');
			process.exitCode = 0;
		}
	} catch (e) {
		console.error('[route-crawl] FAIL (exception):', e instanceof Error ? e.stack || e.message : e);
		process.exitCode = 1;
	} finally {
		console.log('[route-crawl] tearing down...');
		if (app) {
			await app.stop().catch((e) => console.error('  app stop error:', e?.message || e));
			cleanupDir(app.dbDir);
		}
		if (shim) {
			await shim.stop().catch((e) => console.error('  shim stop error:', e?.message || e));
		}
		if (regtest) {
			await regtest.stop().catch((e) => console.error('  bitcoind stop error:', e?.message || e));
		}
		console.log('[route-crawl] teardown complete.');
	}
}

main();
