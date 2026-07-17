// Bitcoin Core JSON-RPC client (HTTP POST against a bitcoind node). Supports
// user/password Basic auth and cookie-file auth, a per-request timeout, and
// SOCKS5/Tor proxying — mirroring the connection-hygiene patterns established by
// ElectrumClient (electrum/client.ts).
//
// Deliberately a thin, honest transport: no TTL caching lives here (callers add
// their own where appropriate — cairn-zoz8.7). JSON-RPC error responses surface
// as CoreRpcError carrying Core's numeric error code so callers can branch on it
// (e.g. -5 = not found, -28 = node still warming up).

import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import type { Agent } from 'node:http';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { childLogger } from '../logger';

const log = childLogger('core-rpc');

const REQUEST_TIMEOUT_MS = 12_000;

export interface CoreRpcConfig {
	/** Base RPC URL, e.g. http://127.0.0.1:8332 */
	url: string;
	user?: string | null;
	pass?: string | null;
	/**
	 * Path to Core's `.cookie` file (contents are literally `user:pass` on one
	 * line). Core rewrites this file on every restart, so the credentials are
	 * re-read from disk on a 401 rather than cached forever.
	 */
	cookiePath?: string | null;
	/** Per-request timeout in ms (default 12000). */
	timeoutMs?: number;
	socks5Host?: string | null;
	socks5Port?: number | null;
	/**
	 * Optional per-call reachability sink (cairn-7qmw). Invoked after every RPC:
	 * `ok=true` when the node answered (an HTTP response we could parse — including
	 * a JSON-RPC error, since the node IS reachable), `ok=false` on a transport
	 * failure / auth rejection / timeout. Lets a long-lived service client feed a
	 * Core-scoped health signal without every call site knowing about it. The
	 * admin "Test connection" client leaves this unset so a probe never pollutes
	 * the global signal.
	 */
	onResult?: (ok: boolean, err?: unknown) => void;
}

/**
 * A JSON-RPC error returned by Core (`{error: {code, message}}`). Carries the
 * numeric `code` verbatim so callers can branch on it (RPC_INVALID_ADDRESS_OR_KEY
 * = -5 for not-found, RPC_IN_WARMUP = -28 while the node is still starting up).
 */
export class CoreRpcError extends Error {
	constructor(
		public readonly code: number,
		public readonly method: string,
		message: string
	) {
		super(`Core RPC ${method} failed (code ${code}): ${message}`);
		this.name = 'CoreRpcError';
	}
}

interface JsonRpcResponse {
	result?: unknown;
	error?: { code?: number; message?: string } | null;
	id?: unknown;
}

/**
 * Unwrap a fetch/undici error's chained `.cause` (and any AggregateError
 * members) into a single diagnosable string. Node's global fetch collapses the
 * real failure — DNS (ENOTFOUND), refused (ECONNREFUSED), TLS — into an opaque
 * `TypeError: fetch failed`, with the actual cause one or more `.cause` links
 * deep. Surfacing that chain is the whole point (the same trap was fixed for
 * the chain layer as cairn-s17j); do not let RPC transport errors regress to "fetch
 * failed".
 */
function fetchErrorDetail(err: unknown): string {
	const parts: string[] = [];
	const seen = new Set<unknown>();
	let cur: unknown = err;
	while (cur && !seen.has(cur)) {
		seen.add(cur);
		if (cur instanceof Error) {
			const code = (cur as { code?: unknown }).code;
			const msg =
				code !== undefined && code !== null ? `${cur.message} (${String(code)})` : cur.message;
			if (msg && !parts.includes(msg)) parts.push(msg);
			// AggregateError (e.g. happy-eyeballs: every address attempt failed) hides
			// the per-attempt reasons in `.errors`, not `.cause`.
			if (cur instanceof AggregateError && Array.isArray(cur.errors)) {
				for (const sub of cur.errors) {
					const subMsg = sub instanceof Error ? sub.message : String(sub);
					if (subMsg && !parts.includes(subMsg)) parts.push(subMsg);
				}
			}
			cur = (cur as { cause?: unknown }).cause;
		} else {
			const s = String(cur);
			if (s && !parts.includes(s)) parts.push(s);
			break;
		}
	}
	return parts.join(': ') || 'unknown error';
}

