// Shared configuration + safety guard for the load-test harness (cairn-h2of /
// cairn-3h0v). Every module that touches a database path imports
// assertSafeDbPath from here — the harness must NEVER be able to point at a
// real Cairn database, on this machine or anyone else's, no matter how it's
// invoked or what env vars leak in from the shell.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const LOAD_TEST_DIR = path.join(ROOT_DIR, 'scripts', 'load-test');
export const RESULTS_DIR = path.join(LOAD_TEST_DIR, 'results');
export const FIXTURES_DIR = path.join(LOAD_TEST_DIR, 'fixtures');

// Every throwaway DB/data dir this harness ever creates MUST live under here.
// A fresh, PID-scoped subdirectory per run so concurrent runs (or a crashed
// prior run's leftovers) never collide.
export const THROWAWAY_ROOT = path.join(os.tmpdir(), 'cairn-loadtest');
export const THROWAWAY_DIR = path.join(THROWAWAY_ROOT, String(process.pid));
export const DB_PATH = path.join(THROWAWAY_DIR, 'cairn.db');

export const HTTP_PORT = 3399;
export const HOST = '127.0.0.1';
export const SERVER_ORIGIN = `http://${HOST}:${HTTP_PORT}`;
export const ELMON_PORT = 9399;
export const ELMON_ORIGIN = `http://${HOST}:${ELMON_PORT}`;

/** Closed port on localhost — the server boots pointed at Electrum here so
 *  every connection attempt fails fast (ECONNREFUSED) instead of hanging on a
 *  real chain backend the load test has no business touching. */
export const DEAD_ELECTRUM_PORT = 59999;

export const DEFAULT_TIERS = [10, 50, 100, 200];
export const DEFAULT_DURATION_S = 15;
export const WARMUP_S = 5;

/**
 * Throw unless `p` resolves to a path INSIDE THROWAWAY_ROOT
 * (os.tmpdir()/cairn-loadtest/…). Call this before ANY DatabaseSync open,
 * directory create, or rm -rf in this harness — never accept an override
 * (env var, CLI flag, whatever) that points outside it. This is the one gate
 * standing between "load test" and "wiped someone's real wallet database".
 */
export function assertSafeDbPath(p) {
	const resolved = path.resolve(p);
	const root = path.resolve(THROWAWAY_ROOT) + path.sep;
	if (!resolved.startsWith(root)) {
		throw new Error(
			`refusing to touch path outside the load-test sandbox: ${resolved} ` +
				`(must be under ${root})`
		);
	}
	return resolved;
}

/** Same guard, for a directory we're about to recursively remove. */
export function assertSafeRemoveDir(p) {
	return assertSafeDbPath(p);
}
