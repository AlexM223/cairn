// Synthetic Stratum V1 miner for the mining QA harnesses.
//
// Speaks the wire a real cpuminer/Bitaxe speaks: subscribe -> authorize ->
// receive mining.notify -> reconstruct the coinbase from (coinb1 || en1 || en2
// || coinb2), fold it through the notified merkle branches, build the 80-byte
// header, double-SHA256 it, and submit any (en2, nonce) whose hash clears the
// announced difficulty. It reconstructs everything from the notify params ALONE
// (never from the server's job builder), so grinding a real solving share proves
// the engine's mining.notify wire is correct end to end.
//
// All byte-order / hashing goes through the engine's own wire.ts — the same
// module the server validates with — so the two sides cannot silently disagree.
import * as net from 'node:net';
import {
	sha256d,
	applyBranches,
	buildHeader,
	headerHashDisplay,
	hashValueFromDisplay,
	fromStratumPrevHash,
	difficultyToTarget
} from '../../src/lib/server/mining/wire.ts';

const hexBuf = (h) => Buffer.from(h, 'hex');

/** A parsed mining.notify, plus the derived difficulty target for grinding. */
function parseNotify(params, difficulty) {
	const [jobId, prevHashStratum, coinb1, coinb2, branches, versionHex, nbitsHex, ntimeHex, cleanJobs] = params;
	return {
		jobId,
		prevHashDisplay: fromStratumPrevHash(prevHashStratum),
		coinb1,
		coinb2,
		branches: branches.map(hexBuf),
		branchesHex: branches,
		versionHex,
		nbitsHex,
		ntimeHex,
		cleanJobs,
		target: difficultyToTarget(difficulty)
	};
}

export class SyntheticMiner {
	/**
	 * @param {number} port
	 * @param {object} opts { host, en2Prefix }
	 */
	constructor(port, opts = {}) {
		this.port = port;
		this.host = opts.host ?? '127.0.0.1';
		this.sock = null;
		this.en1 = null;
		this.difficulty = 1;
		this.job = null; // latest parsed notify
		this._buf = '';
		this._nextId = 1;
		this._pending = new Map();
		this._notifyWaiters = [];
		this._closed = false;
		this.acceptedShares = 0;
		this.rejectedShares = 0;
	}

	connect() {
		return new Promise((resolve, reject) => {
			this.sock = net.connect(this.port, this.host);
			this.sock.setNoDelay(true);
			this.sock.once('connect', () => resolve());
			this.sock.once('error', reject);
			this.sock.on('data', (chunk) => this._onData(chunk));
			this.sock.on('close', () => {
				this._closed = true;
			});
			this.sock.on('error', () => {});
		});
	}

	_onData(chunk) {
		this._buf += chunk.toString('utf8');
		let idx;
		while ((idx = this._buf.indexOf('\n')) >= 0) {
			const line = this._buf.slice(0, idx).trim();
			this._buf = this._buf.slice(idx + 1);
			if (line.length === 0) continue;
			let m;
			try {
				m = JSON.parse(line);
			} catch {
				continue;
			}
			if (m.method === 'mining.notify') {
				this.job = parseNotify(m.params, this.difficulty);
				const w = this._notifyWaiters.shift();
				if (w) w(this.job);
			} else if (m.method === 'mining.set_difficulty') {
				this.difficulty = Number(m.params[0]);
				if (this.job) this.job.target = difficultyToTarget(this.difficulty);
			} else if (typeof m.id === 'number' && this._pending.has(m.id)) {
				this._pending.get(m.id)({ result: m.result, error: m.error });
				this._pending.delete(m.id);
			}
		}
	}

	_req(method, params) {
		return new Promise((resolve, reject) => {
			if (!this.sock || this._closed || !this.sock.writable) {
				reject(new Error('socket not writable'));
				return;
			}
			const id = this._nextId++;
			this._pending.set(id, resolve);
			this.sock.write(JSON.stringify({ id, method, params }) + '\n');
		});
	}

	/** Shared job fields a GrindPool worker needs (all hex). */
	jobForPool() {
		const j = this.job;
		return {
			coinb1: j.coinb1,
			coinb2: j.coinb2,
			branches: j.branchesHex,
			versionHex: j.versionHex,
			prevHashDisplay: j.prevHashDisplay,
			nbitsHex: j.nbitsHex,
			ntimeHex: j.ntimeHex
		};
	}

	/** Current share target as hex (for the GrindPool). */
	targetHex() {
		return this.job.target.toString(16);
	}

	/** Send a raw line (for protocol-fuzz / edge-case tests). */
	writeRaw(line) {
		if (this.sock && !this._closed && this.sock.writable) this.sock.write(line);
	}

	nextNotify() {
		if (this.job) return Promise.resolve(this.job);
		return new Promise((resolve) => this._notifyWaiters.push(resolve));
	}

