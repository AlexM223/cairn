// Bridges the Electrum client's connection/header events into the user-facing
// activity feed (and the server log). Wired once per ChainService in its
// constructor; reset on reconfigureChain so a server switch is reported cleanly.
//
// Dedupe lives here, not in activity.ts: transports flap and reconnect
// resubscription re-emits the current tip, so we only record a *change* in
// connection state and each block height once.

import type { ElectrumClient, ElectrumHeader } from './electrum/client';
import { recordActivity } from './activity';
import { childLogger } from './logger';
import { formatNumber } from '$lib/format';

const log = childLogger('electrum');

// Process-wide dedupe state. Survives reconfiguration by design; the switch
// path calls resetConnectionState() so the fresh client's first connect is
// still reported.
let connected: boolean | null = null;
let lastBlockHeight = 0;

/** Attach activity/logging listeners to a freshly built Electrum client. */
export function wireChainEvents(electrum: ElectrumClient): void {
	const server = electrum.server;

	// The SSE endpoint attaches a 'header' listener per open tab on top of ours.
	// Lift Node's default 10-listener cap so a few open tabs don't emit a
	// spurious MaxListenersExceeded warning — bounded, not a leak (SSE removes
	// its listener on disconnect).
	electrum.setMaxListeners(64);

	electrum.on('connect', () => {
		if (connected === true) return;
		connected = true;
		log.info({ server }, 'connected');
		recordActivity({
			type: 'network_up',
			level: 'success',
			message: 'Connected to the Bitcoin network',
			detail: { server }
		});
	});

	electrum.on('disconnect', () => {
		if (connected === false) return;
		connected = false;
		log.warn({ server }, 'connection lost');
		recordActivity({
			type: 'network_down',
			level: 'warn',
			message: 'Network connection lost',
			detail: { server }
		});
	});

	electrum.on('header', (header: ElectrumHeader) => {
		if (!header || typeof header.height !== 'number') return;
		// Reconnect resubscription re-emits the current tip; only the first sight
		// of a height is a real "new block".
		if (header.height <= lastBlockHeight) return;
		lastBlockHeight = header.height;
		log.debug({ height: header.height }, 'new block');
		recordActivity({
			type: 'new_block',
			message: `New block #${formatNumber(header.height)}`,
			detail: { height: header.height }
		});
	});
}

/**
 * Forget the cached connection state so the next client's first 'connect' is
 * recorded. Called from reconfigureChain(), where the old client is torn down
 * without emitting 'disconnect'.
 */
export function resetConnectionState(): void {
	connected = null;
}
