// Electrum protocol (JSON-RPC 2.0 over newline-delimited TCP/TLS) client.
// Supports pipelined concurrent requests, subscriptions and auto-reconnect.

import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { SocksClient } from 'socks';
import { childLogger } from '../logger';

const log = childLogger('electrum');

const CLIENT_NAME = 'Cairn 0.1';
const PROTOCOL_VERSION = '1.4';
const DEFAULT_TIMEOUT_MS = 15_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface ElectrumClientOptions {
	host: string;
	port: number;
	tls: boolean;
	/**
	 * When true, skip TLS certificate validation (accept self-signed/mismatched
	 * certs). Defaults to false — a valid, trusted certificate is required. Only
	 * enable for a trusted self-hosted server with a self-signed cert; leaving
	 * verification off exposes the connection to a MITM that can feed forged chain
	 * data (cairn-azei).
	 */
	tlsInsecure?: boolean;
	/** Per-request timeout in ms (default 15000). */
	timeoutMs?: number;
	/**
	 * SOCKS5 proxy host (e.g. '127.0.0.1' for a local Tor daemon). When set with
	 * socks5Port, the TCP connection to the Electrum server is dialed through the
	 * proxy via a SOCKS5 CONNECT, so the server never sees the operator's real IP
	 * (cairn-oh7a). TLS, when enabled, is then negotiated end-to-end over that
	 * tunnel — the proxy sees only ciphertext to host:port.
	 */
	socks5Host?: string | null;
	socks5Port?: number | null;
}

export interface ElectrumBalance {
	confirmed: number;
	unconfirmed: number;
}

export interface ElectrumHistoryItem {
	tx_hash: string;
	/** > 0 confirmed height, 0 = mempool, -1 = mempool with unconfirmed parents. */
	height: number;
	fee?: number;
}

export interface ElectrumUnspent {
	tx_hash: string;
	tx_pos: number;
	value: number; // sats
	height: number; // 0 = unconfirmed
}

export interface ElectrumHeader {
	height: number;
	hex: string;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

interface JsonRpcMessage {
	id?: number;
	method?: string;
	params?: unknown[];
	result?: unknown;
	error?: { code?: number; message?: string } | null;
}

/**
 * Events:
 *  - 'header'      (header: ElectrumHeader)                — new chain tip notification
 *  - 'scripthash'  (scripthash: string, status: string|null) — watched scripthash changed
 *  - 'connect' / 'disconnect'                              — connection lifecycle
 */
export class ElectrumClient extends EventEmitter {
	private readonly host: string;
	private readonly port: number;
	private readonly useTls: boolean;
	private readonly tlsInsecure: boolean;
	private readonly timeoutMs: number;
	private readonly socks5Host: string | null;
	private readonly socks5Port: number | null;

	private socket: net.Socket | null = null;
	/** Socket for a connection still being established — see close(). */
	private connectingSocket: net.Socket | null = null;
	private connecting: Promise<void> | null = null;
	private closed = false;
	private buffer = '';
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();

	private headersSubscribed = false;
	private scripthashSubs = new Set<string>();

	private reconnectTimer: NodeJS.Timeout | null = null;
	private reconnectDelay = RECONNECT_MIN_MS;

	constructor(opts: ElectrumClientOptions) {
		super();
		this.host = opts.host;
		this.port = opts.port;
		this.useTls = opts.tls;
		this.tlsInsecure = opts.tlsInsecure ?? false;
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.socks5Host = opts.socks5Host || null;
		this.socks5Port = opts.socks5Port || null;
		// Consumers may not attach an 'error' listener; never let EventEmitter throw.
		this.on('error', () => {});
	}

	get server(): string {
		return `${this.host}:${this.port}`;
	}

	// ---------------------------------------------------------------- transport