	async subscribe() {
		const r = await this._req('mining.subscribe', ['heartwood-qa/1']);
		this.en1 = r.result[1];
		return this.en1;
	}

	async authorize(miningId, worker = 'w1') {
		const token = worker ? `${miningId}.${worker}` : miningId;
		const r = await this._req('mining.authorize', [token, 'x']);
		return r.result === true;
	}

	/** Full handshake; resolves once the first job has been received. */
	async handshake(miningId, worker = 'w1') {
		await this.subscribe();
		const ok = await this.authorize(miningId, worker);
		if (!ok) throw new Error(`authorize rejected for ${miningId}`);
		await this.nextNotify();
		return this;
	}

	/** Precompute the merkle root for (job, en2) once — the per-nonce inner loop
	 *  then only rebuilds the 80-byte header + one double-SHA256. */
	_prepare(job, en2) {
		const coinbase = Buffer.concat([hexBuf(job.coinb1), hexBuf(this.en1), hexBuf(en2), hexBuf(job.coinb2)]);
		return applyBranches(sha256d(coinbase), job.branches);
	}

	/**
	 * Grind against the current job for a (en2, nonce) whose header hash clears
	 * `target ?? this.job.target`. SYNCHRONOUS — keep `maxNonces` modest (a few
	 * tens of k) so a single call never blocks the event loop for long. Returns
	 * { en2, nonce, hashDisplay, jobId } or null if exhausted without a hit.
	 */
	grind(en2, opts = {}) {
		const job = this.job;
		if (!job) throw new Error('no job to grind');
		const target = opts.target ?? job.target;
		const maxNonces = opts.maxNonces ?? 4_000_000;
		const startNonce = opts.startNonce ?? 0;
		const merkleRoot = this._prepare(job, en2);
		for (let n = startNonce; n < startNonce + maxNonces; n++) {
			const nonceHex = (n >>> 0).toString(16).padStart(8, '0');
			const header = buildHeader(job.versionHex, job.prevHashDisplay, merkleRoot, job.ntimeHex, job.nbitsHex, nonceHex);
			const hashDisplay = headerHashDisplay(header);
			if (hashValueFromDisplay(hashDisplay) <= target) {
				return { en2, nonce: nonceHex, hashDisplay, jobId: job.jobId };
			}
		}
		return null;
	}

	/**
	 * Event-loop-friendly grind: scans in `batch`-sized chunks, yielding to the
	 * loop (setImmediate) between chunks so the engine and peer miners keep
	 * running and the drift monitor stays honest. Returns the same shape as
	 * grind(), or null when `maxNonces` is exhausted.
	 */
	async grindAsync(en2, opts = {}) {
		const job = this.job;
		if (!job) throw new Error('no job to grind');
		const target = opts.target ?? job.target;
		const maxNonces = opts.maxNonces ?? 60_000;
		const batch = opts.batch ?? 512;
		const merkleRoot = this._prepare(job, en2);
		for (let base = 0; base < maxNonces; base += batch) {
			const end = Math.min(base + batch, maxNonces);
			for (let n = base; n < end; n++) {
				const nonceHex = (n >>> 0).toString(16).padStart(8, '0');
				const header = buildHeader(job.versionHex, job.prevHashDisplay, merkleRoot, job.ntimeHex, job.nbitsHex, nonceHex);
				const hashDisplay = headerHashDisplay(header);
				if (hashValueFromDisplay(hashDisplay) <= target) {
					return { en2, nonce: nonceHex, hashDisplay, jobId: job.jobId };
				}
			}
			// Yield through the TIMERS phase (not setImmediate): a fleet of
			// setImmediate-yielding grinders starves setInterval timers, which would
			// corrupt the harness's own event-loop-drift measurement. setTimeout(0)
			// shares the timers phase fairly with the drift monitor.
			await new Promise((r) => setTimeout(r, 0));
		}
		return null;
	}

	/** Submit a share; resolves true if accepted. */
	async submit(jobId, en2, nonce) {
		const r = await this._req('mining.submit', [`_miner`, jobId, en2, this.job.ntimeHex, nonce]);
		if (r.result === true) this.acceptedShares++;
		else this.rejectedShares++;
		return r.result === true;
	}

	/** Submit a raw share with caller-chosen ntime (edge/low-diff tests). */
	async submitRaw(jobId, en2, ntime, nonce) {
		const r = await this._req('mining.submit', [`_miner`, jobId, en2, ntime, nonce]);
		if (r.result === true) this.acceptedShares++;
		else this.rejectedShares++;
		return r;
	}

	/** Grind one valid share for the current job and submit it. */
	async mineOneShare(en2) {
		const found = this.grind(en2);
		if (!found) return false;
		return this.submit(found.jobId, found.en2, found.nonce);
	}

	destroy() {
		this._closed = true;
		if (this.sock) this.sock.destroy();
	}
}
