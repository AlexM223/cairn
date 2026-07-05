// Bridges the Electrum client's connection/header events into the user-facing
// activity feed (and the server log). Wired once per ChainService in its
// constructor; reset on reconfigureChain so a server switch is reported cleanly.
//
// Dedupe lives here, not in activity.ts: transports flap and reconnect
// resubscription re-emits the current tip, so we only record a *change* in
// connection state and each block height once.

import type { ElectrumClient, ElectrumHeader } from './electrum/client';
import { recordActivity } from './activity';
import { notify } from './notifications';
import { childLogger } from './logger';
import { formatNumber } from '$lib/format';

const log = childLogger('electrum');

// Process-wide dedupe state. Survives reconfiguration by design; the switch
// path calls resetConnectionState() so the fresh client's first connect is
// still reported.
let connected: boolean | null = null;
let lastBlockHeight = 0;

// admin_server_health debounce (§3): the Electrum client flaps and retries with
// backoff, so a bare 'disconnect' listener would spam. Instead, when the
// connection goes down we arm a timer; only if it's STILL down after the grace
// window do we fire ONE admin notification for the outage. A reconnect within
// the window cancels the pending alert. `healthAlerted` latches so we don't
// re-alert until the connection has recovered at least once.
const OUTAGE_GRACE_MS = 60_000;
let outageTimer: ReturnType<typeof setTimeout> | null = null;
let healthAlerted = false;

function clearOutageTimer(): void {
	if (outageTimer !== null) {
		clearTimeout(outageTimer);
		outageTimer = null;
	}
}

/** Attach activity/logging listeners to a freshly built Electrum client. */
export function wireChainEvents(electrum: ElectrumClient): void {
	const server = electrum.server;

	// The SSE endpoint attaches a 'header' listener per open tab on top of ours.
	// Lift Node's default 10-listener cap so a few open tabs don't emit a
	// spurious MaxListenersExceeded warning — bounded, not a leak (SSE removes
	// its listener on disconnect).
	electrum.setMaxListeners(64);

	electrum.on('connect', () => {
		// A successful connect ends any outage: cancel a pending alert and, if we
		// had already alerted, send a single "recovered" note and re-arm for the
		// next outage.
		clearOutageTimer();
		if (healthAlerted) {
			healthAlerted = false;
			notify({
				type: 'admin_server_health',
				userId: null,
				level: 'success',
				title: 'Bitcoin node connection restored',
				body: `Cairn reconnected to its Bitcoin backend (${server}).`,
				detail: { server },
				link: '/admin/settings'
			});
		}
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
		// Arm the debounced outage alert (only if not already armed/alerted). The
		// client keeps retrying in the background; we only bother an admin once the
		// outage has clearly persisted past the grace window.
		if (!healthAlerted && outageTimer === null) {
			outageTimer = setTimeout(() => {
				outageTimer = null;
				healthAlerted = true;
				notify({
					type: 'admin_server_health',
					userId: null,
					level: 'error',
					title: 'Bitcoin node connection down',
					body: `Cairn has been unable to reach its Bitcoin backend (${server}) for over a minute. Wallet balances and sends may be stale until it reconnects.`,
					detail: { server },
					link: '/admin/settings'
				});
			}, OUTAGE_GRACE_MS);
			outageTimer.unref?.();
		}
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
	// The old client is being torn down without a 'disconnect'; drop any pending
	// outage alert and latch so the fresh client starts from a clean slate.
	clearOutageTimer();
	healthAlerted = false;
}
