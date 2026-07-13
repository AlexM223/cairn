// A small pool of ElectrumClient connections behind one ElectrumClient-shaped
// facade (cairn-ynfp).
//
// Every ChainService method and the ~5 direct `.electrum` call sites funnel all
// Electrum traffic through a single pipelined TCP socket, so address/balance
// lookups queue behind one another instead of parallelising — the dominant cost
// in the portfolio-scan load test. This pool fans stateless requests across a
// few connections (round-robin) while keeping ALL subscriptions and their
// notifications on one designated "primary" connection, because Electrum
// subscriptions are inherently per-socket and consumers (addressWatcher, the SSE
// endpoint) attach header/scripthash listeners to a single EventEmitter.
//
// It deliberately mirrors ElectrumClient's public surface (and re-emits the
// primary's connect/disconnect/header/scripthash events as its own) so it is a
// drop-in for `ChainService.electrum` — no call site needs to know it is pooled.

import { EventEmitter } from 'node:events';
import { ElectrumClient } from './client';
import type {
	ElectrumClientOptions,
	ElectrumBalance,
	ElectrumFeeHistogram,
	ElectrumHistoryItem,
	ElectrumUnspent
} from './client';

/** Events forwarded from the primary connection so listeners see one source. */
const FORWARDED_EVENTS = ['connect', 'disconnect', 'header', 'scripthash'] as const;

export const DEFAULT_POOL_SIZE = 3;
export const MAX_POOL_SIZE = 4;

/**
 * Which "lane" a stateless request belongs to (cairn — Electrum HOL blocking).
 * The pool is already pipelined (many in-flight requests per socket), so the
 * unresponsiveness under load isn't pool *size* — it's head-of-line blocking:
 * a background gap-limit scan pipelines ~200 history/balance calls and fills the
 * pool's sockets, so an interactive request (building a send, opening a tx)
 * queues behind it. Tagging traffic by lane lets the picker hold one socket back
 * for interactive work so a scan can never wedge the whole pool.
 *
 *  • 'interactive' — user-facing, latency-sensitive (send pages, tx detail,
 *    admin test-connection). May use ANY socket; least-loaded first.
 *  • 'background'  — bulk, latency-tolerant (wallet/multisig gap-limit scans,
 *    address-watcher backfill/resubscribe). Restricted to the pool minus one
 *    reserved socket.
 *
 * Defaults to 'interactive' everywhere it isn't set, so every pre-existing call
 * site keeps its old behavior (additive/backward-compatible).
 */
export type ElectrumLane = 'interactive' | 'background';

/**
 * How many sockets a BACKGROUND-lane request may choose among: the pool minus
 * the one reserved interactive-only socket, never below 1 (a size-1 pool —
 * pooling disabled — reserves nothing and still works). Because a background
 * scan can never touch the reserved socket, it can never fill every connection
 * and starve interactive traffic. Exposed so SCAN_CONCURRENCY (walletSync.ts)
 * can peg to the background-lane width rather than the raw pool size.
 */
export function backgroundLaneWidth(poolSize: number): number {
	return Math.max(1, poolSize - 1);
}

/**
 * The background-lane width at the DEFAULT pool size — what SCAN_CONCURRENCY is
 * pegged to. Deliberately derived from the background lane, NOT DEFAULT_POOL_SIZE
 * directly, so a future pool-size bump doesn't silently raise scan pressure
 * without a deliberate decision (see walletSync.ts / task 3).
 */
export const DEFAULT_BACKGROUND_LANE_SIZE = backgroundLaneWidth(DEFAULT_POOL_SIZE);

export class ElectrumPool extends EventEmitter {
	private readonly clients: ElectrumClient[];
	/** The single connection that owns every subscription + its notifications. */
	private readonly primary: ElectrumClient;
	private rr = 0;

	constructor(opts: ElectrumClientOptions, size: number = DEFAULT_POOL_SIZE) {
		super();
		const n = Math.max(1, Math.min(MAX_POOL_SIZE, Math.floor(size) || DEFAULT_POOL_SIZE));
		this.clients = Array.from({ length: n }, () => new ElectrumClient(opts));
		this.primary = this.clients[0];

		// SSE attaches one 'header' listener per open tab on top of the watcher's;
		// match ElectrumClient's own lifted cap so a few tabs don't warn.
		this.setMaxListeners(64);
		// Never let an emitted 'error' throw if nothing is listening (parity with
		// ElectrumClient's own guard); each client also guards its own 'error'.
		this.on('error', () => {});

		// Present the primary's lifecycle + subscription events as the pool's, so
		// wireChainEvents/addressWatcher/SSE listen in exactly one place.
		for (const ev of FORWARDED_EVENTS) {
			this.primary.on(ev, (...args: unknown[]) => this.emit(ev, ...args));
		}
	}

	get server(): string {
		return this.primary.server;
	}