	private ensureConnected(): Promise<void> {
		if (this.closed) return Promise.reject(new Error('Client is closed'));
		if (this.socket && !this.socket.destroyed && !this.connecting) return Promise.resolve();
		if (this.connecting) return this.connecting;

		this.connecting = new Promise<void>((resolve, reject) => {
			let settled = false;
			const fail = (err: Error) => {
				if (settled) return;
				settled = true;
				this.connecting = null;
				reject(err);
			};

			let socket: net.Socket;
			const onReady = () => {
				// close() may have been called while the TCP/TLS handshake was in
				// flight — don't adopt the socket or start the protocol handshake.
				if (this.closed) {
					socket.destroy();
					fail(new Error('Client is closed'));
					return;
				}
				this.connectingSocket = null;
				this.socket = socket;
				// Handshake, then resubscribe anything that was active before a drop.
				this.rawRequest('server.version', [CLIENT_NAME, PROTOCOL_VERSION])
					.then(async () => {
						this.reconnectDelay = RECONNECT_MIN_MS;
						await this.resubscribe();
						if (settled) return;
						settled = true;
						this.connecting = null;
						this.emit('connect');
						resolve();
					})
					.catch((err: unknown) => {
						socket.destroy();
						fail(err instanceof Error ? err : new Error(String(err)));
					});
			};

			// TLS cert validation is ON by default. Although the protocol carries no
			// secrets, an unauthenticated TLS connection lets a network-level attacker
			// MITM the Electrum host and feed forged balances/UTXOs/history or
			// interfere with broadcast (cairn-azei). `tlsInsecure` is an explicit,
			// custom-server-only opt-out for a trusted self-hosted node with a
			// self-signed certificate.
			const wrapTls = (base?: net.Socket): net.Socket =>
				tls.connect(
					{
						...(base ? { socket: base } : { host: this.host, port: this.port }),
						servername: this.host,
						rejectUnauthorized: !this.tlsInsecure
					},
					onReady
				);

			const attach = (s: net.Socket) => {
				this.connectingSocket = s;
				s.setEncoding('utf8');
				s.setTimeout(0);
				s.on('data', (chunk: string) => this.onData(chunk));
				s.on('error', (err: Error) => {
					// 'close' always follows 'error'; teardown happens there.
					this.emit('error', err);
					fail(new Error(`Electrum connection error (${this.server}): ${err.message}`));
				});
				s.on('close', () => {
					fail(new Error(`Electrum connection closed (${this.server})`));
					this.onDisconnect();
				});
			};

			// Establish the transport, optionally through a SOCKS5 proxy (Tor).
			void (async () => {
				try {
					if (this.socks5Host && this.socks5Port) {
						// Dial the destination through the proxy first; TLS (if any) is then
						// negotiated end-to-end over the tunnel so the proxy sees only
						// ciphertext (cairn-oh7a).
						const { socket: tunnel } = await SocksClient.createConnection({
							proxy: { host: this.socks5Host, port: this.socks5Port, type: 5 },
							command: 'connect',
							destination: { host: this.host, port: this.port },
							timeout: this.timeoutMs
						});
						if (this.closed) {
							tunnel.destroy();
							fail(new Error('Client is closed'));
							return;
						}
						if (this.useTls) {
							socket = wrapTls(tunnel);
							attach(socket);
						} else {
							// The tunnel is already connected end-to-end; adopt it and signal
							// readiness on the next tick (parity with the connect callback).
							socket = tunnel;
							attach(socket);
							setImmediate(onReady);
						}
					} else if (this.useTls) {
						socket = wrapTls();
						attach(socket);
					} else {
						socket = net.connect({ host: this.host, port: this.port }, onReady);
						attach(socket);
					}
				} catch (e) {
					fail(e instanceof Error ? e : new Error(String(e)));
				}
			})();
		});
		return this.connecting;
	}

