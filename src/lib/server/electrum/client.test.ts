import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { ElectrumClient } from './client';
import type { ElectrumHeader } from './client';
import { getChainHealth, resetChainHealthForTests } from '../chainHealth';

interface RpcRequest {
	id: number;
	method: string;
	params: unknown[];
}

interface FakeServer {
	port: number;
	sockets: Set<net.Socket>;
	close(): Promise<void>;
}

// Self-signed cert (CN + SAN = 127.0.0.1) generated for these tests. It is NOT
// signed by any trusted CA, so a default TLS client (rejectUnauthorized) must
// refuse it — that refusal is exactly what the TLS tests below assert.
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCWuHbylzAzScJp
/o+MXZLa6NSwE+6pOBTmEVVAtnyEqXXwfPlxvUG783aoN1xJ/kCGWjlzMcNwBThw
7hSyL951DCvckHEaiRPfCtwYxoQmvgCuupY3O9qvO+/nOwbYqmpO7nnBvWNkx2+G
INh8deLZxPuo5dNatxCrvqnnXMoMaw27jixVaSGKrwP4lJkX23rXqIdAuVWeq7Gn
zqoj7+nTOYvwloQIRfQA5AagDjTmkctSZQxjgUygmkdZ7ZgG9G3RJHGWhkZGiYc9
PZiQXdrxZ6eT84YNZw+Tsz4CpMJikBP7jx49O6uBHFAAmWB+PhMXb2wMP3GgdI0T
9h/uLUfFAgMBAAECggEAE8fHzJSs/b4rZq/C9R/+uv4dk7I5+zlh/MO/lYudkeeP
k+1C63t0Gg+cvfzt/sQAgeFrcsPQK25z9tY4Hx6LKn9bbkoCngHperc5JYNAKrl6
63OPbVZMn/zUwlsLzfmnlA5WKmgJmFtYNpku8D6kdAIXKRZog5pM9M1EDRovZiuf
A7LCc/z1tN3qRvKg2+UL7cHdilsNlDzTaVi3ikFILE9tkAYPAxRV2UKyFGvHzwrb
hX5r2guu4XKk/XmtFCKAYhnYuBoEKASK2b6aZMIZuDwaWjIO4DUMuMMX1Dy4LglB
4mhw18sFC6huOrdQIQUWYZ5Y+ctC7X8X54N5bCIMbQKBgQDH0vgsrHyAByEQzxVP
T6sEW9hSG9O0pvLrjhWbG16eEG1Zlsu1mEXQWLP+yI3teDGAbdept+sMtbWcCHI3
reBJjP1r+m+lZWvNkXvUsAVAgCLQdS5tH0Sy+qOND2oRfltz/M/WkZWnRpLm4amH
5gjMjZXWTljdinn0DpPAbLcFywKBgQDBF5cJMRyt12GRRb79J2g3TPDwaZq2+/7o
gKSVoISaju5PW3DE8E1/fasf0/47vTsZvfM6PKQAuYdn1vu7XzFavwLkz7T+scVF
SQQqGtjubSqwp//Zb4zb/ktKdoB5oIJe8OWyoqJUoXnoLc2Ax+nP2TVy2qzndkPG
gxiXDpa2rwKBgA45RTMg4AfY+hCRPQoVOK4pv38wveQZEieUSJNu4lBMCQycgEmf
2jBXcBCNxBSIPrXOm9BX6CJSeOfvbfnqpZF2uL9L51CVpJPQbEkacnVB6bh+7twT
orc+wg+TblBqdyYNc9npKQbsLh7DJ2cmB7BPz7+eehLi/YVS2E+VLX37AoGATvhJ
4g1+8C4dDh/bO4fJXIyQIZLfHqUzHH24UiWC9f8swbHhDfpFh7WqreqymFYM/Lst
5Yx1eoJmOXa4H2qQMc/a7B9yo5Oq3Wo+VMYEIIbvJa6fuZqgnjyDKGIMqzGVACU/
m+5du4UK6YUJ/fhEzKfF70I14rgAggiNnwHta6sCgYB9ndcBtyIdcqcTPSL4m14R
VdZ5nMLN31J8cBUiOjNs8oAqz2j+DWDvHsJ4OV8oXOG3Z8nW+C7mcFcqKM8uQi4l
Or50pB3A1jkJVb0JDkY6g8j2TkwFBCz8g6FnA7DyV6/c2Lt2Q96JuYMqcc71W7ie
Bf//HXCZTvsEN+hEKo+sHA==
-----END PRIVATE KEY-----`;

const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDGjCCAgKgAwIBAgIUTOTY22xdz92EZbvOwNVtYUNVjV4wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDcwNjExMjkxMFoXDTM2MDcw
MzExMjkxMFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAlrh28pcwM0nCaf6PjF2S2ujUsBPuqTgU5hFVQLZ8hKl1
8Hz5cb1Bu/N2qDdcSf5Ahlo5czHDcAU4cO4Usi/edQwr3JBxGokT3wrcGMaEJr4A
rrqWNzvarzvv5zsG2KpqTu55wb1jZMdvhiDYfHXi2cT7qOXTWrcQq76p51zKDGsN
u44sVWkhiq8D+JSZF9t616iHQLlVnquxp86qI+/p0zmL8JaECEX0AOQGoA405pHL
UmUMY4FMoJpHWe2YBvRt0SRxloZGRomHPT2YkF3a8Wenk/OGDWcPk7M+AqTCYpAT
+48ePTurgRxQAJlgfj4TF29sDD9xoHSNE/Yf7i1HxQIDAQABo2QwYjAdBgNVHQ4E
FgQUORIHpq2edPNi7T8cxIQnvGpkNJkwHwYDVR0jBBgwFoAUORIHpq2edPNi7T8c
xIQnvGpkNJkwDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMA0GCSqG
SIb3DQEBCwUAA4IBAQCRcVb75zqjBVxttdnRprCgYg4MRKPk8V20UaOO2ZskVHrt
FjNZ9T+w9E2Kta9ReuZyITkvMdseE/Q2L3X9kLOsh8OcPur2bT8N5njNu0n3yUEn
DunhIPItl0qKSff2qItaW1C5VFYIUENQgh5LIAn2rqCQM4Iiwmk0eOG2qFyodX+d
tGO8qGSYAYW0uRpoyxnz2avXnNweJlc/TgKbeiMvl6T2tO7gzRHzlARvYtjXVyEC
8QlRQjtJFjDBubsHuYUbRhydsa9EMsfue+FEcz1/qyR0qYiTP1OPNzR6yWO0m+ga
7je7oJCYzdAlQanLJZSdj5wh1qL/W6jGbKr0me+f
-----END CERTIFICATE-----`;

