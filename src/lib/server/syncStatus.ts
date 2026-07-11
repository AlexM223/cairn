// First-sync status (cairn-koy4.11) — the backend slice behind the Heartwood
// first-sync screen (design 1a) and the (app)-layout sync gate.
//
// WHAT "FIRST SYNC" MEANS FOR CAIRN. The design spec assumes a full node doing
// IBD; Cairn is Electrum-based and never downloads or verifies blocks itself.
// The honest, observable equivalents on this architecture are:
//
//   1. connecting — the chain backend (Electrum/esplora) hasn't answered with
//      a live tip height yet after boot.
//   2. history    — the one-time chain-history walk in chainEpochs.ts: real
//      boundary timestamps for every difficulty epoch since genesis, fetched
//      from the user's own backend and persisted forever. One epoch = one
//      growth ring — this is what the wood-growth canvas draws, and its
//      per-epoch progress is REAL fetch progress, not a fabricated bar.
//      It also feeds the Explorer's ChainStrip, so the work is shared.
//   3. scanning   — the address watcher's initial history baseline across all
//      wallets' derived addresses (addressWatcher.ts), also real progress.
//   4. synced     — everything above done; following the tip.
//
// The (app) layout gates on ONE durable condition: the epoch-history cache
// existing (isFirstSyncComplete). That happens once per install — matching the
// spec's "only seen once per install" — and never re-gates on restarts, where
// reconnecting takes seconds and gating would be noise. 'scanning' is shown to
// users still on the screen when history finishes, but never traps anyone:
// the screen always offers a way through, and the API/gate stay read-only.

import { getChain } from './chain';
import {
	getEpochFetchProgress,
	getEpochStrip,
	hasEpochHistory,
	epochIndexForHeight
} from './chainEpochs';
import { getWatcherScanProgress } from './addressWatcher';
import { yearNoteFor } from '$lib/syncYearNotes';
import { childLogger } from './logger';

const log = childLogger('firstSync');

const EPOCH = 2016;
/** Pause between retries when the chain backend is unreachable. */
const RETRY_MS = 20_000;
/** Consecutive failed build attempts before we call the grove unreachable. */
const UNREACHABLE_AFTER = 2;
/** Tip lookups are cheap but there's no reason to spam them under polling. */
const TIP_TTL_MS = 10_000;
/** server.peers.subscribe result cache (many public servers reject it). */
const PEERS_TTL_MS = 120_000;
/** ETA sample window. */
const ETA_WINDOW_MS = 60_000;

export type SyncPhase = 'connecting' | 'history' | 'scanning' | 'synced' | 'unreachable';

export interface SyncStatus {
	phase: SyncPhase;
	/** 0–100 composite progress. */
	percent: number;
	/** Live chain tip (null while unreachable/connecting). */
	tipHeight: number | null;
	/** The counting frontier: roughly the height whose era is being read. */
	frontierHeight: number | null;
	epochsKnown: number;
	epochsTotal: number;
	/** Year of the boundary being read, for "Verifying 2017 — SegWit summer". */
	verifyingYear: number | null;
	verifyingNote: string | null;
	etaSeconds: number | null;
	/** The configured Electrum server's peer count, when it will tell us. */
	peers: number | null;
	/** host:port of the configured Electrum server. */
	server: string;
	/** Address-scan progress; null until the watcher has started. */
	scan: { total: number; done: number } | null;
	/** 0–1 progress of the currently forming ring (synced state's dial). */
	formingProgress: number | null;
}

// ----------------------------------------------------------- pure derivation

export interface SyncInputs {
	historyDone: boolean;
	fetchActive: boolean;
	consecutiveFailures: number;
	tipHeight: number | null;
	epochsKnown: number;
	epochsTotal: number;
	lastKnownTime: number | null;
	scan: { started: boolean; baselined: boolean; total: number; done: number } | null;
}

/**
 * Phase + percent from raw observations. Pure — the exported surface for
 * tests; getSyncStatus() feeds it live values.
 */