interface RawResponse {
	status: number;
	text: string;
}

export class CoreRpcClient {
	private readonly url: string;
	private readonly user: string | null;
	private readonly pass: string | null;
	private readonly cookiePath: string | null;
	private readonly timeoutMs: number;
	/** SOCKS5 proxy agent when a Tor/SOCKS proxy is configured; null = direct. */
	private readonly proxyAgent: Agent | null;
	/** Per-call reachability sink (cairn-7qmw); null when not tracking health. */
	private readonly onResult: ((ok: boolean, err?: unknown) => void) | null;

	/** In-memory cache of the cookie file's `user:pass` — dropped on any 401. */
	private cookieCreds: string | null = null;
	private nextId = 1;

	constructor(config: CoreRpcConfig) {
		this.url = config.url.replace(/\/+$/, '');
		this.user = config.user ?? null;
		this.pass = config.pass ?? null;
		this.cookiePath = config.cookiePath ?? null;
		this.timeoutMs = config.timeoutMs ?? REQUEST_TIMEOUT_MS;
		this.onResult = config.onResult ?? null;
		// socks5h:// keeps DNS resolution on the proxy side (no DNS leak, .onion
		// hosts resolve) — matches the Electrum Tor convention (cairn-oh7a).
		this.proxyAgent =
			config.socks5Host && config.socks5Port
				? new SocksProxyAgent(`socks5h://${config.socks5Host}:${config.socks5Port}`)
				: null;
	}

	// ------------------------------------------------------------------ auth

	/** `Authorization: Basic` header value, or null if no credentials configured. */
	private async authHeader(): Promise<string | null> {
		if (this.user != null && this.user !== '') {
			return 'Basic ' + Buffer.from(`${this.user}:${this.pass ?? ''}`).toString('base64');
		}
		if (this.cookiePath) {
			const creds = await this.readCookie();
			if (creds) return 'Basic ' + Buffer.from(creds).toString('base64');
		}
		return null;
	}

	/** Cookie `user:pass` from disk, memoized; re-read from file when the cache is empty. */
	private async readCookie(): Promise<string | null> {
		if (this.cookieCreds) return this.cookieCreds;
		if (!this.cookiePath) return null;
		try {
			const raw = (await readFile(this.cookiePath, 'utf8')).trim();
			this.cookieCreds = raw || null;
			return this.cookieCreds;
		} catch (e) {
			log.debug({ err: e, cookiePath: this.cookiePath }, 'failed to read Core RPC cookie file');
			return null;
		}
	}

	// ------------------------------------------------------------------ transport

	/**
	 * Generic JSON-RPC call over HTTP POST. Uses Core's 1.0-style envelope
	 * (universally accepted, including by pre-2.0 nodes). On a 401 the cookie
	 * file is re-read once and the single request retried (Core rotates the
	 * cookie on restart). JSON-RPC errors throw CoreRpcError; transport failures
	 * throw a diagnosable Error with the unwrapped cause chain.
	 */
	async call<T>(method: string, params: unknown[] = []): Promise<T> {
		try {
			const result = await this.perform<T>(method, params);
			// The node answered — reachable (cairn-7qmw).
			this.onResult?.(true);
			return result;
		} catch (e) {
			// A structured JSON-RPC error means the node DID answer (it's reachable,
			// just rejecting this particular request — e.g. -5 tx-not-found); only a
			// transport failure / auth rejection / timeout means it's unreachable.
			this.onResult?.(e instanceof CoreRpcError, e);
			throw e;
		}
	}

