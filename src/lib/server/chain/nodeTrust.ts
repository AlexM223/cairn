// NodeTrust — "Verified by your node" provenance for the Explorer heroes
// (cairn-6efi.3, Explorer-redesign Wave 2 track T-B).
//
// This module answers one question honestly: *whose* Bitcoin data is the user
// looking at, and can we truthfully say it came from their own node? The answer
// is Cardinal rule 2 of docs/EXPLORER-REDESIGN-2026-07-12.md (the honesty
// matrix):
//
//   • "Verified by your Bitcoin Core node" — ONLY when Core RPC is configured
//     AND reachable.
//   • "Served by your Electrum server"      — a custom Electrum server (never "verified").
//   • "Using the public default server"     — the public fallback (NEVER "your node").
//   • "Not connected to a node yet"          — never configured.
//
// TWO structural guarantees make that matrix impossible to violate:
//
//   1. The trust CLAIM is never interpolated. Every user-facing string lives in
//      the constant TRUST_SPECS table below, one row per NodeTrustKind. Callers
//      pick a row by kind; they cannot assemble a claim from parts.
//   2. deriveNodeTrust() is a TOTAL, PURE function of an explicit input union.
//      The only path that yields kind `core-verified` (the one row that says
//      "Verified" / `verified: true`) requires `coreConfigured && connected`.
//      Public mode (coreConfigured false, mode 'public') can ONLY reach the
//      `public` / `public-unreachable` rows, whose specs are source 'public',
//      verified false, ownInfrastructure false. So "your node" in public mode
//      is unreachable code, not a discipline we hope to keep.
//
// PERF / NON-BLOCKING (Cardinal rule 3). gatherNodeTrust() reads ONLY cached,
// synchronous, in-memory/SQLite signals — getChainConfig()/coreRpcConfigured()
// (keyed settings reads), getChainHealth() (a pure in-memory read of recorded
// connection outcomes — no probe), and readChainSnapshot() (the same single
// SWR row the explorer load() already reads). It issues ZERO new chain calls
// and never awaits the network, so it can be dropped straight into a load()
// without threatening instant paint. A stale-but-honest connection signal
// (chainHealth's recorded last-known health) is deliberately preferred over a
// fresh blocking probe.

import type { NodeTrust, NodeTrustKind, NodeTrustSource, NodeTrustTone, NodeSyncPhase } from '$lib/types';
import {
	getChainConfig,
	coreRpcConfigured,
	isChainNeverConfigured,
	getSetting
} from '../settings';
import { getChainHealth, getCoreHealth } from '../chainHealth';
import { readChainSnapshot } from '../chainSnapshot';
import { isFirstSyncComplete } from '../syncStatus';

/**
 * The explicit, exhaustive inputs to the trust derivation. Kept as a plain
 * struct (not gathered live) so deriveNodeTrust stays pure and every matrix
 * cell is unit-testable without a running server.
 */
export interface NodeTrustInputs {
	/** settings.isChainNeverConfigured() — no connection mode and nothing auto-provisioned. */
	neverConfigured: boolean;
	/** getChainConfig().mode — the Electrum connection mode. */
	mode: 'public' | 'custom';
	/** coreRpcConfigured() — a Core RPC URL is set (config-presence only). */
	coreConfigured: boolean;
	/** Cached, non-probing reachability of the chain transport. */
	connected: boolean;
	/** Latest known tip height (from the persisted snapshot). */
	tipHeight: number | null;
	/** Epoch ms of the last successful background sync, or null. */
	lastSyncedAt: number | null;
	/** `host:port` of the configured Electrum server, credentials stripped. */
	electrumServer: string | null;
	/** URL host of the configured Core RPC endpoint, credentials stripped. */
	coreServer: string | null;
	/** chain_provisioned_by marker (display context only). */
	provisionedBy: string | null;
	/** Coarse, cached sync phase. */
	syncPhase: NodeSyncPhase | null;
}

/**
 * THE honesty matrix, as data. Each NodeTrustKind maps to exactly one immutable
 * row. This is the ONLY place a trust claim string is written; deriveNodeTrust
 * copies a row verbatim. Adding/removing a kind is a compile error here
 * (Record is total), so the matrix can never silently grow a hole.
 *
 * `ownInfrastructure` is true whenever the data source is the operator's own
 * node/server (Core or custom Electrum) even while momentarily unreachable —
 * because whatever IS on screen was last served by that own source, so the
 * "nothing came from a third party" statement stays true. `verified` is true
 * for exactly one row.
 */
const TRUST_SPECS: Record<
	NodeTrustKind,
	{
		source: NodeTrustSource;
		label: string;
		headline: string;
		tone: NodeTrustTone;
		ownInfrastructure: boolean;
		verified: boolean;
	}
> = {
	'core-verified': {
		source: 'core',
		label: 'Verified by your Bitcoin Core node',
		headline: 'Every figure here was verified by your own Bitcoin Core node.',
		tone: 'verified',
		ownInfrastructure: true,
		verified: true
	},
	'core-unreachable': {
		source: 'core',
		label: 'Your Bitcoin Core node is unreachable',
		headline: 'Your Bitcoin Core node is configured but not answering right now.',
		tone: 'warning',
		ownInfrastructure: true,
		verified: false
	},
	'electrum-custom': {
		source: 'electrum',
		label: 'Served by your Electrum server',
		headline: 'Chain data is served by the Electrum server you configured.',
		tone: 'own',
		ownInfrastructure: true,
		verified: false
	},
	'electrum-custom-unreachable': {
		source: 'electrum',
		label: 'Your Electrum server is unreachable',
		headline: 'Your Electrum server is configured but not answering right now.',
		tone: 'warning',
		ownInfrastructure: true,
		verified: false
	},
	public: {
		source: 'public',
		label: 'Using the public default server',
		headline: 'Connected through the shared public default server — not your own node.',
		tone: 'public',
		ownInfrastructure: false,
		verified: false
	},
	'public-unreachable': {
		source: 'public',
		label: 'The public default server is unreachable',
		headline: 'The shared public default server is not answering right now.',
		tone: 'warning',
		ownInfrastructure: false,
		verified: false
	},
	unconfigured: {
		source: 'none',
		label: 'Not connected to a node yet',
		headline: 'No Bitcoin node or server has been connected to this instance yet.',
		tone: 'idle',
		ownInfrastructure: false,
		verified: false
	}
};

