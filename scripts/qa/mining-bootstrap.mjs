// Shared bootstrap for the mining QA harnesses.
//
// The harnesses import the real TypeScript engine, which needs node started with
// `--experimental-transform-types` and the `.ts` resolve hook registered. Rather
// than force the caller to remember that incantation, each harness calls
// ensureTsRuntime() as its very first line: if the TS runtime is not already
// active it re-execs itself under node with the correct flags, inheriting stdio
// and exit code, so a plain `node scripts/qa/mining-<x>.mjs ...` Just Works.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const ACTIVE_ENV = '__MINING_TS_RUNTIME';

/**
 * Ensure this process can import the real .ts engine; re-exec with the right
 * flags if not. Call once, first thing, from a harness entrypoint, passing
 * import.meta.url. Never returns in the parent (it process.exit()s); returns
 * normally only in the correctly-flagged child.
 */
export function ensureTsRuntime(entryUrl) {
	if (process.env[ACTIVE_ENV] === '1') return;
	const entry = fileURLToPath(entryUrl);
	// --import needs a file:// URL on Windows (a bare `C:\...` path is misparsed as
	// a URL with scheme "c:").
	const register = pathToFileURL(fileURLToPath(new URL('./mining-register.mjs', import.meta.url))).href;
	const res = spawnSync(
		process.execPath,
		['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--import', register, entry, ...process.argv.slice(2)],
		{ stdio: 'inherit', env: { ...process.env, [ACTIVE_ENV]: '1' } }
	);
	process.exit(res.status ?? 1);
}
