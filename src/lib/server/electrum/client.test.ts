import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import { ElectrumClient } from './client';
import type { ElectrumHeader } from './client';

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
});
