// Orchestrator entry point for the Cairn load-test harness (cairn-h2of /
// cairn-3h0v).
//
//   node scripts/load-test/run.mjs [--scenario all|a|b|c|d|a,b] [--tiers 10,50,100,200]
//                                  [--duration 15] [--no-build] [--keep-db]
//
// Sequence: safety guard -> (build) -> boot server once just to let db.ts's
// migrations create the schema -> stop -> seed the DB directly with
// DatabaseSync -> reboot the server (this time with the event-loop monitor
// injected) -> CSRF smoke test -> run every scenario x tier -> report ->
// teardown (SIGTERM the server, rm -rf the throwaway dir unless --keep-db).

import {
	DB_PATH,
	THROWAWAY_DIR,
	DEFAULT_TIERS,
	DEFAULT_DURATION_S,
	assertSafeDbPath,
	assertSafeRemoveDir
} from './config.mjs';
import { ensureBuilt, bootServerForSchema, bootServerForLoad, cleanupThrowawayDir } from './bootstrap.mjs';
import { seedDatabase } from './seed.mjs';
import { resolveScenarios } from './scenarios.mjs';
import { runTier } from './driver.mjs';
import { summarizeTier, printTable, writeResultFiles } from './report.mjs';
import { SERVER_ORIGIN } from './config.mjs';

function parseArgs(argv) {
	const opts = {
		scenario: 'all',
		tiers: DEFAULT_TIERS,
		duration: DEFAULT_DURATION_S,
		noBuild: false,
		keepDb: false
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--scenario') opts.scenario = argv[++i];
		else if (a === '--tiers') opts.tiers = argv[++i].split(',').map((n) => Number(n.trim()));
		else if (a === '--duration') opts.duration = Number(argv[++i]);
		else if (a === '--no-build') opts.noBuild = true;
		else if (a === '--keep-db') opts.keepDb = true;
		else throw new Error(`unknown argument: ${a}`);
	}
	return opts;
}

/** UNKNOWN #5 (architect's design): smoke-test one authenticated, CSRF-sensitive
 *  POST before trusting the full scenario matrix. Confirms the Origin header
 *  the driver sends satisfies SvelteKit's default same-origin CSRF check for
 *  non-GET requests, and that the seeded session cookie authenticates. */
async function smokeTestAuthenticatedPost(session) {
	const res = await fetch(`${SERVER_ORIGIN}/api/notifications/preferences`, {
		method: 'PATCH',
		headers: {
			Cookie: `cairn_session=${session.token}`,
			Origin: SERVER_ORIGIN,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ updates: [{ eventType: 'tx_received', channel: 'email', enabled: true }] })
	});
	const text = await res.text();
	if (res.status === 403) {
		throw new Error(
			`CSRF smoke test failed: PATCH /api/notifications/preferences returned 403 with Origin=${SERVER_ORIGIN}. ` +
				`Body: ${text.slice(0, 500)}`
		);
	}
	if (res.status === 401) {
		throw new Error(
			`Auth smoke test failed: PATCH /api/notifications/preferences returned 401 — seeded session cookie not authenticating. Body: ${text.slice(0, 500)}`
		);
	}
	if (res.status >= 400) {
		throw new Error(
			`Smoke test unexpected status ${res.status} from PATCH /api/notifications/preferences: ${text.slice(0, 500)}`
		);
	}
	console.log(`[run] CSRF/auth smoke test passed (PATCH /api/notifications/preferences -> ${res.status})`);
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	// Safety guard, mirrored in bootstrap.mjs/seed.mjs too — never trust a
	// single call site. Every DB path this run ever touches must resolve
	// under os.tmpdir()/cairn-loadtest.
	assertSafeDbPath(DB_PATH);
	assertSafeRemoveDir(THROWAWAY_DIR);

	const scenarios = resolveScenarios(opts.scenario);
	console.log(
		`[run] scenarios=${scenarios.map((s) => s.id).join(',')} tiers=${opts.tiers.join(',')} duration=${opts.duration}s noBuild=${opts.noBuild} db=${DB_PATH}`
	);

	// Everything from here on can leave a throwaway dir behind on a thrown
	// error (a bad build, a schema-boot that never goes healthy, a seeding
	// bug) — wrap the whole sequence so cleanupThrowawayDir() always runs,
	// not just on success or a failure inside the scenario loop.
	let rowsByScenario = {};
	let loadBoot = null;
	try {
		await ensureBuilt({ skip: opts.noBuild });

		// 1) Schema-creation boot: db.ts's migrations run on server start against
		// the fresh (nonexistent) DB file, then we stop immediately.
		console.log('[run] booting server once to create schema…');
		const schemaBoot = await bootServerForSchema(DB_PATH);
		await schemaBoot.stop();

		// 2) Seed directly with DatabaseSync while the server is stopped.
		console.log('[run] seeding database…');
		const sessions = seedDatabase(DB_PATH);
		console.log(`[run] seeded ${sessions.length} sessions`);

		// 3) Reboot with the event-loop monitor injected for the real measurement pass.
		console.log('[run] rebooting server for load pass (with elmon)…');
		loadBoot = await bootServerForLoad(DB_PATH);

		await smokeTestAuthenticatedPost(sessions[0]);

		for (const scenario of scenarios) {
			rowsByScenario[scenario.id] = [];
			for (const tier of opts.tiers) {
				console.log(`[run] running scenario=${scenario.name} tier=${tier}…`);
				const { samples, eventLoopLag } = await runTier({
					scenario,
					tier,
					sessions,
					durationS: opts.duration
				});
				const row = summarizeTier({
					scenarioId: scenario.id,
					scenarioName: scenario.name,
					tier,
					durationS: opts.duration,
					samples,
					eventLoopLag
				});
				rowsByScenario[scenario.id].push(row);
				console.log(
					`[run]   -> ${row.count} reqs, ${row.rps.toFixed(1)} rps, p50=${row.p50?.toFixed(1)}ms p99=${row.p99?.toFixed(1)}ms err=${(row.errorRate * 100).toFixed(1)}%`
				);
				if (loadBoot.isExited()) {
					throw new Error(
						`server process died mid-run (code=${loadBoot.exitInfo()?.code}, signal=${loadBoot.exitInfo()?.signal}) — see ${loadBoot.logPath}`
					);
				}
			}
		}
	} finally {
		if (loadBoot) {
			console.log('[run] stopping server…');
			await loadBoot.stop();
		}
		if (!opts.keepDb) {
			console.log(`[run] removing throwaway dir ${THROWAWAY_DIR}`);
			cleanupThrowawayDir();
		} else {
			console.log(`[run] --keep-db: leaving ${THROWAWAY_DIR} in place`);
		}
	}

	const allRows = Object.values(rowsByScenario).flat();
	printTable(allRows);
	const written = writeResultFiles(rowsByScenario, { buildMode: opts.noBuild ? 'reused' : 'fresh' });
	console.log('[run] wrote result files:');
	for (const w of written) console.log(`  ${w}`);
}

main().catch((err) => {
	console.error('[run] FATAL:', err?.stack ?? err);
	process.exitCode = 1;
});
