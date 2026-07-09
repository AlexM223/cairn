import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import {
	ElectrumPool,
	DEFAULT_POOL_SIZE,
	MAX_POOL_SIZE,
	DEFAULT_BACKGROUND_LANE_SIZE,
	backgroundLaneWidth
} from './pool';
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
				} else if (req.method === 'mempool.get_fee_histogram') {
					reply(socket, req.id, [[10, 5000]]);
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

	it('getFeeHistogram delegates to a pooled connection', async () => {
		const server = await startServer();
		cleanups.push(() => server.close());

		const pool = makePool(server.port, 2);
		await expect(pool.getFeeHistogram()).resolves.toEqual([[10, 5000]]);
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

// ------------------------------------------------------ lane-aware pick (HOL blocking)

/**
 * A loopback Electrum-ish server that additionally supports a `hold` method: it
 * receives the request and PARKS it (never replies) until releaseAll() is called,
 * so a test can pin a socket's in-flight (pending) count at a known value and
 * observe how the lane-aware picker steers around it.
 */
interface HeldReq {
	socket: net.Socket;
	id: number;
}
interface LaneServer {
	port: number;
	heldCount(): number;
	releaseAll(): void;
	close(): Promise<void>;
}
function startLaneServer(): Promise<LaneServer> {
	const sockets = new Set<net.Socket>();
	const held: HeldReq[] = [];
	const state = { nextId: 0 };
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
				} else if (req.method === 'hold') {
					held.push({ socket, id: req.id }); // park: no reply until releaseAll()
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
				heldCount: () => held.length,
				releaseAll() {
					for (const h of held) reply(h.socket, h.id, null);
					held.length = 0;
				},
				close: () =>
					new Promise<void>((res) => {
						for (const h of held) reply(h.socket, h.id, null);
						for (const s of sockets) s.destroy();
						server.close(() => res());
					})
			});
		});
	});
}

/** Poll until `cond` is true (or a short deadline elapses). Used to wait for the
 *  server to have PARKED N held requests, i.e. N sockets each have one in-flight
 *  request — deterministic, not a fixed sleep. */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error('until() timed out');
		await new Promise((r) => setTimeout(r, 5));
	}
}

describe('ElectrumPool lane-aware pick (HOL blocking)', () => {
	it('exposes the bumped default pool size and background-lane width', () => {
		expect(DEFAULT_POOL_SIZE).toBe(3);
		expect(MAX_POOL_SIZE).toBe(4);
		// One socket reserved for interactive → background lane is pool - 1.
		expect(backgroundLaneWidth(1)).toBe(1); // pooling disabled: reserve nothing
		expect(backgroundLaneWidth(2)).toBe(1);
		expect(backgroundLaneWidth(3)).toBe(2);
		expect(backgroundLaneWidth(4)).toBe(3);
		expect(DEFAULT_BACKGROUND_LANE_SIZE).toBe(backgroundLaneWidth(DEFAULT_POOL_SIZE));
		expect(DEFAULT_BACKGROUND_LANE_SIZE).toBe(2);
	});

	it('never lets a background request select the reserved socket, even under load', async () => {
		const server = await startServer();
		cleanups.push(() => server.close());

		const pool = makePool(server.port, 3);

		// A heavy burst of BACKGROUND requests must only ever touch pool-1 = 2
		// sockets; the reserved (3rd) socket is never even connected.
		const bgIds = await Promise.all(
			Array.from({ length: 12 }, () => pool.request('whoami', [], 'background'))
		);
		expect(new Set(bgIds).size).toBe(2);

		// INTERACTIVE requests, by contrast, may use every socket — so the reserved
		// one now comes into play and the overall set of sockets seen reaches 3.
		const allIds = new Set(bgIds);
		const interIds = await Promise.all(
			Array.from({ length: 12 }, () => pool.request('whoami', [], 'interactive'))
		);
		for (const id of interIds) allIds.add(id as number);
		expect(allIds.size).toBe(3);
	});

	it('interactive lane picks the least-pending socket (steers around a busy one)', async () => {
		const server = await startLaneServer();
		cleanups.push(() => server.close());

		const pool = makePool(server.port, 3);

		// Saturate BOTH background-eligible sockets with a parked request each, so
		// their pending count sits at 1 while the reserved socket stays idle at 0.
		const held = [
			pool.request('hold', [], 'background').catch(() => {}),
			pool.request('hold', [], 'background').catch(() => {})
		];
		await until(() => server.heldCount() === 2);

		// The reserved (3rd) socket has never been used, so it has 0 in-flight — the
		// least-pending interactive pick must land there (it connects last → id 2).
		const id = await pool.request('whoami', [], 'interactive');
		expect(id).toBe(2);

		server.releaseAll();
		await Promise.all(held);
	});
});