	private async perform<T>(method: string, params: unknown[] = []): Promise<T> {
		const id = this.nextId++;
		const body = JSON.stringify({ jsonrpc: '1.0', id, method, params });

		let res = await this.post(body, method);
		if (res.status === 401 && this.cookiePath) {
			// Core rewrote the cookie on restart — drop the cached creds, re-read the
			// file, and retry this one request once (do not cache stale creds forever).
			this.cookieCreds = null;
			await this.readCookie();
			res = await this.post(body, method);
		}
		if (res.status === 401) {
			throw new Error(
				`Core RPC ${method} failed: 401 Unauthorized (check rpcuser/rpcpassword or cookie file)`
			);
		}

		// Core returns the JSON-RPC envelope for both success (HTTP 200) and RPC
		// errors (HTTP 500 for 1.0-style, or 503 while warming up), so parse the
		// body first and prefer a structured error over the bare HTTP status.
		let parsed: JsonRpcResponse | null = null;
		try {
			parsed = JSON.parse(res.text) as JsonRpcResponse;
		} catch {
			parsed = null;
		}

		if (parsed && parsed.error != null) {
			const { code, message } = parsed.error;
			throw new CoreRpcError(
				typeof code === 'number' ? code : 0,
				method,
				message ?? 'unknown RPC error'
			);
		}

		if (res.status < 200 || res.status >= 300) {
			// Many bitcoind rejections (e.g. a 403 from an rpcallowip miss) carry an
			// empty body; appending ": <body>" then renders a dangling "HTTP 403: ."
			// (cairn-ymcg). Only include the body when there actually is one.
			const body = res.text.trim().slice(0, 200);
			throw new Error(
				`Core RPC ${method} failed: HTTP ${res.status}${body ? `: ${body}` : ''}`
			);
		}
		if (!parsed) {
			throw new Error(
				`Core RPC ${method} returned an unparseable response: ${res.text.slice(0, 200)}`
			);
		}
		return parsed.result as T;
	}

	/** One HTTP POST of the JSON-RPC body; direct via fetch, or through the SOCKS proxy. */
	private async post(body: string, method: string): Promise<RawResponse> {
		const auth = await this.authHeader();
		const headers: Record<string, string> = {
			'content-type': 'application/json'
		};
		if (auth) headers.authorization = auth;
		try {
			return this.proxyAgent
				? await this.proxiedPost(body, headers)
				: await this.directPost(body, headers);
		} catch (e) {
			// Never let the transport error collapse to a bare "fetch failed" — unwrap
			// the DNS/TLS/refused cause so the operator can actually diagnose it.
			throw new Error(`Core RPC ${method} request failed: ${fetchErrorDetail(e)}`);
		}
	}