/**
 * The single decision function. Order matters and encodes the priority:
 *
 *   1. Core RPC configured wins first — a genuinely wired Core node is the
 *      strongest signal, and its reachability splits verified vs. unreachable.
 *      (Checked before `neverConfigured` so a Core-only setup with no Electrum
 *      connection_mode is never mislabelled "not connected yet".)
 *   2. Otherwise, never-configured is the honest "nothing set up" state.
 *   3. Otherwise a custom Electrum server, reachable or not.
 *   4. Otherwise the public default, reachable or not.
 *
 * Structurally, `core-verified` is reachable ONLY via branch 1 with
 * `connected === true`, and no public-mode input can reach a `core-*` kind.
 */
export function nodeTrustKind(i: NodeTrustInputs): NodeTrustKind {
	if (i.coreConfigured) return i.connected ? 'core-verified' : 'core-unreachable';
	if (i.neverConfigured) return 'unconfigured';
	if (i.mode === 'custom') return i.connected ? 'electrum-custom' : 'electrum-custom-unreachable';
	return i.connected ? 'public' : 'public-unreachable';
}

/**
 * Pure, total derivation of the serializable NodeTrust from explicit inputs.
 * Unit-tested for every matrix cell. Selects the credential-stripped server
 * label matching the resolved source (Core host for core kinds, Electrum
 * host:port for electrum/public kinds, null when unconfigured).
 */
export function deriveNodeTrust(i: NodeTrustInputs): NodeTrust {
	const kind = nodeTrustKind(i);
	const spec = TRUST_SPECS[kind];
	const server =
		spec.source === 'core' ? i.coreServer : spec.source === 'none' ? null : i.electrumServer;
	return {
		kind,
		source: spec.source,
		label: spec.label,
		headline: spec.headline,
		tone: spec.tone,
		ownInfrastructure: spec.ownInfrastructure,
		verified: spec.verified,
		connected: i.connected,
		server,
		tipHeight: i.tipHeight,
		syncPhase: i.syncPhase,
		provisionedBy: i.provisionedBy,
		lastSyncedAt: i.lastSyncedAt
	};
}

/**
 * Strip any credentials and path from a URL, returning `host[:port]` only, so a
 * Core RPC URL like `http://user:pass@10.21.21.8:8332/wallet` never leaks its
 * userinfo into a client-visible label. Returns null on empty/unparseable input.
 */
function hostOnly(url: string | null): string | null {
	if (!url || url.trim() === '') return null;
	try {
		return new URL(url).host || null;
	} catch {
		return null;
	}
}

/** Coarse, cached sync phase — honest and probe-free. `scanning` (watcher-
 *  scoped) is deliberately not surfaced here; the explorer chip only needs the
 *  connecting → history → synced spine plus the unreachable degrade. */
function coarseSyncPhase(connected: boolean, everConnected: boolean): NodeSyncPhase {
	if (!connected) return everConnected ? 'unreachable' : 'connecting';
	return isFirstSyncComplete() ? 'synced' : 'history';
}

/**
 * Assemble the live NodeTrust from cached, synchronous signals only (see the
 * module header for the non-blocking contract). Safe to call directly inside a
 * load(): it issues no chain calls and never awaits the network.
 */
export function gatherNodeTrust(): NodeTrust {
	const cfg = getChainConfig();
	const coreConfigured = coreRpcConfigured();
	// Read the reachability of whichever backend actually SERVES this instance's
	// explorer data: Bitcoin Core RPC when it's configured (the primary/only source
	// post-Esplora), else the Electrum transport. Reading the Electrum-only signal
	// for a Core-backed instance was exactly the cairn-7qmw bug — a working Core
	// node was mislabelled "unreachable" and denied its "Verified" badge whenever
	// Electrum happened to be down. Both signals expose `healthy` + `lastOkAt`, the
	// only two fields the connection derivation needs.
	const health = coreConfigured ? getCoreHealth() : getChainHealth();
	const snap = readChainSnapshot();

	// "Connected" = the backend is currently healthy AND has succeeded at least
	// once (lastOkAt set). Fresh boot before any handshake is healthy-by-default
	// with lastOkAt null — that is NOT a connection, so it reads as connecting.
	const everConnected = health.lastOkAt !== null;
	const connected = health.healthy && everConnected;

	return deriveNodeTrust({
		neverConfigured: isChainNeverConfigured(),
		mode: cfg.mode,
		coreConfigured,
		connected,
		tipHeight: snap?.data.tipHeight ?? null,
		lastSyncedAt: snap?.lastSyncedAt ?? null,
		electrumServer: `${cfg.electrumHost}:${cfg.electrumPort}`,
		coreServer: hostOnly(cfg.coreRpcUrl),
		provisionedBy: getSetting('chain_provisioned_by'),
		syncPhase: coarseSyncPhase(connected, everConnected)
	});
}