	private onDisconnect(): void {
		this.connectingSocket = null;
		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.destroy();
			this.socket = null;
		}
		this.buffer = '';
		this.rejectAllPending(new Error(`Electrum connection lost (${this.server})`));
		this.emit('disconnect');
		if (this.closed) return;
		// Only reconnect eagerly when someone is depending on subscriptions;
		// otherwise the next request() will reconnect lazily.
		if ((this.headersSubscribed || this.scripthashSubs.size > 0) && !this.reconnectTimer) {
			const delay = this.reconnectDelay;
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
			log.debug({ server: this.server, delayMs: delay }, 'scheduling reconnect');
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = null;
				if (this.closed) return;
				this.ensureConnected().catch((e: unknown) => {
					// ensureConnected failure re-triggers onDisconnect via 'close',
					// which schedules the next backoff attempt. Never throw.
					log.debug({ err: e, server: this.server }, 'reconnect attempt failed; will back off');
				});
			}, delay);
			this.reconnectTimer.unref?.();
		}
	}

	private rejectAllPending(err: Error): void {
		for (const [, req] of this.pending) {
			clearTimeout(req.timer);
			req.reject(err);
		}
		this.pending.clear();
	}

	private async resubscribe(): Promise<void> {
		try {
			if (this.headersSubscribed) {
				const header = (await this.rawRequest('blockchain.headers.subscribe', [])) as ElectrumHeader;
				this.emit('header', header);
			}
			for (const sh of this.scripthashSubs) {
				const status = await this.rawRequest('blockchain.scripthash.subscribe', [sh]);
				this.emit('scripthash', sh, status as string | null);
			}
		} catch (e) {
			// A failed resubscribe silently stops live header/scripthash updates until
			// the next full disconnect/retry cycle — without this log there is no
			// diagnostic trail for "balances stopped updating but we're connected".
			log.warn(
				{ err: e, server: this.server, scripthashSubs: this.scripthashSubs.size },
				'resubscribe after reconnect failed; live updates paused until next reconnect'
			);
		}
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let idx: number;
		while ((idx = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (!line) continue;
			let msg: JsonRpcMessage;
			try {
				msg = JSON.parse(line) as JsonRpcMessage;
			} catch {
				continue; // ignore malformed lines
			}
			this.dispatch(msg);
		}
	}

	private dispatch(msg: JsonRpcMessage): void {
		if (typeof msg.id === 'number') {
			const req = this.pending.get(msg.id);
			if (!req) return;
			this.pending.delete(msg.id);
			clearTimeout(req.timer);
			if (msg.error) {
				req.reject(new Error(`Electrum error: ${msg.error.message ?? JSON.stringify(msg.error)}`));
			} else {
				req.resolve(msg.result);
			}
			return;
		}
		// Unsolicited notification.
		if (msg.method === 'blockchain.headers.subscribe' && Array.isArray(msg.params)) {
			this.emit('header', msg.params[0] as ElectrumHeader);
		} else if (msg.method === 'blockchain.scripthash.subscribe' && Array.isArray(msg.params)) {
			this.emit('scripthash', msg.params[0] as string, (msg.params[1] ?? null) as string | null);
		}
	}

	/** Send a request on the already-open socket (no connect logic — used for the handshake too). */
	private rawRequest(method: string, params: unknown[]): Promise<unknown> {
		const socket = this.socket;
		if (!socket || socket.destroyed) {
			return Promise.reject(new Error(`Not connected to ${this.server}`));
		}
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Electrum request timed out after ${this.timeoutMs}ms: ${method}`));
			}, this.timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (err) => {
				if (err) {
					const req = this.pending.get(id);
					if (req) {
						this.pending.delete(id);
						clearTimeout(req.timer);
						req.reject(new Error(`Electrum write failed: ${err.message}`));
					}
				}
			});
		});
	}

	// ------------------------------------------------------------------- public

	/** Generic JSON-RPC request; lazily connects (and handshakes) on first use. */
	async request(method: string, params: unknown[] = []): Promise<unknown> {
		await this.ensureConnected();
		return this.rawRequest(method, params);
	}

	/** Fire many requests concurrently over the pipelined connection and await all. */
	async batchRequest(items: { method: string; params: unknown[] }[]): Promise<unknown[]> {
		await this.ensureConnected();
		return Promise.all(items.map((it) => this.rawRequest(it.method, it.params)));
	}

	async getBalance(scripthash: string): Promise<ElectrumBalance> {
		return (await this.request('blockchain.scripthash.get_balance', [scripthash])) as ElectrumBalance;
	}

	async getHistory(scripthash: string): Promise<ElectrumHistoryItem[]> {
		return (await this.request('blockchain.scripthash.get_history', [scripthash])) as ElectrumHistoryItem[];
	}

	async listUnspent(scripthash: string): Promise<ElectrumUnspent[]> {
		return (await this.request('blockchain.scripthash.listunspent', [
			scripthash
		])) as ElectrumUnspent[];
	}

	/** Broadcast a raw transaction; resolves to the txid the server reports. */
	async broadcast(rawTxHex: string): Promise<string> {
		return (await this.request('blockchain.transaction.broadcast', [rawTxHex])) as string;
	}

	/** Raw hex when verbose=false, decoded object when verbose=true. */
	async getTransaction(txid: string, verbose = false): Promise<unknown> {
		return this.request('blockchain.transaction.get', [txid, verbose]);
	}

	/**
	 * A merkle inclusion proof for a confirmed transaction: the sibling hashes
	 * (display-order hex) and the tx's position within its block. Used with the
	 * block header to independently verify the tx is really confirmed (SPV).
	 */
	async getMerkleProof(
		txid: string,
		height: number
	): Promise<{ block_height: number; merkle: string[]; pos: number }> {
		return (await this.request('blockchain.transaction.get_merkle', [txid, height])) as {
			block_height: number;
			merkle: string[];
			pos: number;
		};
	}

	/** The 80-byte block header at a given height, as hex. */
	async getBlockHeader(height: number): Promise<string> {
		return (await this.request('blockchain.block.header', [height])) as string;
	}

	/** Returns BTC/kvB (electrum convention) or -1 when the server has no estimate. */
	async estimateFee(targetBlocks: number): Promise<number> {
		return (await this.request('blockchain.estimatefee', [targetBlocks])) as number;
	}

	/** Subscribe to new headers; resolves with the current tip. */
	async headersSubscribe(): Promise<ElectrumHeader> {
		const header = (await this.request('blockchain.headers.subscribe', [])) as ElectrumHeader;
		this.headersSubscribed = true;
		return header;
	}

	/** Subscribe to a scripthash; resolves with its current status (null = never used). */
	async subscribeScripthash(scripthash: string): Promise<string | null> {
		const status = (await this.request('blockchain.scripthash.subscribe', [scripthash])) as
			| string
			| null;
		this.scripthashSubs.add(scripthash);
		return status;
	}

	async banner(): Promise<string> {
		return (await this.request('server.banner', [])) as string;
	}

	async serverFeatures(): Promise<Record<string, unknown>> {
		return (await this.request('server.features', [])) as Record<string, unknown>;
	}

	async ping(): Promise<void> {
		await this.request('server.ping', []);
	}

	/** Tear down the connection and stop all reconnect attempts. */
	close(): void {
		this.closed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.headersSubscribed = false;
		this.scripthashSubs.clear();
		this.rejectAllPending(new Error('Client closed'));
		// Abort a connection still being established — its 'close' handler
		// rejects the in-flight connect promise immediately.
		if (this.connectingSocket) {
			this.connectingSocket.destroy();
			this.connectingSocket = null;
		}
		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.destroy();
			this.socket = null;
		}
	}
}
