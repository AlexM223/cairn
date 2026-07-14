// Electrum protocol (JSON-RPC 2.0 over newline-delimited TCP/TLS) client.
// Supports pipelined concurrent requests, subscriptions and auto-reconnect.

import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { SocksClient } from 'socks';
import { childLogger } from '../logger';
import { recordChainOk, recordChainError } from '../chainHealth';

const log = childLogger('electrum');

const CLIENT_NAME = 'Cairn 0.1';
const PROTOCOL_VERSION = '1.4';
const DEFAULT_TIMEOUT_MS = 15_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// Public Electrum servers enforce short idle-socket timeouts (commonly ~100s);
// without a periodic keepalive an otherwise-healthy connection gets dropped
// every ~90-120s, causing endless reconnect churn (cairn-u7bw). 45s keeps us
// comfortably under the common thresholds while staying negligible traffic.
const KEEPALIVE_INTERVAL_MS = 45_000;
// Hard cap on the unparsed receive buffer (cairn-32kh). The wire protocol is
// newline-delimited: onData() accumulates bytes and drains complete lines, so a
// server (buggy or hostile) that streams a payload and never sends a newline
// grows `this.buffer` without bound — a memory-exhaustion DoS, and the eventual
// JSON.parse on a giant line stalls the event loop synchronously. If the
// *residual* (post-drain, still-incomplete) buffer ever exceeds this, the socket
// is destroyed and the normal disconnect/backoff-reconnect path takes over.
// 32 MiB is far above any legitimate single Electrum response (a verbose tx or a
// large address history arrives well under this) while still being a firm bound.
const MAX_BUFFER_SIZE = 32 * 1024 * 1024;

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
	/**
	 * Interval in ms between idle keepalive pings (default 45000, see
	 * KEEPALIVE_INTERVAL_MS). Overridable mainly so tests can exercise the
	 * stale-connection liveness check (cairn-jhj6) without waiting 45s.
	 */
	keepaliveIntervalMs?: number;
	/**
	 * Max unparsed receive-buffer size in bytes before the connection is torn down
	 * (default 32 MiB, see MAX_BUFFER_SIZE / cairn-32kh). Overridable mainly so
	 * tests can trip the unterminated-payload guard without streaming 32 MiB.
	 */
	maxBufferBytes?: number;
	/**
	 * Whether this client's dial outcomes feed the instance-wide chain-health
	 * signal (chainHealth.ts's recordChainOk/recordChainError — the "can't reach
	 * the Bitcoin network" banner). Defaults to true for backward compatibility
	 * with any standalone ElectrumClient.
	 *
	 * ElectrumPool sets this false on every socket but its primary (cairn-d8aa):
	 * before this flag existed, EVERY pooled connection reported to the same
	 * global signal, so a transient hiccup on a secondary socket (e.g. one of a
	 * background scan's parallel connections dropped under load) could flip the
	 * instance-wide banner even while the primary — and the actual network —
	 * were fine. Also set false by any one-off throwaway probe against a
	 * candidate/different server (the admin "Test connection" button's
	 * `testElectrum()`, Umbrel's zero-config `umbrelProbe.ts`) — those aren't
	 * the operator's live connection and must never be able to flip the real
	 * banner, mirroring the existing Core-RPC precedent (chainHealth.ts's
	 * getCoreHealth() is fed only by the long-lived ChainService client, never
	 * the admin Core test probe).
	 */
	reportsHealth?: boolean;
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

/**
 * Mempool fee-rate distribution from `mempool.get_fee_histogram`: [feeRate sat/vB,
 * cumulative vsize] pairs, ordered highest fee rate first (Electrum protocol
 * convention).
 */