/**
 * Wire one accepted socket to the newline-delimited JSON-RPC protocol. Shared by
 * the plain-TCP and TLS fake servers. `onRequest` decides how (and whether) to
 * answer each request; the server.version handshake is answered automatically
 * unless the handler returns true (meaning "handled").
 */
function wireRpcSocket(
	socket: net.Socket,
	sockets: Set<net.Socket>,
	onRequest: (req: RpcRequest, socket: net.Socket) => boolean | void
): void {
	sockets.add(socket);
	socket.on('close', () => sockets.delete(socket));
	socket.on('error', () => {});
	let buffer = '';
	socket.on('data', (chunk: Buffer | string) => {
		buffer += chunk.toString();
		let idx: number;
		while ((idx = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			if (!line.trim()) continue;
			const req = JSON.parse(line) as RpcRequest;
			const handled = onRequest(req, socket);
			if (!handled && req.method === 'server.version') {
				reply(socket, req.id, ['FakeElectrumX 1.0', '1.4']);
			}
		}
	});
}

/** Loopback newline-delimited JSON-RPC server over plain TCP. */
function startServer(
	onRequest: (req: RpcRequest, socket: net.Socket) => boolean | void
): Promise<FakeServer> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => wireRpcSocket(socket, sockets, onRequest));
	return new Promise((resolve, reject) => {
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as net.AddressInfo).port;
			resolve({
				port,
				sockets,
				close: () =>
					new Promise<void>((res) => {
						for (const s of sockets) s.destroy();
						server.close(() => res());
					})
			});
		});
	});
}

/** Same loopback JSON-RPC server, but over TLS with the self-signed fixture cert. */
function startTlsServer(
	onRequest: (req: RpcRequest, socket: net.Socket) => boolean | void
): Promise<FakeServer> {
	const sockets = new Set<net.Socket>();
	const server = tls.createServer({ key: TLS_KEY, cert: TLS_CERT }, (socket) =>
		wireRpcSocket(socket, sockets, onRequest)
	);
	return new Promise((resolve, reject) => {
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as net.AddressInfo).port;
			resolve({
				port,
				sockets,
				close: () =>
					new Promise<void>((res) => {
						for (const s of sockets) s.destroy();
						server.close(() => res());
					})
			});
		});
	});
}

/**
 * A minimal SOCKS5 proxy (no auth) that forwards each CONNECT to its requested
 * destination. Enough to prove ElectrumClient dials through a proxy rather than
 * connecting directly. `state.connects` counts accepted CONNECT requests.
 */
function startSocks5Proxy(): Promise<{
	port: number;
	state: { connects: number };
	close: () => Promise<void>;
}> {
	const state = { connects: 0 };
	const sockets = new Set<net.Socket>();
	const server = net.createServer((client) => {
		sockets.add(client);
		client.on('close', () => sockets.delete(client));
		client.on('error', () => {});
		let stage = 0;
		let buf = Buffer.alloc(0);
		client.on('data', (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);
			if (stage === 0) {
				if (buf.length < 2) return;
				const nmethods = buf[1];
				if (buf.length < 2 + nmethods) return;
				buf = buf.subarray(2 + nmethods);
				client.write(Buffer.from([0x05, 0x00])); // version 5, no auth
				stage = 1;
			}
			if (stage === 1) {
				if (buf.length < 4) return;
				const atyp = buf[3];
				let host: string;
				let offset: number;
				if (atyp === 0x01) {
					if (buf.length < 10) return;
					host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
					offset = 8;
				} else if (atyp === 0x03) {
					const len = buf[4];
					if (buf.length < 5 + len + 2) return;
					host = buf.subarray(5, 5 + len).toString('utf8');
					offset = 5 + len;
				} else {
					client.end();
					return;
				}
				const port = buf.readUInt16BE(offset);
				state.connects++;
				const upstream = net.connect({ host, port }, () => {
					// CONNECT succeeded — reply, then bridge both directions.
					client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
					const rest = buf.subarray(offset + 2);
					if (rest.length) upstream.write(rest);
					client.pipe(upstream);
					upstream.pipe(client);
				});
				sockets.add(upstream);
				upstream.on('close', () => sockets.delete(upstream));
				upstream.on('error', () => client.destroy());
				stage = 2;
			}
		});
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as net.AddressInfo).port;
			resolve({
				port,
				state,
				close: () =>
					new Promise<void>((res) => {
						for (const s of sockets) s.destroy();
						server.close(() => res());
					})
			});
		});
	});
}

