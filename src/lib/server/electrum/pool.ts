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
	ElectrumHistoryItem,
	ElectrumUnspent
} from './client';

/** Events forwarded from the primary connection so listeners see one source. */
const FORWARDED_EVENTS = ['connect', 'disconnect', 'header', 'scripthash'] as const;

export const DEFAULT_POOL_SIZE = 2;
const MAX_POOL_SIZE = 4;

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

	/** Pick a connection for a stateless request (round-robin across the pool). */
	private pick(): ElectrumClient {
		const client = this.clients[this.rr % this.clients.length];
		this.rr++;
		return client;
	}

	// --------------------------------------------------------- stateless requests
	// Fanned across the pool so concurrent lookups run on parallel sockets.

	request(method: string, params: unknown[] = []): Promise<unknown> {
		return this.pick().request(method, params);
	}

	batchRequest(items: { method: string; params: unknown[] }[]): Promise<unknown[]> {
		return this.pick().batchRequest(items);
	}

	getBalance(scripthash: string): Promise<ElectrumBalance> {
		return this.pick().getBalance(scripthash);
	}

	getHistory(scripthash: string): Promise<ElectrumHistoryItem[]> {
		return this.pick().getHistory(scripthash);
	}

	listUnspent(scripthash: string): Promise<ElectrumUnspent[]> {
		return this.pick().listUnspent(scripthash);
	}

	broadcast(rawTxHex: string): Promise<string> {
		return this.pick().broadcast(rawTxHex);
	}

	getTransaction(txid: string, verbose = false): Promise<unknown> {
		return this.pick().getTransaction(txid, verbose);
	}

	getMerkleProof(
		txid: string,
		height: number
	): Promise<{ block_height: number; merkle: string[]; pos: number }> {
		return this.pick().getMerkleProof(txid, height);
	}

	getBlockHeader(height: number): Promise<string> {
		return this.pick().getBlockHeader(height);
	}

	estimateFee(targetBlocks: number): Promise<number> {
		return this.pick().estimateFee(targetBlocks);
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

	banner(): Promise<string> {
		return this.primary.banner();
	}

	/** Tear down every pooled connection and stop all reconnect attempts. */
	close(): void {
		for (const client of this.clients) client.close();
	}
}
