/**
 * CI-shaped gate for the forced-solve regtest e2e (bead cairn-vn43.2, the
 * mainnet-enablement gate). The full driver — real MiningPool + StratumServer +
 * job builder against a real regtest bitcoind, a synthetic Stratum miner that
 * grinds a solving share, on-chain coinbase/payout/maturity verification, and
 * the payout-isolation negative case — lives in scripts/qa/mining-forced-solve.mjs
 * (it needs node's --experimental-transform-types + a .ts resolve hook to import
 * the engine from plain .mjs, which is exactly what the driver's bootstrap sets
 * up). This spec runs that driver as a child process and asserts it passes.
 *
 * Guarded with describe.skipIf(!BITCOIND_AVAILABLE || !PORT_AVAILABLE):
 *   - BITCOIND_AVAILABLE: on a box or CI runner with no bitcoind binary and no
 *     docker it is skipped, so `npm test` stays green. Point at a specific
 *     binary with $BITCOIND_PATH, or force the docker path by removing it.
 *   - PORT_AVAILABLE: the driver spawns its own regtest bitcoind via
 *     scripts/qa/mining-regtest-node.mjs's resolveRegtestPort() (free-port
 *     probe, or $CAIRN_QA_REGTEST_PORT pin) rather than a hardcoded port, so
 *     `npm test` stays hermetic even on a box with its own long-running shared
 *     regtest node already bound to the conventional 18443 port. This probes
 *     the SAME mechanism up front so the gate skips cleanly (rather than
 *     failing) on a sandbox where no port can be bound at all.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { resolveRegtestPort } from '../../../../scripts/qa/mining-regtest-node.mjs';

const CANDIDATE_BINARIES = [
	process.env.BITCOIND_PATH,
	'C:\\Program Files\\Bitcoin\\daemon\\bitcoind.exe',
	'/usr/bin/bitcoind',
	'/usr/local/bin/bitcoind'
].filter((p): p is string => Boolean(p));

function bitcoindBinaryPresent(): boolean {
	return CANDIDATE_BINARIES.some((p) => existsSync(p));
}

function dockerPresent(): boolean {
	try {
		return spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' }).status === 0;
	} catch {
		return false;
	}
}

async function regtestPortAvailable(): Promise<boolean> {
	try {
		await resolveRegtestPort();
		return true;
	} catch {
		return false;
	}
}

const BITCOIND_AVAILABLE = bitcoindBinaryPresent() || dockerPresent();
// Only probe for a port if a bitcoind backend even exists — no point spinning
// up the net.Server probe on a box that will skip on BITCOIND_AVAILABLE anyway.
const PORT_AVAILABLE = BITCOIND_AVAILABLE ? await regtestPortAvailable() : false;

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const driver = path.join(repoRoot, 'scripts', 'qa', 'mining-forced-solve.mjs');

describe.skipIf(!BITCOIND_AVAILABLE || !PORT_AVAILABLE)('mining forced-solve regtest e2e (cairn-vn43.2)', () => {
	it(
		'solves + confirms a real block on regtest through the real engine, isolates payout, and matures',
		() => {
			const res = spawnSync(process.execPath, [driver], {
				cwd: repoRoot,
				encoding: 'utf8',
				timeout: 5 * 60_000
			});
			// Surface the driver's own report on failure for a legible CI log.
			if (res.status !== 0) {
				throw new Error(
					`forced-solve driver exited ${res.status}\n--- stdout ---\n${res.stdout ?? ''}\n--- stderr ---\n${res.stderr ?? ''}`
				);
			}
			expect(res.stdout).toContain('RESULT: PASS');
		},
		6 * 60_000
	);
});
