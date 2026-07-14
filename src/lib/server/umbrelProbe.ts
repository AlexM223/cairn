// Umbrel zero-config Electrum auto-connect — credential-free probe (Wave A,
// docs/UMBREL-AUTOCONNECT-DESIGN.md §3). On Umbrel, every
// installed app shares the `umbrel_main_network` bridge and electrs/Fulcrum
// sit at fixed, well-known IPs regardless of whether Cairn declares a
// manifest `dependencies:` entry (design §1) — so a credential-free
// Electrum handshake against those IPs is a reliable, zero-risk way to
// auto-connect even before a harness-gated Wave B dependency ships.
//
// STRICTLY gated on CAIRN_PLATFORM === 'umbrel' (an env var we set ourselves
// in the store compose, never a heuristic) so this never probes 10.21.21.x
// on a non-Umbrel deployment, and on `connection_mode` being unset — an
// admin (or chainEnvSeed.ts, which runs first and always wins when its env
// vars are present) who has already picked a mode is never re-probed or
// overridden. Reuses the exact seed-once semantics as chainEnvSeed.ts
// (seedIfUnset), so a later manual edit in Admin -> Settings is never
// clobbered by a restart.
//
// Never throws — any probe failure (timeout, connection refused, malformed
// handshake) just leaves settings untouched, falling back to the existing
// public-server default / manual entry.

import { env } from '$env/dynamic/private';
import { getSetting, setSetting } from './settings';
import { ElectrumClient } from './electrum/client';
import { childLogger } from './logger';

const log = childLogger('umbrel-probe');

/**
 * Fixed IPs from the design doc §3 — electrs first, Fulcrum as the
 * drop-in alternate (both credential-free, plain TCP, no TLS). ElectrumX
 * also `implements: electrs` on Umbrel but has no separate fixed IP reserved
 * here; Fulcrum's own exports.sh aliases electrs's vars when electrs isn't
 * installed, so probing these two fixed IPs covers all three backends.
 */
const CANDIDATES: { host: string; port: number; label: string }[] = [
	{ host: '10.21.21.10', port: 50001, label: 'electrs' },
	{ host: '10.21.21.200', port: 50002, label: 'fulcrum' }
];

/** Short — this blocks server boot (once, gated to Umbrel only) until it
 *  resolves, so an unreachable candidate must fail fast rather than eating
 *  the client's normal 15s default timeout. */
const PROBE_TIMEOUT_MS = 2_000;

/** Write `key` = `value` only if no row exists for it yet. Mirrors
 *  chainEnvSeed.ts's seedIfUnset; duplicated rather than imported so each
 *  module's seed contract stays independently auditable. Returns whether it
 *  wrote. */
function seedIfUnset(key: string, value: string): boolean {
	if (getSetting(key) !== null) return false;
	setSetting(key, value);
	return true;
}

/** Credential-free Electrum handshake — true iff `headersSubscribe()`
 *  completes within the probe timeout. */
async function probeOne(host: string, port: number): Promise<boolean> {
	// reportsHealth: false (cairn-d8aa) — this probes a fixed candidate IP before
	// the operator's real backend is even decided, so a failed probe must never
	// flip the real instance-wide chain-health banner.
	const client = new ElectrumClient({
		host,
		port,
		tls: false,
		timeoutMs: PROBE_TIMEOUT_MS,
		reportsHealth: false
	});
	try {
		await client.headersSubscribe();
		return true;
	} catch {
		return false;
	} finally {
		client.close();
	}
}

/**
 * Probe the well-known Umbrel Electrum-compatible endpoints and, on the
 * first reachable one, seed `electrum_host`/`electrum_port`/`electrum_tls` +
 * flip `connection_mode` to 'custom' (all only-if-unset) plus the
 * `chain_provisioned_by` provenance marker the settings UI uses to render
 * the auto-connected card (design §5).
 *
 * Returns the setting keys actually WRITTEN this call — same contract as
 * chainEnvSeed.ts's seedChainConfigFromEnv(), so hooks.server.ts can fold
 * both into one `seededThisBoot` startup-summary signal. Empty when gated
 * out (not Umbrel, or already configured) or when every candidate failed.
 */
export async function probeAndSeedUmbrelElectrum(): Promise<string[]> {
	const applied: string[] = [];
	try {
		if (env.CAIRN_PLATFORM !== 'umbrel') return applied;
		// Never re-probe once anything has picked a mode — chainEnvSeed.ts runs
		// immediately before this in hooks.server.ts's init() and flips
		// connection_mode when its own env vars are present, so this check also
		// means "env wins over probe" for free, matching design §2.
		if (getSetting('connection_mode') !== null) return applied;

		for (const { host, port, label } of CANDIDATES) {
			if (!(await probeOne(host, port))) continue;

			if (seedIfUnset('electrum_host', host)) applied.push('electrum_host');
			if (seedIfUnset('electrum_port', String(port))) applied.push('electrum_port');
			if (seedIfUnset('electrum_tls', 'false')) applied.push('electrum_tls');
			// Same don't-clobber-if-already-chosen rule as chainEnvSeed.ts, checked
			// again here rather than assumed from the guard above — a concurrent
			// write between the guard check and here is not possible in this
			// single-threaded init path, but staying consistent with the
			// established pattern keeps the two modules trivially comparable.
			if (getSetting('connection_mode') === null) {
				setSetting('connection_mode', 'custom');
				applied.push('connection_mode');
			}
			if (seedIfUnset('chain_provisioned_by', 'umbrel-probe')) {
				applied.push('chain_provisioned_by');
			}

			log.info(
				{ event: 'umbrel_probe_connected', host, port, label },
				'auto-connected to Umbrel Electrum via credential-free probe'
			);
			return applied;
		}

		log.debug({ event: 'umbrel_probe_no_match' }, 'no Umbrel Electrum endpoint reachable');
		return applied;
	} catch (e) {
		log.error({ err: e }, 'umbrel electrum probe failed');
		return applied;
	}
}