function reply(socket: net.Socket, id: number, result: unknown): void {
	socket.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function notify(socket: net.Socket, method: string, params: unknown[]): void {
	socket.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

interface FakeConnectingSocket extends EventEmitter {
	destroyed: boolean;
	destroy: ReturnType<typeof vi.fn>;
	setEncoding: ReturnType<typeof vi.fn>;
	setTimeout: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
}

/**
 * A stand-in for a `net.Socket` mid-dial: just enough of the socket API for
 * `attach()`/`armConnectTimeout()` (client.ts) to operate on, with no real
 * transport underneath. Lets the connect-timeout tests (cairn-vn48) simulate
 * a backend that never finishes connecting (or connects on command)
 * deterministically, instead of depending on real — and in a sandboxed test
 * runner, potentially unreliable — black-hole network behavior.
 */
function makeFakeConnectingSocket(): FakeConnectingSocket {
	const socket = new EventEmitter() as FakeConnectingSocket;
	socket.destroyed = false;
	socket.destroy = vi.fn(() => {
		socket.destroyed = true;
	});
	socket.setEncoding = vi.fn();
	socket.setTimeout = vi.fn();
	socket.write = vi.fn();
	return socket;
}

const cleanups: (() => void | Promise<void>)[] = [];

function makeClient(port: number, timeoutMs = 2000): ElectrumClient {
	const client = new ElectrumClient({ host: '127.0.0.1', port, tls: false, timeoutMs });
	cleanups.push(() => client.close());
	return client;
}

afterEach(async () => {
	// Safety net: a test that faked timers and then threw before restoring must
	// not leak fake timers into teardown (or the next test).
	vi.useRealTimers();
	// Close clients before servers so no reconnect attempts fire mid-teardown.
	while (cleanups.length > 0) {
		await cleanups.pop()!();
	}
	// The chain-health module is process-global state (chainHealth.ts) — reset it
	// so a reportsHealth assertion in one test can't leak into the next.
	resetChainHealthForTests();
});

async function withServer(
	onRequest: (req: RpcRequest, socket: net.Socket) => boolean | void
): Promise<FakeServer> {
	const server = await startServer(onRequest);
	cleanups.push(() => server.close());
	return server;
}

async function withTlsServer(
	onRequest: (req: RpcRequest, socket: net.Socket) => boolean | void
): Promise<FakeServer> {
	const server = await startTlsServer(onRequest);
	cleanups.push(() => server.close());
	return server;
}

describe('ElectrumClient', () => {
	it('correlates out-of-order responses by request id', async () => {
		const held: RpcRequest[] = [];
		const server = await withServer((req, socket) => {
			if (req.method === 'echo') {
				held.push(req);
				if (held.length === 2) {
					// Answer the SECOND request first.
					reply(socket, held[1].id, held[1].params[0]);
					reply(socket, held[0].id, held[0].params[0]);
				}
				return true;
			}
		});

		const client = makeClient(server.port);
		const [a, b] = await Promise.all([
			client.request('echo', ['first']),
			client.request('echo', ['second'])
		]);
		expect(a).toBe('first');
		expect(b).toBe('second');
	});

	it('batchRequest resolves all requests', async () => {
		const server = await withServer((req, socket) => {
			if (req.method === 'echo') {
				reply(socket, req.id, `res:${req.params[0]}`);
				return true;
			}
		});

		const client = makeClient(server.port);
		const results = await client.batchRequest([
			{ method: 'echo', params: ['a'] },
			{ method: 'echo', params: ['b'] },
			{ method: 'echo', params: ['c'] }
		]);
		expect(results).toEqual(['res:a', 'res:b', 'res:c']);
	});

	it('getFeeHistogram returns the mempool.get_fee_histogram pairs (no params)', async () => {
		const histogram = [
			[120, 15000],
			[50, 32000],
			[10, 210000],
			[1, 90000]
		];
		let sawParams: unknown[] | undefined;
		const server = await withServer((req, socket) => {
			if (req.method === 'mempool.get_fee_histogram') {
				sawParams = req.params;
				reply(socket, req.id, histogram);
				return true;
			}
		});

		const client = makeClient(server.port);
		await expect(client.getFeeHistogram()).resolves.toEqual(histogram);
		expect(sawParams).toEqual([]);
	});

	it('rejects with an Electrum error for JSON-RPC error responses', async () => {
		const server = await withServer((req, socket) => {
			if (req.method === 'boom') {
				socket.write(
					JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: 1, message: 'kaboom' } }) +
						'\n'
				);
				return true;
			}
		});

		const client = makeClient(server.port);
		await expect(client.request('boom')).rejects.toThrow(/kaboom/);
	});

	it('times out a request the server never answers, at the configured timeoutMs', async () => {
		const server = await withServer((req, socket) => {
			if (req.method === 'warmup') {
				reply(socket, req.id, 'ok');
				return true;
			}
			if (req.method === 'never.answers') return true; // swallow it
		});

		const client = makeClient(server.port, 200);
		// Establish the connection under real timers so the handshake IO completes;
		// only the request-timeout itself is driven by the fake clock, so this is
		// deterministic rather than racing a wall-clock window (cairn-vp78).
		await client.request('warmup');

		// Fake ONLY setTimeout/clearTimeout (what the request timeout uses). Leaving
		// setImmediate + IO real keeps the loopback socket working and avoids
		// colliding with vitest's own immediate-based tick loop.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			// Attach the rejection assertion BEFORE advancing the clock, so the
			// timer-driven rejection is never momentarily unhandled.
			const assertion = expect(client.request('never.answers')).rejects.toThrow(
				/timed out after 200ms/
			);
			await vi.advanceTimersByTimeAsync(200);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects pending requests when the server closes the socket mid-flight', async () => {
		const server = await withServer((req, socket) => {
			if (req.method === 'hang.then.die') {
				// Never answer; drop the connection shortly after.
				setTimeout(() => socket.destroy(), 20);
				return true;
			}
		});

		const client = makeClient(server.port, 5000);
		await expect(client.request('hang.then.die')).rejects.toThrow(/connection lost/i);
	});

	it('emits a header event for unsolicited headers.subscribe notifications', async () => {
		let subscriberSocket: net.Socket | null = null;
		const server = await withServer((req, socket) => {
			if (req.method === 'blockchain.headers.subscribe') {
				subscriberSocket = socket;
				reply(socket, req.id, { height: 900000, hex: 'aa'.repeat(80) });
				return true;
			}
		});

		const client = makeClient(server.port);
		const tip = await client.headersSubscribe();
		expect(tip).toEqual({ height: 900000, hex: 'aa'.repeat(80) });

		const nextHeader = new Promise<ElectrumHeader>((resolve) =>
			client.once('header', resolve)
		);
		notify(subscriberSocket!, 'blockchain.headers.subscribe', [
			{ height: 900001, hex: 'bb'.repeat(80) }
		]);
		await expect(nextHeader).resolves.toEqual({ height: 900001, hex: 'bb'.repeat(80) });
	});

	it('emits scripthash events for unsolicited scripthash notifications', async () => {
		const sh = '11'.repeat(32);
		let subscriberSocket: net.Socket | null = null;
		const server = await withServer((req, socket) => {
			if (req.method === 'blockchain.scripthash.subscribe') {
				subscriberSocket = socket;
				reply(socket, req.id, null);
				return true;
			}
		});

		const client = makeClient(server.port);
		await expect(client.subscribeScripthash(sh)).resolves.toBeNull();

		const change = new Promise<[string, string | null]>((resolve) =>
			client.once('scripthash', (hash: string, status: string | null) => resolve([hash, status]))
		);
		notify(subscriberSocket!, 'blockchain.scripthash.subscribe', [sh, 'status1']);
		await expect(change).resolves.toEqual([sh, 'status1']);
	});

	it('rejects requests after close() and rejects anything pending', async () => {
		let sawNeverAnswers = false;
		const server = await withServer((req, socket) => {
			if (req.method === 'echo') {
				reply(socket, req.id, req.params[0]);
				return true;
			}
			if (req.method === 'never.answers') {
				sawNeverAnswers = true;
				return true; // swallow it
			}
		});

		const client = makeClient(server.port, 5000);
		await client.request('echo', ['warm-up']); // establish the connection

		const caught = client.request('never.answers').catch((e: Error) => e.message);
		// Let the request reach the server (and the pending map) before closing.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(sawNeverAnswers).toBe(true);
		client.close();

		await expect(caught).resolves.toMatch(/closed/i);
		await expect(client.request('server.ping')).rejects.toThrow(/closed/i);
	});

	// ------------------------------------------------------------------ TLS validation

	it('rejects a self-signed certificate by default (tlsInsecure not set)', async () => {
		const server = await withTlsServer((req, socket) => {
			if (req.method === 'server.ping') {
				reply(socket, req.id, null);
				return true;
			}
		});

		const client = new ElectrumClient({
			host: '127.0.0.1',
			port: server.port,
			tls: true,
			timeoutMs: 2000
		});
		cleanups.push(() => client.close());

		// The untrusted cert must abort the handshake before any RPC succeeds.
		await expect(client.request('server.ping')).rejects.toThrow();
	});

	it('accepts a self-signed certificate when tlsInsecure is true', async () => {
		const server = await withTlsServer((req, socket) => {
			if (req.method === 'server.ping') {
				reply(socket, req.id, null);
				return true;
			}
		});

		const client = new ElectrumClient({
			host: '127.0.0.1',
			port: server.port,
			tls: true,
			tlsInsecure: true,
			timeoutMs: 2000
		});
		cleanups.push(() => client.close());

		await expect(client.request('server.ping')).resolves.toBeNull();
	});

	// ------------------------------------------------------------------ SOCKS5 proxy

	it('dials the Electrum server through a SOCKS5 proxy when configured', async () => {
		const upstream = await withServer((req, socket) => {
			if (req.method === 'server.ping') {
				reply(socket, req.id, 'pong');
				return true;
			}
		});
		const proxy = await startSocks5Proxy();
		cleanups.push(() => proxy.close());

		const client = new ElectrumClient({
			host: '127.0.0.1',
			port: upstream.port,
			tls: false,
			timeoutMs: 2000,
			socks5Host: '127.0.0.1',
			socks5Port: proxy.port
		});
		cleanups.push(() => client.close());

		// The request completes end-to-end, and it went through the proxy's CONNECT.
		await expect(client.request('server.ping')).resolves.toBe('pong');
		expect(proxy.state.connects).toBe(1);
	});

	it('surfaces an error when the SOCKS5 proxy is unreachable', async () => {
		const upstream = await withServer(() => {});
		// Point at a proxy port with nothing listening.
		const deadProxyPort = upstream.port === 1 ? 2 : 1;
		const client = new ElectrumClient({
			host: '127.0.0.1',
			port: upstream.port,
			tls: false,
			timeoutMs: 2000,
			socks5Host: '127.0.0.1',
			socks5Port: deadProxyPort
		});
		cleanups.push(() => client.close());

		await expect(client.request('server.ping')).rejects.toThrow();
	});

	// --------------------------------------------------------- reconnect / resubscribe

	it('reconnects and resubscribes an active scripthash after the socket drops', async () => {
		const sh = '22'.repeat(32);
		let handshakes = 0;
		let subscribes = 0;
		const server = await withServer((req, socket) => {
			if (req.method === 'server.version') {
				handshakes++;
				return; // let the auto-handshake reply
			}
			if (req.method === 'blockchain.scripthash.subscribe') {
				subscribes++;
				if (subscribes === 1) {
					// Answer the first subscribe, then drop the connection to force a
					// reconnect + resubscribe cycle.
					reply(socket, req.id, null);
					setTimeout(() => socket.destroy(), 20);
				} else {
					reply(socket, req.id, 'status-after-reconnect');
				}
				return true;
			}
		});

		const client = makeClient(server.port, 2000);

		// The reconnect after the drop is the client's 2nd successful 'connect'.
		const reconnected = new Promise<void>((resolve) => {
			let n = 0;
			client.on('connect', () => {
				if (++n === 2) resolve();
			});
		});
		// On reconnect, resubscribe() re-emits the scripthash with its fresh status.
		const resubEmit = new Promise<[string, string | null]>((resolve) => {
			client.on('scripthash', (hash: string, status: string | null) => {
				if (status === 'status-after-reconnect') resolve([hash, status]);
			});
		});

		await client.subscribeScripthash(sh);
		await reconnected;
		await expect(resubEmit).resolves.toEqual([sh, 'status-after-reconnect']);
		expect(handshakes).toBeGreaterThanOrEqual(2); // reconnect re-ran the handshake
		expect(subscribes).toBeGreaterThanOrEqual(2); // and re-subscribed the scripthash
	}, 8000);

	it('unsubscribeScripthash sends the unsubscribe RPC and stops replaying it on reconnect (cairn-gakd)', async () => {
		const kept = 'aa'.repeat(32);
		const dropped = 'bb'.repeat(32);
		let unsubscribes = 0;
		const resubscribedAfterReconnect: string[] = [];
		let handshakes = 0;
		let firstConnectionSocket: net.Socket | null = null;
		const server = await withServer((req, socket) => {
			if (req.method === 'server.version') {
				handshakes++;
				return;
			}
			if (req.method === 'blockchain.scripthash.subscribe') {
				// Any subscribe arriving on the SECOND (reconnected) socket is a
				// resubscribe replay — record which scripthashes get replayed.
				if (handshakes >= 2) resubscribedAfterReconnect.push(req.params[0] as string);
				reply(socket, req.id, null);
				return true;
			}
			if (req.method === 'blockchain.scripthash.unsubscribe') {
				unsubscribes++;
				reply(socket, req.id, true);
				return true;
			}
			return;
		});

		const client = makeClient(server.port, 2000);
		await client.subscribeScripthash(kept);
		await client.subscribeScripthash(dropped);
		firstConnectionSocket = [...server.sockets][0];

		// Release one subscription: the RPC must go out on the live socket...
		await expect(client.unsubscribeScripthash(dropped)).resolves.toBe(true);
		expect(unsubscribes).toBe(1);
		// ...and unsubscribing something never subscribed is a no-op (no RPC).
		await expect(client.unsubscribeScripthash('cc'.repeat(32))).resolves.toBe(false);
		expect(unsubscribes).toBe(1);

		// Force a reconnect: only the still-subscribed scripthash is replayed.
		const reconnected = new Promise<void>((resolve) => {
			let n = 0;
			client.on('connect', () => {
				if (++n === 1) resolve();
			});
		});
		firstConnectionSocket!.destroy();
		await reconnected;
		// Give resubscribe() a moment to replay on the fresh socket.
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(resubscribedAfterReconnect).toContain(kept);
		expect(resubscribedAfterReconnect).not.toContain(dropped);
	}, 8000);

	it('unsubscribeScripthash prunes local state without a socket when disconnected (cairn-gakd)', async () => {
		const sh = 'dd'.repeat(32);
		const server = await withServer((req, socket) => {
			if (req.method === 'blockchain.scripthash.subscribe') {
				reply(socket, req.id, null);
				return true;
			}
			return;
		});
		const client = makeClient(server.port, 2000);
		await client.subscribeScripthash(sh);
		// Kill the socket so there's nothing to send an unsubscribe on. The prune of
		// the resubscribe set must still happen; returns false (no wire ack).
		for (const s of server.sockets) s.destroy();
		await new Promise((resolve) => setTimeout(resolve, 50));
		await expect(client.unsubscribeScripthash(sh)).resolves.toBe(false);
	}, 8000);

	it('does not eagerly reconnect after a drop when nothing is subscribed', async () => {
		let handshakes = 0;
		const server = await withServer((req, socket) => {
			if (req.method === 'server.version') handshakes++;
			if (req.method === 'server.ping') {
				reply(socket, req.id, null);
				return true;
			}
		});

		const client = makeClient(server.port, 2000);
		await client.request('server.ping'); // connect, no subscription
		expect(handshakes).toBe(1);

		for (const s of server.sockets) s.destroy();
		// Wait past the minimum reconnect backoff; with no active subscriptions the
		// client must stay idle rather than dial back in.
		await new Promise((resolve) => setTimeout(resolve, 1300));
		expect(handshakes).toBe(1);
	}, 8000);

	it('resubscribes all scripthashes concurrently after a reconnect (cairn-afdy)', async () => {
		// Three watched scripthashes; on reconnect they must ALL be re-subscribed in
		// parallel over the pipelined socket, not one-await-at-a-time. The proof is
		// deterministic and timing-free: on the reconnected socket the server
		// WITHHOLDS every subscribe reply until it has received all three requests.
		// A parallel resubscribe fires all three before awaiting any reply, so they
		// arrive and the server releases them; a serial loop would block on reply #1
		// (never sent) and deadlock, failing the 8s test.
		const shs = ['1a', '2b', '3c'].map((p) => p.repeat(32));
		let handshakes = 0;
		const withheld: { socket: net.Socket; id: number; sh: string }[] = [];
		const server = await withServer((req, socket) => {
			if (req.method === 'server.version') {
				handshakes++;
				return;
			}
			if (req.method === 'blockchain.scripthash.subscribe') {
				const sh = req.params[0] as string;
				if (handshakes === 1) {
					// Initial subscribes on the first connection — answer immediately.
					reply(socket, req.id, null);
					return true;
				}
				// Reconnect replay: hold until all three have arrived, then release.
				withheld.push({ socket, id: req.id, sh });
				if (withheld.length === shs.length) {
					for (const w of withheld) reply(w.socket, w.id, `st:${w.sh}`);
				}
				return true;
			}
		});

		const client = makeClient(server.port, 2000);
		for (const sh of shs) await client.subscribeScripthash(sh);

		const resubDone = new Promise<void>((resolve) => {
			const seen = new Set<string>();
			client.on('scripthash', (hash: string, status: string | null) => {
				if (typeof status === 'string' && status.startsWith('st:')) {
					seen.add(hash);
					if (seen.size === shs.length) resolve();
				}
			});
		});

		for (const s of server.sockets) s.destroy(); // force reconnect + resubscribe
		await resubDone; // resolves only if all three were in flight at once
		expect(handshakes).toBeGreaterThanOrEqual(2);
	}, 8000);

	it('respects the reconnect backoff timer — an ambient request fails fast instead of redialing (cairn-sp74)', async () => {
		let handshakes = 0;
		const server = await withServer((req, socket) => {
			if (req.method === 'server.version') {
				handshakes++;
				return;
			}
			if (req.method === 'blockchain.headers.subscribe') {
				reply(socket, req.id, { height: 1, hex: 'aa'.repeat(80) });
				return true;
			}
			if (req.method === 'server.ping') {
				reply(socket, req.id, null);
				return true;
			}
		});

		const client = makeClient(server.port, 2000);
		await client.headersSubscribe(); // active subscription -> reconnect is eager
		expect(handshakes).toBe(1);

		// When the socket drops, onDisconnect arms a backoff reconnectTimer (~1s).
		// A request issued in that window must reject fast WITHOUT starting its own
		// dial — the scheduled reconnect owns reconnection. We drive the request
		// synchronously from the 'disconnect' handler, i.e. inside the backoff window
		// before the timer fires, so this is deterministic under real timers.
		const outcome = new Promise<string>((resolve) => {
			client.once('disconnect', () => {
				resolve(
					client
						.request('server.ping')
						.then(() => 'connected')
						.catch((e: Error) => e.message)
				);
			});
		});
		for (const s of server.sockets) s.destroy();

		await expect(outcome).resolves.toMatch(/backing off/i);
		// The fail-fast request must not have triggered a fresh handshake/dial.
		expect(handshakes).toBe(1);
	}, 8000);

	// ------------------------------------------------------- malformed messages

	it('ignores a bare `null` (or other non-object) JSON-RPC line instead of crashing', async () => {
		const server = await withServer((req, socket) => {
			if (req.method === 'echo') {
				// Malformed lines a buggy/hostile server might send: JSON.parse accepts
				// all of these, but none of them is a property-accessible message
				// object (cairn-ek9s). They must be dropped, not crash the process.
				socket.write('null\n');
				socket.write('42\n');
				socket.write('"just a string"\n');
				socket.write('[1,2,3]\n');
				reply(socket, req.id, req.params[0]);
				return true;
			}
		});

		const client = makeClient(server.port);
		await expect(client.request('echo', ['still alive'])).resolves.toBe('still alive');
	});

	it('recovers when a message handler throws during dispatch()', async () => {
		let subscriberSocket: net.Socket | null = null;
		const server = await withServer((req, socket) => {
			if (req.method === 'blockchain.headers.subscribe') {
				subscriberSocket = socket;
				reply(socket, req.id, { height: 1, hex: 'aa'.repeat(80) });
				return true;
			}
			if (req.method === 'echo') {
				reply(socket, req.id, req.params[0]);
				return true;
			}
		});

		const client = makeClient(server.port);
		await client.headersSubscribe();
		client.once('header', () => {
			// Simulate a buggy consumer listener; dispatch() must not let this
			// propagate up through the socket 'data' handler (cairn-ek9s).
			throw new Error('listener boom');
		});

		notify(subscriberSocket!, 'blockchain.headers.subscribe', [{ height: 2, hex: 'bb'.repeat(80) }]);
		// Give onData a turn to process the notification (and the throwing listener).
		await new Promise((resolve) => setImmediate(resolve));

		// Still usable afterward proves the throw was contained.
		await expect(client.request('echo', ['still alive'])).resolves.toBe('still alive');
	});

	// ------------------------------------------------------- receive-buffer cap

	it('destroys the connection when an unterminated payload exceeds the buffer cap (cairn-32kh)', async () => {
		// A server that streams bytes and never sends a newline would otherwise grow
		// the client's receive buffer without bound (memory-exhaustion DoS). With a
		// small cap the guard trips: the socket is destroyed and the in-flight
		// request rejects via the normal connection-lost path.
		const server = await withServer((req, socket) => {
			if (req.method === 'flood') {
				// Well over the 1 KiB cap set below, and crucially NO trailing newline,
				// so onData() can never drain it as a complete line.
				socket.write('x'.repeat(4096));
				return true; // never send a real reply
			}
		});

		const client = new ElectrumClient({
			host: '127.0.0.1',
			port: server.port,
			tls: false,
			timeoutMs: 5000,
			maxBufferBytes: 1024
		});
		cleanups.push(() => client.close());

		await expect(client.request('flood')).rejects.toThrow(/connection lost|closed/i);
	});

	it('does not destroy the connection for a large but newline-terminated response under the cap (cairn-32kh)', async () => {
		// A legitimate response near the cap but properly terminated must drain
		// cleanly — the guard checks the RESIDUAL after draining complete lines, so
		// a finished message leaves an empty residual and never trips.
		const big = 'y'.repeat(800);
		const server = await withServer((req, socket) => {
			if (req.method === 'echo') {
				reply(socket, req.id, big); // JSON-encoded + '\n' terminated by reply()
				return true;
			}
		});

		const client = new ElectrumClient({
			host: '127.0.0.1',
			port: server.port,
			tls: false,
			timeoutMs: 5000,
			maxBufferBytes: 1024
		});
		cleanups.push(() => client.close());

		await expect(client.request('echo', [big])).resolves.toBe(big);
	});

	// --------------------------------------------------------------- keepalive

	it('destroys a zombie connection when the keepalive ping fails, and reconnects', async () => {
		let handshakes = 0;
		const server = await withServer((req, socket) => {
			if (req.method === 'server.version') {
				handshakes++;
				return;
			}
			if (req.method === 'blockchain.headers.subscribe') {
				reply(socket, req.id, { height: handshakes, hex: 'aa'.repeat(80) });
				return true;
			}
			if (req.method === 'server.ping') {
				// The first connection's socket goes silent (TCP stays "established"
				// but the peer never answers again) -- a classic zombie/NAT-timeout
				// scenario (cairn-jhj6). Every later connection answers normally.
				if (handshakes === 1) return true; // swallow it
				reply(socket, req.id, null);
				return true;
			}
		});

		const client = new ElectrumClient({
			host: '127.0.0.1',
			port: server.port,
			tls: false,
			timeoutMs: 150,
			keepaliveIntervalMs: 100
		});
		cleanups.push(() => client.close());

		await client.headersSubscribe(); // first connect; handshakes === 1
		expect(handshakes).toBe(1);

		// The keepalive ping (100ms) goes unanswered and times out (150ms); that
		// failure must destroy the socket and drive a reconnect via the existing
		// backoff machinery, since headersSubscribed keeps reconnect eager.
		const reconnected = new Promise<void>((resolve) => client.once('connect', () => resolve()));
		await reconnected;
		expect(handshakes).toBeGreaterThanOrEqual(2);

		// And the client is fully usable again on the new connection.
		await expect(client.request('server.ping')).resolves.toBeNull();
	}, 8000);

	// ------------------------------------------------------------- connect timeout

	it('rejects instead of hanging forever when the initial direct TCP connect never completes (cairn-vn48)', async () => {
		const timeoutMs = 500;
		const fakeSocket = makeFakeConnectingSocket();
		// Simulate a dead/unreachable backend that black-holes the SYN: the
		// 'connect' callback net.connect() would normally invoke never fires, and
		// no 'error'/'close' event happens either. Without a connect-level
		// deadline this hangs ensureConnected() -- and every caller up the chain
		// (scanWallet, getWalletDetail/listWallets, the streamed page load) --
		// forever.
		const connectSpy = vi
			.spyOn(net, 'connect')
			.mockImplementation((() => fakeSocket as unknown as net.Socket) as unknown as typeof net.connect);

		vi.useFakeTimers();
		try {
			const client = new ElectrumClient({ host: '192.0.2.1', port: 50001, tls: false, timeoutMs });
			cleanups.push(() => client.close());

			const assertion = expect(client.request('server.ping')).rejects.toThrow(
				new RegExp(`Electrum connect to 192\\.0\\.2\\.1:50001 timed out after ${timeoutMs}ms`)
			);
			await vi.advanceTimersByTimeAsync(timeoutMs);
			await assertion;

			// The dead socket must be torn down, not left dangling.
			expect(fakeSocket.destroy).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
			connectSpy.mockRestore();
		}
	});

	it('clears the connect-timeout timer once the socket connects, so it cannot fire later', async () => {
		const timeoutMs = 300;
		const fakeSocket = makeFakeConnectingSocket();
		let connectCb: (() => void) | undefined;
		const connectSpy = vi.spyOn(net, 'connect').mockImplementation(((
			_opts: unknown,
			cb?: () => void
		) => {
			connectCb = cb;
			return fakeSocket as unknown as net.Socket;
		}) as unknown as typeof net.connect);
		const clearSpy = vi.spyOn(global, 'clearTimeout');

		try {
			const client = new ElectrumClient({ host: '127.0.0.1', port: 1, tls: false, timeoutMs });
			cleanups.push(() => client.close());

			// Kick off the connect; the eventual outcome of the full handshake is
			// irrelevant here (the fake socket can never complete it) -- only the
			// connect phase is under test.
			(client as unknown as { ensureConnected(): Promise<void> }).ensureConnected().catch(() => {});
			await Promise.resolve();
			expect(connectSpy).toHaveBeenCalled();
			const clearCallsBeforeConnect = clearSpy.mock.calls.length;

			// Simulate the OS-level TCP connect completing right away.
			connectCb?.();

			// onReady() must disarm the connect-timeout timer synchronously, and the
			// socket must not have been torn down by it.
			expect(clearSpy.mock.calls.length).toBeGreaterThan(clearCallsBeforeConnect);
			expect(fakeSocket.destroy).not.toHaveBeenCalled();
		} finally {
			connectSpy.mockRestore();
			clearSpy.mockRestore();
		}
	});

	it('rejects instead of hanging forever when the TLS handshake over an established SOCKS5 tunnel never completes (cairn-ocs9)', async () => {
		const timeoutMs = 500;
		// A real proxy and a real upstream so SocksClient.createConnection actually
		// completes the SOCKS CONNECT and hands back a live tunnel -- only the TLS
		// handshake negotiated over that tunnel is faked, since that's the phase
		// with no deadline before this fix.
		const upstream = await withServer(() => {});
		const proxy = await startSocks5Proxy();
		cleanups.push(() => proxy.close());

		const fakeSocket = makeFakeConnectingSocket();
		// tls.connect(options, onReady) -- simulate a stalled handshake by never
		// invoking onReady and never emitting 'error'/'close'.
		const tlsConnectSpy = vi
			.spyOn(tls, 'connect')
			.mockImplementation((() => fakeSocket as unknown as tls.TLSSocket) as unknown as typeof tls.connect);

		vi.useFakeTimers();
		try {
			const client = new ElectrumClient({
				host: '127.0.0.1',
				port: upstream.port,
				tls: true,
				timeoutMs,
				socks5Host: '127.0.0.1',
				socks5Port: proxy.port
			});
			cleanups.push(() => client.close());

			const assertion = expect(client.request('server.ping')).rejects.toThrow(
				new RegExp(`Electrum connect to 127\\.0\\.0\\.1:${upstream.port} timed out after ${timeoutMs}ms`)
			);
			// Let the real SOCKS CONNECT (async IO, real timers underneath) settle
			// before advancing the faked connect-timeout clock past it.
			await vi.waitFor(() => expect(tlsConnectSpy).toHaveBeenCalled(), { timeout: 2000 });
			await vi.advanceTimersByTimeAsync(timeoutMs);
			await assertion;

			// The stalled TLS socket must be torn down, not left dangling.
			expect(fakeSocket.destroy).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
			tlsConnectSpy.mockRestore();
		}
	}, 8000);
});