export function deriveSyncStatus(i: SyncInputs): {
	phase: SyncPhase;
	percent: number;
	verifyingYear: number | null;
	verifyingNote: string | null;
} {
	const historyFrac = i.epochsTotal > 0 ? Math.min(1, i.epochsKnown / i.epochsTotal) : 0;

	// Year note follows the newest boundary timestamp we've read.
	const verifyingYear =
		i.lastKnownTime !== null && i.lastKnownTime > 0
			? new Date(i.lastKnownTime * 1000).getUTCFullYear()
			: null;
	const verifyingNote = verifyingYear !== null ? yearNoteFor(verifyingYear) : null;

	if (i.historyDone) {
		const scanPending =
			i.scan !== null && i.scan.started && i.scan.total > 0 && i.scan.done < i.scan.total;
		if (scanPending && i.scan) {
			const scanFrac = i.scan.done / i.scan.total;
			return {
				phase: 'scanning',
				percent: Math.round(88 + 10 * scanFrac),
				verifyingYear,
				verifyingNote
			};
		}
		return { phase: 'synced', percent: 100, verifyingYear, verifyingNote };
	}

	if (i.consecutiveFailures >= UNREACHABLE_AFTER && !i.fetchActive) {
		// Freeze at whatever progress the last attempt reached.
		return {
			phase: 'unreachable',
			percent: Math.round(4 + 82 * historyFrac),
			verifyingYear,
			verifyingNote
		};
	}

	if (i.tipHeight === null && i.epochsKnown === 0) {
		return { phase: 'connecting', percent: 2, verifyingYear, verifyingNote };
	}

	return {
		phase: 'history',
		percent: Math.round(4 + 82 * historyFrac),
		verifyingYear,
		verifyingNote
	};
}

// ------------------------------------------------------------- module state

interface ModuleState {
	loopRunning: boolean;
	consecutiveFailures: number;
	complete: boolean;
	tip: number | null;
	tipAt: number;
	peers: number | null;
	peersAt: number;
	etaSamples: { t: number; epochs: number }[];
}

const state: ModuleState = {
	loopRunning: false,
	consecutiveFailures: 0,
	complete: false,
	tip: null,
	tipAt: 0,
	peers: null,
	peersAt: 0,
	etaSamples: []
};

/** Test hook: forget the memoized completion + counters (data cache remains). */
export function resetFirstSyncStateForTests(): void {
	state.loopRunning = false;
	state.consecutiveFailures = 0;
	state.complete = false;
	state.tip = null;
	state.tipAt = 0;
	state.peers = null;
	state.peersAt = 0;
	state.etaSamples = [];
}

/**
 * The (app)-layout gate condition: has this install's chain-history cache
 * ever been built? Memoized once true (it never becomes false again — the
 * cache is immutable history and persists in the settings table).
 */
export function isFirstSyncComplete(): boolean {
	if (state.complete) return true;
	if (hasEpochHistory()) {
		state.complete = true;
		return true;
	}
	return false;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		t.unref?.();
	});
}

/**
 * Kick the history build if it isn't done and isn't already being driven.
 * Fire-and-forget with retries; never throws into the caller. Idempotent —
 * safe from hooks at boot, from the /sync page load, and from every poll.
 */
export function ensureFirstSyncRunning(): void {
	if (state.loopRunning || isFirstSyncComplete()) return;
	state.loopRunning = true;
	void (async () => {
		try {
			while (!isFirstSyncComplete()) {
				// getEpochStrip triggers (and single-flights) the boundary fetch and
				// persists the result; null = chain unreachable or too many failures.
				const strip = await getEpochStrip().catch(() => null);
				if (strip) {
					state.consecutiveFailures = 0;
					log.info(
						{ epochs: strip.epochCount, source: strip.source },
						'first-sync chain history complete'
					);
					break;
				}
				state.consecutiveFailures++;
				if (state.consecutiveFailures === UNREACHABLE_AFTER) {
					log.warn(
						{ attempts: state.consecutiveFailures },
						'first-sync history build failing; will keep retrying'
					);
				}
				await sleep(RETRY_MS);
			}
		} finally {
			state.loopRunning = false;
		}
	})();
}

/**
 * Boot-time starter (hooks.server.ts): begin counting rings shortly after the
 * server starts so the work races the user's signup/disclosure flow instead
 * of waiting for their first page view. No-op when the cache already exists.
 */
export function startFirstSync(): void {
	if (isFirstSyncComplete()) return;
	const t = setTimeout(() => ensureFirstSyncRunning(), 5_000);
	t.unref?.();
}

