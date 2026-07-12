// Cheap, in-memory last-known health of the chain transport — the Electrum
// connection pool and, when configured, the SOCKS5/Tor proxy in front of it
// (cairn-hy8z).
//
// A misconfigured proxy (e.g. a Tor daemon that's down, so the SOCKS5 CONNECT is
// rejected) degrades ALL chain traffic silently: the dashboard and wallet pages
// just sit on skeletons while every scan slowly times out, with nothing telling
// the user or admin that the transport itself is the problem. This module is the
// signal behind an instance-wide "can't reach the Bitcoin network" banner and
// the admin settings proxy indicator.
//
// It is DERIVED, not probed: the Electrum client records the outcome of every
// connection attempt here (recordChainOk on a successful handshake,
// recordChainError on a failed dial — proxy rejection, TLS error, timeout, …),
// so reads are pure in-memory and add no network call per page load. During a
// real outage the address watcher's eager reconnect loop and ordinary page
// loads keep attempting connections, so the signal stays fresh on its own.

import { childLogger } from './logger';

// Wave 2 / log-chain.md: this module used to mutate in-memory state with ZERO
// log output — the single biggest logging blind spot in the app. An operator
// watching `docker logs` had no way to see the instance-wide "can't reach the
// Bitcoin network" banner go up (or come back down). Logged only on the
// actual state FLIP (not every call) so a flapping connection doesn't spam
// the log.
const log = childLogger('chain');

/**
 * Consecutive failed connection attempts before the transport is called
 * unhealthy. >1 so a single transient socket drop (public servers cycle idle
 * sockets constantly) never trips the banner — mirrors syncStatus's
 * UNREACHABLE_AFTER and chainEvents' debounce philosophy.
 */
const UNHEALTHY_AFTER = 2;

interface ChainHealthState {
	lastOkAt: number | null;
	lastErrorAt: number | null;
	lastError: string | null;
	consecutiveFailures: number;
	/** Whether a SOCKS5/Tor proxy is configured (set from chain config). */
	proxyConfigured: boolean;
}

const state: ChainHealthState = {
	lastOkAt: null,
	lastErrorAt: null,
	lastError: null,
	consecutiveFailures: 0,
	proxyConfigured: false
};

/** The shape read by the layout banner and the admin settings indicator. */
export interface ChainHealth {
	/** False once too many connection attempts have failed in a row. */
	healthy: boolean;
	/** Whether the failures are (or would be) routed through a configured proxy. */
	proxyConfigured: boolean;
	/** Latest connection-failure message (only surfaced while unhealthy). */
	lastError: string | null;
	/** ms epoch of the latest failure, or null if none seen. */
	lastErrorAt: number | null;
	/** ms epoch of the latest successful connect, or null if none seen. */
	lastOkAt: number | null;
}

/** A successful Electrum handshake — the transport is reachable right now. */
export function recordChainOk(): void {
	// Only the recovery FLIP is worth a log line — every other call while
	// already healthy is a routine handshake, not news.
	const wasUnhealthy = state.consecutiveFailures >= UNHEALTHY_AFTER;
	state.lastOkAt = Date.now();
	state.consecutiveFailures = 0;
	state.lastError = null;
	if (wasUnhealthy) {
		log.info('chain transport recovered: Electrum handshake succeeded');
	}
}

/** A failed connection attempt (proxy rejection, TLS error, timeout, …). */
export function recordChainError(err: unknown): void {
	state.lastErrorAt = Date.now();
	state.lastError = err instanceof Error ? err.message : String(err);
	state.consecutiveFailures++;
	// Log exactly once at the moment the transport crosses into "unhealthy" —
	// this is the "can't reach the Bitcoin network" banner going up. lastError
	// is deliberately included and never redacted (matches logger.ts's `err`
	// exemption): it's the one piece of text that tells an operator WHY.
	if (state.consecutiveFailures === UNHEALTHY_AFTER) {
		log.warn(
			{ consecutiveFailures: state.consecutiveFailures, lastError: state.lastError },
			'chain transport unhealthy: too many consecutive connection failures'
		);
	}
}

/** Record whether a SOCKS5/Tor proxy is currently configured (from settings). */
export function noteProxyConfigured(on: boolean): void {
	state.proxyConfigured = on;
}

/**
 * Forget accumulated failures — called when the chain is reconfigured, so a new
 * server/proxy starts from a clean slate and a stale error from the old backend
 * doesn't linger on the banner.
 */
export function resetChainHealth(): void {
	state.lastOkAt = null;
	state.lastErrorAt = null;
	state.lastError = null;
	state.consecutiveFailures = 0;
}

/** Current transport health — a pure in-memory read, no network call. */
export function getChainHealth(): ChainHealth {
	const healthy = state.consecutiveFailures < UNHEALTHY_AFTER;
	return {
		healthy,
		proxyConfigured: state.proxyConfigured,
		// Only expose the error text once we've actually decided it's unhealthy,
		// so a single in-band blip never surfaces a scary message.
		lastError: healthy ? null : state.lastError,
		lastErrorAt: state.lastErrorAt,
		lastOkAt: state.lastOkAt
	};
}

/** Test hook: wipe all recorded health (including proxyConfigured). */
export function resetChainHealthForTests(): void {
	resetChainHealth();
	state.proxyConfigured = false;
}
