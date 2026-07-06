// Opportunistic package-relay broadcast (cairn-u9ob.8, docs/CPFP-UNCONFIRMED-PLAN.md
// §2.3 / Unit 8).
//
// Sequential broadcast (parent first, then child) works fine for baseline CPFP,
// where the parent is already in mempools. The one case it can't cover is a
// parent whose fee rate is below the node's minimum relay / mempool-floor fee:
// broadcast alone, the node rejects it outright, so a fee-paying child can never
// attach. BIP-331 package relay (Bitcoin Core's submitpackage, exposed by some
// Electrum servers as `blockchain.transaction.broadcast_package`) solves this by
// submitting [parent, child] together so the package's average fee clears the
// floor.
//
// This is a PURE ENHANCEMENT — explicitly not required for baseline CPFP (Units
// 1-7) and safe to no-op. So support is probed once and CACHED, and every path
// degrades silently: an Electrum server that doesn't implement the method (most
// don't yet) simply reports "unsupported" and the caller falls back to whatever
// it did before. Nothing here ever throws into the broadcast path.

import { getChain } from './chain';
import { childLogger } from './logger';

const log = childLogger('package-relay');

/**
 * Cached support verdict for the connected Electrum server:
 *   null  = not yet probed / undecided (a transient error re-probes later)
 *   true  = the server accepted a package call
 *   false = the server reported the method is unknown/unsupported
 * Reset when the backend changes (resetPackageRelaySupport, called from the same
 * places that invalidate the scan caches).
 */
let electrumPackageSupport: boolean | null = null;

/** Forget the cached verdict — call when the Electrum backend changes. */
export function resetPackageRelaySupport(): void {
	electrumPackageSupport = null;
}

/** Test-only view of the cached verdict. */
export function packageRelaySupportState(): boolean | null {
	return electrumPackageSupport;
}

/** A JSON-RPC "unknown method" style rejection — the signal that this server just
 *  doesn't implement package relay (as opposed to rejecting the package itself). */
function isUnknownMethod(err: unknown): boolean {
	const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
	return (
		msg.includes('unknown method') ||
		msg.includes('method not found') ||
		msg.includes('not supported') ||
		msg.includes('unsupported') ||
		msg.includes('invalid method') ||
		msg.includes('-32601')
	);
}

export type PackageBroadcastResult =
	| { status: 'sent'; response: unknown }
	| { status: 'unsupported' }
	| { status: 'failed'; error: string };

/**
 * Attempt to broadcast `rawTxHexes` (parent(s) then child, in dependency order)
 * as a single package over Electrum. Returns:
 *   'sent'        — the server accepted the package (response is server-shaped)
 *   'unsupported' — the server doesn't implement package relay (cached; the
 *                   caller should fall back to sequential broadcast / the
 *                   original error)
 *   'failed'      — the server implements it but rejected THIS package (e.g. the
 *                   fees still don't clear the floor); the message is the node's.
 *
 * Never throws. A known-unsupported verdict short-circuits without a network call.
 */
export async function broadcastPackage(rawTxHexes: string[]): Promise<PackageBroadcastResult> {
	if (rawTxHexes.length < 2) {
		// A "package" of one is just a normal broadcast — not this path's job.
		return { status: 'failed', error: 'A package needs at least two transactions.' };
	}
	if (electrumPackageSupport === false) return { status: 'unsupported' };

	try {
		const response = await getChain().electrum.broadcastPackage(rawTxHexes);
		electrumPackageSupport = true;
		return { status: 'sent', response };
	} catch (e) {
		if (isUnknownMethod(e)) {
			electrumPackageSupport = false;
			log.debug('electrum server does not support broadcast_package — package relay disabled');
			return { status: 'unsupported' };
		}
		// The server DOES support it (so the method exists) but rejected this
		// particular package — surface the reason; do not cache as unsupported.
		electrumPackageSupport = true;
		const error = e instanceof Error ? e.message : String(e);
		log.debug({ err: e }, 'package broadcast rejected by node');
		return { status: 'failed', error };
	}
}