// ---- reportsHealth gating (cairn-d8aa) ----------------------------------------
//
// Every ElectrumClient used to feed chainHealth.ts's global recordChainOk/
// recordChainError unconditionally, so a pool secondary (or a one-off test/probe
// connection) could flip the instance-wide "can't reach the Bitcoin network"
// banner off a failure that had nothing to do with the operator's real backend.
// reportsHealth (default true, for backward compatibility) is the opt-out.

describe('reportsHealth (cairn-d8aa)', () => {
	function pingHandler(req: RpcRequest, socket: net.Socket): boolean | void {
		if (req.method === 'server.ping') {
			reply(socket, req.id, null);
			return true;
		}
	}

	it('defaults to true: a successful connect records chain-health OK', async () => {
		const server = await withServer(pingHandler);
		resetChainHealthForTests();

		const client = makeClient(server.port);
		await client.request('server.ping');

		expect(getChainHealth().lastOkAt).not.toBeNull();
	});

	it('reportsHealth: false suppresses a successful connect from chain health', async () => {
		const server = await withServer(pingHandler);
		resetChainHealthForTests();

		const client = new ElectrumClient({
			host: '127.0.0.1',
			port: server.port,
			tls: false,
			timeoutMs: 2000,
			reportsHealth: false
		});
		cleanups.push(() => client.close());
		await client.request('server.ping');

		expect(getChainHealth().lastOkAt).toBeNull();
	});

	it('defaults to true: a failed connect records a chain-health failure', async () => {
		resetChainHealthForTests();
		// Nothing listening on this loopback port — the dial itself fails.
		const client = makeClient(1, 300);

		await expect(client.request('server.ping')).rejects.toThrow();

		expect(getChainHealth().lastErrorAt).not.toBeNull();
	});

	it('reportsHealth: false suppresses a failed connect from chain health (the pool-secondary / test-probe case)', async () => {
		resetChainHealthForTests();
		const client = new ElectrumClient({
			host: '127.0.0.1',
			port: 1, // nothing listening — the dial fails
			tls: false,
			timeoutMs: 300,
			reportsHealth: false
		});
		cleanups.push(() => client.close());

		await expect(client.request('server.ping')).rejects.toThrow();

		expect(getChainHealth().lastErrorAt).toBeNull();
		expect(getChainHealth().healthy).toBe(true);
	});
});