	/** The subset of connections a lane may select from. The background lane loses
	 *  the reserved (last) socket whenever the pool has more than one connection;
	 *  the interactive lane always sees every socket. */
	private eligibleClients(lane: ElectrumLane): ElectrumClient[] {
		if (lane === 'background' && this.clients.length > 1) {
			return this.clients.slice(0, this.clients.length - 1);
		}
		return this.clients;
	}

	/**
	 * Pick a connection for a stateless request, lane-aware (cairn — HOL blocking).
	 * Interactive requests may use ANY socket (including the one the background
	 * lane is barred from); background requests only their eligible subset. Within
	 * the eligible set the connection with the fewest in-flight requests wins, so
	 * an interactive request steers around a socket a scan is currently saturating;
	 * a round-robin counter breaks ties so equal-load sockets (notably a cold pool
	 * where every count is 0) still fan out evenly — this preserves the old
	 * round-robin spread for a burst of concurrent, otherwise-idle requests.
	 */
	private pick(lane: ElectrumLane = 'interactive'): ElectrumClient {
		const eligible = this.eligibleClients(lane);
		let min = Infinity;
		for (const c of eligible) {
			if (c.pendingCount < min) min = c.pendingCount;
		}
		const tied: ElectrumClient[] = [];
		for (const c of eligible) if (c.pendingCount === min) tied.push(c);
		const chosen = tied[this.rr % tied.length];
		this.rr++;
		return chosen;
	}

	// --------------------------------------------------------- stateless requests
	// Fanned across the pool so concurrent lookups run on parallel sockets. The
	// optional `lane` steers scan traffic onto the background subset; it defaults
	// to interactive so untagged call sites are unchanged.

	request(method: string, params: unknown[] = [], lane: ElectrumLane = 'interactive'): Promise<unknown> {
		return this.pick(lane).request(method, params);
	}

	batchRequest(
		items: { method: string; params: unknown[] }[],
		lane: ElectrumLane = 'interactive'
	): Promise<unknown[]> {
		return this.pick(lane).batchRequest(items);
	}

	getBalance(scripthash: string, lane: ElectrumLane = 'interactive'): Promise<ElectrumBalance> {
		return this.pick(lane).getBalance(scripthash);
	}

	getHistory(scripthash: string, lane: ElectrumLane = 'interactive'): Promise<ElectrumHistoryItem[]> {
		return this.pick(lane).getHistory(scripthash);
	}

	listUnspent(scripthash: string, lane: ElectrumLane = 'interactive'): Promise<ElectrumUnspent[]> {
		return this.pick(lane).listUnspent(scripthash);
	}

	broadcast(rawTxHex: string): Promise<string> {
		return this.pick().broadcast(rawTxHex);
	}

	broadcastPackage(rawTxHexes: string[]): Promise<unknown> {
		return this.pick().broadcastPackage(rawTxHexes);
	}

	getTransaction(txid: string, verbose = false, lane: ElectrumLane = 'interactive'): Promise<unknown> {
		return this.pick(lane).getTransaction(txid, verbose);
	}

	getMerkleProof(
		txid: string,
		height: number,
		lane: ElectrumLane = 'interactive'
	): Promise<{ block_height: number; merkle: string[]; pos: number }> {
		return this.pick(lane).getMerkleProof(txid, height);
	}

	getBlockHeader(height: number, lane: ElectrumLane = 'interactive'): Promise<string> {
		return this.pick(lane).getBlockHeader(height);
	}

	estimateFee(targetBlocks: number): Promise<number> {
		return this.pick().estimateFee(targetBlocks);
	}

	getFeeHistogram(): Promise<ElectrumFeeHistogram> {
		return this.pick().getFeeHistogram();
	}

	serverFeatures(): Promise<Record<string, unknown>> {
		return this.pick().serverFeatures();
	}

	ping(): Promise<void> {
		return this.pick().ping();
	}

	// ------------------------------------------------------- primary-only traffic
	// Subscriptions must land on the socket whose notifications we forward, and
	// banner/headersSubscribe are used by getNodeInfo to describe that connection.

	headersSubscribe(): ReturnType<ElectrumClient['headersSubscribe']> {
		return this.primary.headersSubscribe();
	}

	subscribeScripthash(scripthash: string): Promise<string | null> {
		return this.primary.subscribeScripthash(scripthash);
	}

	/** Release a scripthash subscription on the primary — the only socket it was
	 *  ever placed on (cairn-gakd Phase 2). Prunes the primary's resubscribe set
	 *  and best-effort unsubscribes on the wire. */
	unsubscribeScripthash(scripthash: string): Promise<boolean> {
		return this.primary.unsubscribeScripthash(scripthash);
	}

	banner(): Promise<string> {
		return this.primary.banner();
	}

	/** Tear down every pooled connection and stop all reconnect attempts. */
	close(): void {
		for (const client of this.clients) client.close();
	}
}
