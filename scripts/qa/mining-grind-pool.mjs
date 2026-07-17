// Main-thread wrapper around a pool of grind workers (mining-grind-worker.mjs).
// Miners call grind() with the shared job fields + their own extranonce1/2; the
// pool dispatches to an idle worker and resolves with the solving nonce. Keeps
// the CPU off the main thread so the harness's event-loop-drift metric reflects
// the engine + socket IO, not the load generator.
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';

const WORKER_FILE = fileURLToPath(new URL('./mining-grind-worker.mjs', import.meta.url));

export class GrindPool {
	constructor(size = Math.min(4, Math.max(1, os.cpus().length - 1))) {
		this.workers = [];
		this.idle = [];
		this.queue = [];
		this.pending = new Map();
		this.nextId = 1;
		for (let i = 0; i < size; i++) {
			const w = new Worker(WORKER_FILE);
			w.on('message', (res) => {
				const resolve = this.pending.get(res.id);
				this.pending.delete(res.id);
				this.idle.push(w);
				this._drain();
				if (resolve) resolve(res.nonce === null ? null : res);
			});
			w.on('error', () => {});
			this.workers.push(w);
			this.idle.push(w);
		}
	}

	_drain() {
		while (this.idle.length && this.queue.length) {
			const w = this.idle.pop();
			const task = this.queue.shift();
			this.pending.set(task.id, task.resolve);
			w.postMessage(task.msg);
		}
	}

	/** Grind a share for the shared job with this miner's en1/en2. Resolves to
	 *  { en2, nonce, hashDisplay } or null. `targetHex` is the share target hex. */
	grind(job, en1, en2, targetHex, maxNonces = 200_000) {
		const id = this.nextId++;
		return new Promise((resolve) => {
			this.queue.push({ id, resolve, msg: { id, job, en1, en2, targetHex, maxNonces } });
			this._drain();
		});
	}

	async close() {
		await Promise.all(this.workers.map((w) => w.terminate()));
	}
}
