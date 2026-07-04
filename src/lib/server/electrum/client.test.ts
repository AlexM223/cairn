import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
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

/**
 * Loopback newline-delimited JSON-RPC server. `onRequest` decides how (and
 * whether) to answer each request; the server.version handshake is answered
 * automatically unless the handler returns true (meaning "handled").
 */
function startServer(
	onRequest: (req: RpcRequest, socket: net.Socket) => boolean | void
): Promise<FakeServer> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => {});
		let buffer = '';
		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8');
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
	});
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

	it('times out a request the server never answers, near the configured timeoutMs', async () => {
		const server = await withServer((req) => {
			if (req.method === 'never.answers') return true; // swallow it
		});

		const client = makeClient(server.port, 200);
		const started = Date.now();
		await expect(client.request('never.answers')).rejects.toThrow(/timed out after 200ms/);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(150);
		expect(elapsed).toBeLessThan(1500);
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
});
