import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { ElectrumPool } from './pool';
import type { ElectrumHeader } from './client';

interface RpcRequest {
	id: number;
	method: string;
	params: unknown[];
}

interface FakeServer {
	port: number;
	/** The socket that issued blockchain.headers.subscribe (the pool's primary). */
	subscriber: net.Socket | null;
	close(): Promise<void>;
}

function reply(socket: net.Socket, id: number, result: unknown): void {
	socket.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function notify(socket: net.Socket, method: string, params: unknown[]): void {
	socket.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

/**
 * A loopback Electrum-ish server. Assigns each accepted socket a stable numeric
 * id and answers a custom `whoami` method with it, so a test can see which
 * connection served each request.
 */
function startServer(): Promise<FakeServer> {
	const sockets = new Set<net.Socket>();
	const state: { subscriber: net.Socket | null; nextId: number } = {
		subscriber: null,
		nextId: 0
	};
	const server = net.createServer((socket) => {
		const socketId = state.nextId++;
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
				if (req.method === 'server.version') {
					reply(socket, req.id, ['FakeElectrumX 1.0', '1.4']);
				} else if (req.method === 'whoami') {
					reply(socket, req.id, socketId);
				} else if (req.method === 'blockchain.headers.subscribe') {
					state.subscriber = socket;
					reply(socket, req.id, { height: 900000, hex: 'aa'.repeat(80) });
				} else {
					reply(socket, req.id, null);
				}
			}
		});
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as net.AddressInfo).port;
			resolve({
				port,
				get subscriber() {
					return state.subscriber;
				},
				close: () =>
					new Promise<void>((res) => {
						for (const s of sockets) s.destroy();
						server.close(() => res());
					})
			});
		});
	});
}

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
});

function makePool(port: number, size: number): ElectrumPool {
	const pool = new ElectrumPool({ host: '127.0.0.1', port, tls: false, timeoutMs: 2000 }, size);
	cleanups.push(() => pool.close());
	return pool;
}

describe('ElectrumPool (cairn-ynfp)', () => {
	it('round-robins stateless requests across the pooled connections', async () => {
		const server = await startServer();
		cleanups.push(() => server.close());

		const pool = makePool(server.port, 2);
		// Four requests over a size-2 pool should touch exactly two distinct sockets.
		const ids = await Promise.all([
			pool.request('whoami'),
			pool.request('whoami'),
			pool.request('whoami'),
			pool.request('whoami')
		]);
		expect(new Set(ids).size).toBe(2);
	});

	it('uses a single connection when sized to 1 (pooling disabled)', async () => {
		const server = await startServer();
		cleanups.push(() => server.close());

		const pool = makePool(server.port, 1);
		const ids = await Promise.all([pool.request('whoami'), pool.request('whoami')]);
		expect(new Set(ids).size).toBe(1);
	});

	it('keeps subscriptions on the primary and forwards its notifications', async () => {
		const server = await startServer();
		cleanups.push(() => server.close());

		const pool = makePool(server.port, 3);

		const tip = await pool.headersSubscribe();
		expect(tip).toEqual({ height: 900000, hex: 'aa'.repeat(80) });
		expect(server.subscriber).not.toBeNull();

		// A later server-pushed header on the primary socket surfaces as a pool event.
		const next = new Promise<ElectrumHeader>((resolve) => pool.once('header', resolve));
		notify(server.subscriber!, 'blockchain.headers.subscribe', [
			{ height: 900001, hex: 'bb'.repeat(80) }
		]);
		await expect(next).resolves.toEqual({ height: 900001, hex: 'bb'.repeat(80) });
	});

	it('rejects requests after close()', async () => {
		const server = await startServer();
		cleanups.push(() => server.close());

		const pool = makePool(server.port, 2);
		await pool.request('whoami'); // warm up
		pool.close();
		await expect(pool.request('whoami')).rejects.toThrow(/closed/i);
	});

	it('clamps the pool size to the 1–4 range', async () => {
		const server = await startServer();
		cleanups.push(() => server.close());

		// Ask for 9; expect it capped at 4 distinct sockets under enough load.
		const pool = makePool(server.port, 9);
		const ids = await Promise.all(Array.from({ length: 8 }, () => pool.request('whoami')));
		expect(new Set(ids).size).toBe(4);
	});
});