export type ElectrumFeeHistogram = [number, number][];

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
	private readonly keepaliveIntervalMs: number;
	private readonly maxBufferBytes: number;
	private readonly reportsHealth: boolean;

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
	private keepaliveTimer: NodeJS.Timeout | null = null;

	constructor(opts: ElectrumClientOptions) {
		super();
		this.host = opts.host;
		this.port = opts.port;
		this.useTls = opts.tls;
		this.tlsInsecure = opts.tlsInsecure ?? false;
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.socks5Host = opts.socks5Host || null;
		this.socks5Port = opts.socks5Port || null;
		this.keepaliveIntervalMs = opts.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
		this.maxBufferBytes = opts.maxBufferBytes ?? MAX_BUFFER_SIZE;
		this.reportsHealth = opts.reportsHealth ?? true;
		// Consumers may not attach an 'error' listener; never let EventEmitter throw.
		this.on('error', () => {});
	}

	get server(): string {
		return `${this.host}:${this.port}`;
	}

	/**
	 * Requests currently in flight on this socket (sent, awaiting a reply). The
	 * pool's lane-aware picker reads it to send an interactive request to the
	 * least-loaded connection, so a socket a background scan is saturating gets
	 * steered around (ElectrumPool.pick).
	 */
	get pendingCount(): number {
		return this.pending.size;
	}

	// ---------------------------------------------------------------- transport

	private ensureConnected(): Promise<void> {
		if (this.closed) return Promise.reject(new Error('Client is closed'));
		if (this.socket && !this.socket.destroyed && !this.connecting) return Promise.resolve();
		if (this.connecting) return this.connecting;
		// A backoff reconnect is already scheduled (onDisconnect armed reconnectTimer
		// after a drop). Respect it: fail fast instead of dialing a fresh connection
		// on every ambient request (cairn-sp74). Before this, during an outage every
		// user request called ensureConnected(), which ignored the scheduled delay and
		// hammered the dead server — the exact request storm backoff exists to prevent.
		// The scheduled attempt owns reconnection; when it succeeds, requests flow
		// again. Only reached while a reconnect loop is active (i.e. a subscription is
		// live); a purely lazy client schedules no timer and still reconnects on demand.
		if (this.reconnectTimer) {
			return Promise.reject(
				new Error(`Electrum reconnect to ${this.server} is backing off; try again shortly`)
			);
		}

		this.connecting = new Promise<void>((resolve, reject) => {
			let settled = false;

			// Deadline for the initial dial only (direct — non-proxy — TCP connect or
			// TLS handshake). The idle-socket timeout is deliberately disabled below
			// (`s.setTimeout(0)`, cairn-u7bw) so the keepalive can hold a healthy
			// connection open indefinitely; that also means it does nothing to bound a
			// *dial* that never completes — a backend that black-holes the SYN (or an
			// initial TLS byte) and never RSTs leaves this promise pending forever, and
			// every caller up the chain (scanWallet, getWalletDetail/listWallets, the
			// streamed page load) hangs with it (cairn-vn48). This timer is separate
			// from that idle timeout and only covers the connect/handshake phase. The
			// SOCKS5 CONNECT phase already gets its own bound via SocksClient's
			// `timeout` option; the TLS handshake negotiated over an established SOCKS5
			// tunnel is armed with this same timer below, since SocksClient's timeout
			// doesn't cover it (cairn-ocs9).
			let connectTimer: NodeJS.Timeout | null = null;
			const armConnectTimeout = (): void => {
				connectTimer = setTimeout(() => {
					connectTimer = null;
					if (this.connectingSocket) {
						this.connectingSocket.destroy();
						this.connectingSocket = null;
					}
					fail(
						new Error(
							`Electrum connect to ${this.host}:${this.port} timed out after ${this.timeoutMs}ms`
						)
					);
				}, this.timeoutMs);
				connectTimer.unref?.();
			};
			const disarmConnectTimeout = (): void => {
				if (connectTimer) {
					clearTimeout(connectTimer);
					connectTimer = null;
				}
			};

			const fail = (err: Error) => {
				if (settled) return;
				settled = true;
				this.connecting = null;
				disarmConnectTimeout();
				// Feed the instance-wide transport-health signal (cairn-hy8z): a failed
				// dial — proxy rejection, TLS error, connect timeout — is what makes the
				// "can't reach the Bitcoin network" banner appear instead of leaving the
				// user on an endless skeleton with no idea the transport is the problem.
				// Only a client explicitly marked reportsHealth may drive this signal
				// (cairn-d8aa) — a pool secondary or a throwaway test/probe connection
				// must never flip the real banner on its own transient failure.
				if (this.reportsHealth) recordChainError(err);
				reject(err);
			};

			let socket: net.Socket;
			const onReady = () => {
				// The dial succeeded — the connect-timeout's job is done, regardless of
				// what happens next (cairn-vn48).
				disarmConnectTimeout();
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
						// The transport is reachable right now — clears the unhealthy
						// signal + failure count behind the chain-health banner (cairn-hy8z).
						// Gated the same as the failure path above (cairn-d8aa).
						if (this.reportsHealth) recordChainOk();
						await this.resubscribe();
						this.startKeepalive();
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
							// The SOCKS CONNECT above is already bounded by SocksClient's
							// `timeout` option, but that only covers reaching the proxy and
							// tunneling to the destination -- the TLS handshake negotiated
							// over the tunnel afterward had no deadline of its own. A backend
							// that completes the tunnel then stalls the handshake left this
							// promise pending forever, wedging the whole pool (cairn-ocs9,
							// follow-up to cairn-vn48). Same timer, same arm/disarm/fail
							// machinery as the direct branches below.
							armConnectTimeout();
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
						armConnectTimeout();
						socket = wrapTls();
						attach(socket);
					} else {
						armConnectTimeout();
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

	/**
	 * Keepalive against idle-socket timeouts (cairn-u7bw): while connected and
	 * idle (no in-flight requests — real traffic already keeps the socket warm),
	 * send a server.ping every KEEPALIVE_INTERVAL_MS. Started after each
	 * successful handshake, stopped on disconnect/close, and unref'd like every
	 * other background timer in this codebase so it never holds the process open.
	 */
	private startKeepalive(): void {
		this.stopKeepalive();
		this.keepaliveTimer = setInterval(() => {
			// Only while connected and idle; rawRequest (not request) so a ping can
			// never trigger a reconnect of its own — reconnects belong to onDisconnect.
			const socket = this.socket;
			if (!socket || socket.destroyed || this.pending.size > 0) return;
			this.rawRequest('server.ping', []).catch((e: unknown) => {
				// A missed/failed keepalive means the socket is a zombie: TCP still
				// looks "established" but the peer has stopped answering (dead NAT
				// mapping, wedged server). Left alone, every future request would
				// silently eat a full request timeout against a socket that will
				// never respond (cairn-jhj6). Destroy it so the existing
				// 'close' -> onDisconnect -> backoff-reconnect path takes over —
				// reuse that machinery rather than starting a second reconnect loop
				// here. Re-check this.socket === socket first: a reconnect may have
				// already replaced it while this ping was in flight.
				if (this.socket === socket && !socket.destroyed) {
					log.warn(
						{ err: e, server: this.server },
						'keepalive ping failed; destroying stale connection'
					);
					socket.destroy();
				} else {
					log.debug({ err: e, server: this.server }, 'keepalive ping failed on a stale socket');
				}
			});
		}, this.keepaliveIntervalMs);
		this.keepaliveTimer.unref?.();
	}

	private stopKeepalive(): void {
		if (this.keepaliveTimer) {
			clearInterval(this.keepaliveTimer);
			this.keepaliveTimer = null;
		}
	}

	private onDisconnect(): void {
		this.stopKeepalive();
		this.connectingSocket = null;
		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.destroy();
			this.socket = null;
		}
		this.buffer = '';
		this.rejectAllPending(new Error(`Electrum connection lost (${this.server})`));
		if (this.closed) {
			this.emit('disconnect');
			return;
		}
		// Arm the backoff reconnect BEFORE notifying listeners (cairn-sp74). Only
		// reconnect eagerly when someone depends on subscriptions; otherwise the next
		// request() reconnects lazily. Scheduling first means that by the time a
		// 'disconnect' consumer (or any ambient request) runs, reconnectTimer is
		// already set, so ensureConnected()'s fail-fast guard holds — closing the
		// window where a request fired synchronously off 'disconnect' would still
		// bypass the backoff and redial the dead server immediately.
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
					// Wave 2 / log-chain.md: this was `debug` (prod-invisible) — the
					// only place a reconnect's actual failure reason (proxy
					// rejection, TLS error, timeout, …) surfaced per-attempt.
					// chainHealth's warn line covers the state FLIP; this covers
					// every attempt in between — real signal during an active
					// outage, cheap otherwise (bounded by backoff, at most one line
					// per RECONNECT_MAX_MS once fully backed off).
					log.warn({ err: e, server: this.server }, 'reconnect attempt failed; will back off');
				});
			}, delay);
			this.reconnectTimer.unref?.();
		}
		// Notify listeners last, with reconnect state already established (above).
		this.emit('disconnect');
	}

	private rejectAllPending(err: Error): void {
		for (const [, req] of this.pending) {
			clearTimeout(req.timer);
			req.reject(err);
		}
		this.pending.clear();
	}

	private async resubscribe(): Promise<void> {
		if (this.headersSubscribed) {
			try {
				const header = (await this.rawRequest('blockchain.headers.subscribe', [])) as ElectrumHeader;
				this.emit('header', header);
			} catch (e) {
				log.warn(
					{ err: e, server: this.server },
					'headers resubscribe after reconnect failed; live tip updates paused until next reconnect'
				);
			}
		}
		// Replay every watched scripthash CONCURRENTLY over the pipelined socket
		// (cairn-afdy). This used to be a serial for...await loop: a multi-wallet
		// instance paid N sequential round-trips on every reconnect, so reconnect
		// latency scaled with the number of watched scripthashes — the ARM/Umbrel
		// reconnect-storm pain point. allSettled so one failed subscribe can't drop
		// the rest (each still emits its own 'scripthash' on success); a lone
		// Promise.all rejection would abandon the survivors' events.
		const subs = [...this.scripthashSubs];
		if (subs.length === 0) return;
		const results = await Promise.allSettled(
			subs.map(async (sh) => {
				const status = await this.rawRequest('blockchain.scripthash.subscribe', [sh]);
				this.emit('scripthash', sh, status as string | null);
			})
		);
		const failed = results.filter((r) => r.status === 'rejected').length;
		if (failed > 0) {
			// A failed resubscribe silently stops live scripthash updates for those
			// addresses until the next disconnect/retry cycle — without this log there
			// is no diagnostic trail for "balances stopped updating but we're connected".
			log.warn(
				{ server: this.server, failed, total: subs.length },
				'some scripthash resubscriptions after reconnect failed; live updates paused for those until next reconnect'
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
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue; // ignore malformed lines
			}
			// JSON.parse happily accepts bare `null`, numbers, strings, arrays, etc.
			// dispatch() does property access assuming an object -- feeding it
			// anything else throws a TypeError. A single such line from a buggy or
			// hostile server must not crash the process (cairn-ek9s).
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				log.warn(
					{ server: this.server, line: line.slice(0, 200) },
					'ignoring non-object Electrum message'
				);
				continue;
			}
			try {
				this.dispatch(parsed as JsonRpcMessage);
			} catch (e) {
				log.warn({ err: e, server: this.server }, 'dispatch() threw for an Electrum message; ignoring');
			}
		}
		// After draining every complete line, whatever's left is an incomplete tail.
		// If that residual exceeds the cap the peer is streaming an unterminated
		// payload (memory-exhaustion DoS, cairn-32kh) — because chunks accumulate
		// here across onData() calls, even a single monstrous newline-terminated
		// line trips this before its terminator ever arrives. Drop the socket and
		// let onDisconnect's normal reject-pending + backoff-reconnect path run.
		if (this.buffer.length > this.maxBufferBytes) {
			log.warn(
				{ server: this.server, bufferBytes: this.buffer.length, capBytes: this.maxBufferBytes },
				'Electrum receive buffer exceeded cap without a message terminator; destroying connection'
			);
			this.buffer = '';
			const sock = this.socket ?? this.connectingSocket;
			sock?.destroy();
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

	/**
	 * Submit several raw transactions as one package (BIP-331 / Core's
	 * submitpackage), so a parent below the mempool's minimum relay fee is accepted
	 * together with a fee-paying child. Not every Electrum server implements
	 * `blockchain.transaction.broadcast_package`; the caller (packageRelay.ts)
	 * probes support and degrades silently. Resolves to the server's raw response
	 * (shape is server-dependent — typically the child/all txids).
	 */
	async broadcastPackage(rawTxHexes: string[]): Promise<unknown> {
		return this.request('blockchain.transaction.broadcast_package', [rawTxHexes]);
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

	/**
	 * The server's minimum relay fee, BTC/kvB (electrum convention, same units as
	 * {@link estimateFee}). Used as the Electrum-side relay-floor probe
	 * (ChainService.getRelayFeeFloor, cairn-eacw.3) when no Bitcoin Core RPC is
	 * configured. Not every server implements this method — callers should treat a
	 * rejection as "no answer" and fall back, the same way packageRelay.ts treats an
	 * unknown-method error as an unsupported verdict rather than a hard failure.
	 */
	async relayFee(): Promise<number> {
		return (await this.request('blockchain.relayfee', [])) as number;
	}

	/**
	 * The server's current mempool fee-rate distribution (`mempool.get_fee_histogram`,
	 * no params): [feeRate sat/vB, cumulative vsize] pairs, highest fee rate first.
	 * Sources the mempool fee-distribution chart from the operator's own Electrum
	 * connection instead of a third-party HTTP explorer API (cairn-zoz8.2).
	 */
	async getFeeHistogram(): Promise<ElectrumFeeHistogram> {
		return (await this.request('mempool.get_fee_histogram', [])) as ElectrumFeeHistogram;
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

	/**
	 * Stop watching a scripthash (cairn-gakd Phase 2). Two effects, in order:
	 *
	 *   1. Drop it from `scripthashSubs` — the set `resubscribe()` replays on every
	 *      reconnect. This is the leak fix: without it, that set only ever grew
	 *      with cumulative wallet churn, so reconnect cost climbed with the total
	 *      number of wallets ever watched rather than the number watched *now*
	 *      (the ARM/Umbrel reconnect-storm pain point). Pruning here bounds the
	 *      replay set to the current watch set.
	 *   2. Best-effort `blockchain.scripthash.unsubscribe` on the wire so the
	 *      server stops pushing status changes for it on THIS still-open socket.
	 *
	 * Deliberately does NOT connect: if there's no live socket there is nothing to
	 * tell the server (a subscription never survives a socket cycle anyway), and
	 * step 1 has already stopped the leak. The RPC is also best-effort because not
	 * every Electrum server implements `unsubscribe` — a rejection there is logged
	 * at debug and swallowed, since the local prune is what actually matters.
	 * Returns true only when the server acknowledged the unsubscribe.
	 */
	async unsubscribeScripthash(scripthash: string): Promise<boolean> {
		const wasWatched = this.scripthashSubs.delete(scripthash);
		if (!wasWatched) return false;
		const socket = this.socket;
		if (!socket || socket.destroyed) return false;
		try {
			await this.rawRequest('blockchain.scripthash.unsubscribe', [scripthash]);
			return true;
		} catch (e) {
			log.debug(
				{ err: e, server: this.server },
				'scripthash unsubscribe RPC failed (server may not support it); local prune already applied'
			);
			return false;
		}
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
		this.stopKeepalive();
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
