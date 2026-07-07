import fs from 'node:fs';
import path from 'node:path';
import { instanceStats } from '$lib/server/admin';
import { getInstanceSettings, getSetting } from '$lib/server/settings';
import { getChain } from '$lib/server/chain';
import { getUpdateNotice, CURRENT_VERSION } from '$lib/server/updateCheck';
import { DB_PATH } from '$lib/server/db';
import type { PageServerLoad } from './$types';
import type { NodeInfo } from '$lib/types';

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

/** getNodeInfo() is a LIVE, uncached Electrum headersSubscribe+banner round-trip
 *  (cairn-2zxt.3): awaiting it in `load` froze every /admin navigation until
 *  Electrum answered. Streamed instead, so the page paints its chrome + tabs
 *  immediately and the health pill/tip fill in. Never rejects — any failure
 *  resolves to a disconnected NodeInfo built from the configured settings. */
async function loadNodeInfo(
	settings: ReturnType<typeof getInstanceSettings>
): Promise<NodeInfo> {
	try {
		return await getChain().getNodeInfo();
	} catch (e) {
		return {
			connected: false,
			mode: settings.connectionMode,
			server: `${settings.electrumHost}:${settings.electrumPort}`,
			tipHeight: null,
			tipHash: null,
			network: 'mainnet',
			error: e instanceof Error ? e.message : 'Connection failed'
		};
	}
}

export const load: PageServerLoad = async () => {
	const stats = instanceStats();
	const settings = getInstanceSettings();

	return {
		stats,
		// Streamed, not awaited (cairn-2zxt.3): the node round-trip no longer gates
		// the admin overview render.
		node: loadNodeInfo(settings),
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