// ------------------------------------------------------------ live assembly

async function cachedTip(): Promise<number | null> {
	const now = Date.now();
	if (state.tip !== null && now - state.tipAt < TIP_TTL_MS) return state.tip;
	try {
		// Electrum-backed, TTL-cached tip (cairn-zoz8) — no third-party esplora call.
		const tip = (await getChain().getTip()).height;
		if (Number.isFinite(tip) && tip >= 0) {
			state.tip = tip;
			state.tipAt = now;
		}
	} catch {
		// Keep the stale value (or null) — 'connecting'/'unreachable' handle it.
	}
	return state.tip;
}

async function cachedPeers(): Promise<number | null> {
	const now = Date.now();
	if (now - state.peersAt < PEERS_TTL_MS) return state.peers;
	state.peersAt = now;
	try {
		const res = await Promise.race([
			getChain().electrum.request('server.peers.subscribe', []),
			sleep(2_500).then(() => {
				throw new Error('peers timeout');
			})
		]);
		state.peers = Array.isArray(res) && res.length > 0 ? res.length : null;
	} catch {
		state.peers = null; // Plenty of servers refuse this method — fine.
	}
	return state.peers;
}

/** Rate-based ETA over a sliding window of epoch-count samples. */
function updateEta(epochsKnown: number, epochsTotal: number): number | null {
	if (epochsTotal <= 0 || epochsKnown >= epochsTotal) return null;
	const now = Date.now();
	state.etaSamples.push({ t: now, epochs: epochsKnown });
	while (state.etaSamples.length > 2 && now - state.etaSamples[0].t > ETA_WINDOW_MS) {
		state.etaSamples.shift();
	}
	const first = state.etaSamples[0];
	const dt = (now - first.t) / 1000;
	const dEpochs = epochsKnown - first.epochs;
	if (dt < 3 || dEpochs <= 0) return null;
	return Math.round((epochsTotal - epochsKnown) / (dEpochs / dt));
}

/** The full status document the /sync screen polls. Cheap: in-memory reads
 *  plus TTL-cached tip/peers lookups. */
export async function getSyncStatus(): Promise<SyncStatus> {
	const historyDone = isFirstSyncComplete();
	const fetch = getEpochFetchProgress();
	const tip = await cachedTip();

	// Totals: while fetching, the fetch knows; when done (or idle), derive from
	// the tip so the synced state still reports "N rings".
	const epochsTotal =
		fetch.totalEpochs > 0
			? fetch.totalEpochs
			: tip !== null
				? epochIndexForHeight(tip) + 1
				: 0;
	const epochsKnown = historyDone ? epochsTotal : fetch.knownEpochs;

	let scanRaw: ReturnType<typeof getWatcherScanProgress> | null = null;
	try {
		scanRaw = getWatcherScanProgress();
	} catch {
		scanRaw = null;
	}
	const scan = scanRaw?.started ? scanRaw : null;

	const derived = deriveSyncStatus({
		historyDone,
		fetchActive: fetch.active,
		consecutiveFailures: state.consecutiveFailures,
		tipHeight: tip,
		epochsKnown,
		epochsTotal,
		lastKnownTime: fetch.lastKnownTime,
		scan: scan
			? {
					started: scan.started,
					baselined: scan.baselined,
					total: scan.totalAddresses,
					done: scan.scannedAddresses
				}
			: null
	});

	const etaSeconds = derived.phase === 'history' ? updateEta(epochsKnown, epochsTotal) : null;
	const peers = await cachedPeers();

	return {
		phase: derived.phase,
		percent: derived.percent,
		tipHeight: tip,
		frontierHeight:
			epochsTotal > 0 && tip !== null
				? Math.min(epochsKnown * EPOCH, tip)
				: epochsKnown > 0
					? epochsKnown * EPOCH
					: null,
		epochsKnown,
		epochsTotal,
		verifyingYear: derived.verifyingYear,
		verifyingNote: derived.verifyingNote,
		etaSeconds,
		peers,
		server: getChain().electrum.server,
		scan: scan ? { total: scan.totalAddresses, done: scan.scannedAddresses } : null,
		formingProgress: tip !== null ? (tip - epochIndexForHeight(tip) * EPOCH) / EPOCH : null
	};
}
