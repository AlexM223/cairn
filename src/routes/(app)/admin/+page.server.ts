import fs from 'node:fs';
import path from 'node:path';
import { instanceStats } from '$lib/server/admin';
import { getInstanceSettings, getSetting } from '$lib/server/settings';
import { getNetworkHealth } from '$lib/server/chainHealth';
import { readChainSnapshot } from '$lib/server/chainSnapshot';
import { getUpdateNotice, CURRENT_VERSION } from '$lib/server/updateCheck';
import { DB_PATH } from '$lib/server/db';
import { CHAIN_DOWN } from '$lib/chainStatusCopy';
import type { PageServerLoad } from './$types';
import type { NodeInfo } from '$lib/types';

/** `health.lastError` is deliberately passed through raw when present (admin
 *  diagnostic detail an operator can act on -- see page.server.test.ts "a
 *  real, honest error"); only the generic no-detail fallback (a connection
 *  was attempted and failed, but no message was recorded) uses the shared
 *  chain-down copy (cairn-6edk) instead of its own one-off wording. */
function nodeErrorText(lastError: string | null): string {
	return lastError ?? `${CHAIN_DOWN}.`;
}

/** Best-effort storage picture for the Node page: how big the instance's
 *  database is, and how full the volume it lives on is. Any FS hiccup (odd
 *  container mounts, statfs unsupported) degrades to nulls — the page simply
 *  hides the bar rather than failing the whole admin overview. */
function storageInfo(): {
	dbBytes: number | null;
	diskTotalBytes: number | null;
	diskFreeBytes: number | null;
} {
	let dbBytes: number | null = null;
	try {
		dbBytes = fs.statSync(DB_PATH).size;
	} catch {
		// leave null
	}
	let diskTotalBytes: number | null = null;
	let diskFreeBytes: number | null = null;
	try {
		const s = fs.statfsSync(path.dirname(DB_PATH));
		diskTotalBytes = s.bsize * s.blocks;
		diskFreeBytes = s.bsize * s.bavail;
	} catch {
		// leave nulls
	}
	return { dbBytes, diskTotalBytes, diskFreeBytes };
}

/**
 * Node overview data, sourced from the SAME cheap, already-fresh signals the
 * rest of the app (Explorer/dashboard, the layout's "can't reach the Bitcoin
 * network" banner) already renders correctly from:
 *   - readChainSnapshot() — the background-refreshed chain snapshot
 *     (chainSync.ts) that Explorer/dashboard read synchronously (SWR).
 *   - getNetworkHealth() — the cheap in-memory transport-health signal fed by
 *     every real Electrum/Core connection outcome (chainHealth.ts).
 *
 * cairn-j412: this used to be its own LIVE, uncached Electrum
 * headersSubscribe+banner round-trip (cairn-2zxt.3), returned unawaited and
 * streamed to the client so it didn't gate navigation. In practice that
 * per-request round-trip could fail to ever resolve on the client (the
 * streamed chunk never arriving), leaving the page frozen on its
 * "Checking connection…" skeleton indefinitely even while Explorer/Home
 * displayed correct, live data from the snapshot at the very same time.
 * Reading the snapshot + health signal instead is synchronous (no network
 * call, no promise to stream) and can never get stuck: it just reflects
 * whatever Explorer/Home are already showing.
 */
function buildNodeInfo(settings: ReturnType<typeof getInstanceSettings>): NodeInfo {
	const health = getNetworkHealth();
	const snap = readChainSnapshot();
	const tipHeight = snap?.data.tipHeight ?? null;
	const connected = health.healthy && tipHeight !== null;
	// A connection attempt has actually been made (success or failure) — lets
	// us tell "genuinely still starting up, first sync hasn't landed yet"
	// (no error, `error` left undefined so the UI keeps its transient
	// "Checking connection…" state) apart from "tried and failed" (a real,
	// user-facing error).
	const attempted = health.lastOkAt !== null || health.lastErrorAt !== null;
	return {
		connected,
		mode: settings.connectionMode,
		server: `${settings.electrumHost}:${settings.electrumPort}`,
		tipHeight,
		tipHash: snap?.data.blocks[0]?.hash ?? null,
		network: 'mainnet',
		error: connected ? undefined : attempted ? nodeErrorText(health.lastError) : undefined
	};
}

export const load: PageServerLoad = async () => {
	const stats = instanceStats();
	const settings = getInstanceSettings();

	return {
		stats,
		// Synchronous, cheap, never stuck (cairn-j412) — see buildNodeInfo above.
		node: buildNodeInfo(settings),
		registrationMode: settings.registrationMode,
		// Newer-release notice (cairn-ivae.2). Answers from an in-process cache and
		// never awaits the network — GitHub being down can't slow this page.
		updateNotice: getUpdateNotice(),
		// Node-page k/v rows (Heartwood 5g): version, uptime, storage, and the
		// config-backup recency that drives the amber "Back up" nudge.
		version: CURRENT_VERSION,
		uptimeSeconds: Math.floor(process.uptime()),
		storage: storageInfo(),
		lastInstanceBackupAt: getSetting('last_instance_backup_at')
	};
};