	private async directPost(body: string, headers: Record<string, string>): Promise<RawResponse> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await fetch(this.url, {
				method: 'POST',
				signal: controller.signal,
				headers,
				body
			});
			return { status: res.status, text: await res.text() };
		} finally {
			clearTimeout(timer);
		}
	}

	/** POST over node http/https through the configured SOCKS5 proxy agent. */
	private proxiedPost(body: string, headers: Record<string, string>): Promise<RawResponse> {
		const lib = this.url.startsWith('https:') ? https : http;
		return new Promise((resolve, reject) => {
			const req = lib.request(
				this.url,
				{
					method: 'POST',
					agent: this.proxyAgent ?? undefined,
					headers: { ...headers, 'content-length': Buffer.byteLength(body).toString() },
					timeout: this.timeoutMs
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on('data', (c: Buffer) => chunks.push(c));
					res.on('end', () =>
						resolve({
							status: res.statusCode ?? 0,
							text: Buffer.concat(chunks).toString('utf8')
						})
					);
					res.on('error', reject);
				}
			);
			req.on('timeout', () => req.destroy(new Error(`timed out after ${this.timeoutMs}ms`)));
			req.on('error', reject);
			req.write(body);
			req.end();
		});
	}

	// ------------------------------------------------------------------ wrappers

	getBlockchainInfo(): Promise<{
		blocks: number;
		bestblockhash: string;
		chain: string;
		initialblockdownload?: boolean;
	}> {
		return this.call('getblockchaininfo');
	}

	getBlockCount(): Promise<number> {
		return this.call('getblockcount');
	}

	getBlockHash(height: number): Promise<string> {
		return this.call('getblockhash', [height]);
	}

	/**
	 * Block header. verbose=true (default) returns the decoded object (time, bits,
	 * difficulty, nonce, merkleroot, previousblockhash, …); verbose=false returns
	 * the 80-byte header as hex. `nTx` is not present at header-only verbosity.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- spec contract: callers consume decoded Core shapes directly
	getBlockHeader(hashOrHeight: string, verbose = true): Promise<any> {
		return this.call('getblockheader', [hashOrHeight, verbose]);
	}

	/** verbosity: 0 = raw hex, 1 = decoded + txids, 2 = decoded + full txs, 3 = + prevout. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- spec contract
	getBlock(hash: string, verbosity: 0 | 1 | 2 | 3 = 1): Promise<any> {
		return this.call('getblock', [hash, verbosity]);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- spec contract
	getBlockStats(hashOrHeight: string | number, stats?: string[]): Promise<any> {
		return this.call('getblockstats', stats ? [hashOrHeight, stats] : [hashOrHeight]);
	}

	/**
	 * Raw transaction. verbose=true (default) returns the decoded object (incl.
	 * confirmations, blockhash, blocktime). Fetching an arbitrary confirmed
	 * non-wallet txid needs Core's txindex enabled; errors propagate (not
	 * swallowed) so the caller sees why.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- spec contract
	getRawTransaction(txid: string, verbose = true): Promise<any> {
		return this.call('getrawtransaction', [txid, verbose]);
	}

	/** Unspent output details, or null when the output is spent or nonexistent. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- spec contract
	getTxOut(txid: string, n: number, includeMempool = true): Promise<any | null> {
		return this.call('gettxout', [txid, n, includeMempool]);
	}

	/**
	 * `minrelaytxfee` (BTC/kvB, Core >= 0.19) is the node's static configured relay
	 * floor; `mempoolminfee` (BTC/kvB) is the DYNAMIC floor — it rises above
	 * minrelaytxfee when the mempool is full. The effective relay floor for a
	 * transaction to be accepted right now is max(mempoolminfee, minrelaytxfee)
	 * (cairn-eacw.3, ChainService.getRelayFeeFloor).
	 */
	getMempoolInfo(): Promise<{
		size: number;
		bytes: number;
		usage: number;
		total_fee: number;
		mempoolminfee: number;
		minrelaytxfee?: number;
	}> {
		return this.call('getmempoolinfo');
	}

	getMempoolEntry(txid: string): Promise<{
		fees: { base: number; ancestor: number; descendant: number };
		ancestorsize: number;
		descendantsize: number;
		ancestorcount: number;
		descendantcount: number;
	}> {
		return this.call('getmempoolentry', [txid]);
	}

	/** Fee estimate; `feerate` is BTC/kvB. `errors` present when no estimate is available. */
	estimateSmartFee(
		confTarget: number,
		mode: 'UNSET' | 'ECONOMICAL' | 'CONSERVATIVE' = 'CONSERVATIVE'
	): Promise<{ feerate?: number; errors?: string[] }> {
		return this.call('estimatesmartfee', [confTarget, mode]);
	}

	getNetworkHashPs(nblocks = 120, height = -1): Promise<number> {
		return this.call('getnetworkhashps', [nblocks, height]);
	}

	/**
	 * Block template for mining (solo mining engine, cairn-vn43). `rules` declares
	 * the soft-forks the caller understands; segwit is required to get a
	 * `default_witness_commitment` for the coinbase. Needs wallet-independent GBT
	 * access on a fully-synced, non-pruned node.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- spec contract: caller consumes the decoded GBT shape
	getBlockTemplate(rules: string[] = ['segwit']): Promise<any> {
		return this.call('getblocktemplate', [{ rules }]);
	}

	/**
	 * Submit a fully-assembled block (hex). Core returns null on ACCEPTANCE, or a
	 * rejection-reason string (e.g. 'inconclusive', 'duplicate', 'high-hash').
	 * Normalized so a bare acceptance is always `null`.
	 */
	async submitBlock(hexBlock: string): Promise<string | null> {
		const result = await this.call<string | null | undefined>('submitblock', [hexBlock]);
		return result ?? null;
	}

	/**
	 * Lightweight reachability probe for an admin "test connection" action. Never
	 * throws — always resolves, reporting `{ ok: false, error }` when the node is
	 * unreachable, still warming up, or rejecting auth.
	 */
	async ping(): Promise<{ ok: boolean; blocks?: number; error?: string }> {
		try {
			const info = await this.getBlockchainInfo();
			return { ok: true, blocks: info.blocks };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	/** No persistent connection over HTTP; drop the cached cookie and the proxy agent. */
	close(): void {
		this.cookieCreds = null;
		(this.proxyAgent as { destroy?: () => void } | null)?.destroy?.();
	}
}
