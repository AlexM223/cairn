// Worker thread for scripts/qa/s2-stratum-harness.mjs.
//
// Grinds ONE fixed extranonce2 against whatever job the harness broadcasts,
// using the engine's own wire.ts byte-order/hash math (never reimplemented) so
// a "found" share is guaranteed to validate identically on the server. Runs in
// small synchronous bursts and yields between them so `message` events (new
// job / stop) are actually processed — a worker_threads message handler only
// fires between synchronous stretches of JS, same as the main thread.
//
// Spawned with execArgv inherited from the harness (see s2-stratum-harness.mjs)
// so the --experimental-transform-types + --import ts-loader flags are active
// here too and this import resolves the real .ts module.
import { parentPort, workerData } from 'node:worker_threads';
import {
	applyBranches,
	sha256d,
	buildHeader,
	headerHashDisplay,
	hashValueFromDisplay
} from '../../src/lib/server/mining/wire.ts';

const hexBuf = (h) => Buffer.from(h, 'hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BURST = 50_000;
const REPORT_MS = 1000;

let job = null; // { jobId, coinb1, coinb2, branchesHex, versionHex, prevHashDisplay, ntimeHex, nbitsHex, en1, en2, targetHex }
let generation = -1;
let stopped = false;

parentPort.on('message', (msg) => {
	if (msg.type === 'job') {
		job = msg.job;
		generation = msg.generation;
	} else if (msg.type === 'stop') {
		stopped = true;
	}
});

function merkleRootFor(j) {
	const coinbase = Buffer.concat([hexBuf(j.coinb1), hexBuf(j.en1), hexBuf(j.en2), hexBuf(j.coinb2)]);
	return applyBranches(sha256d(coinbase), j.branchesHex.map(hexBuf));
}

async function main() {
	let myGen = -1;
	let merkleRoot = null;
	let nonce = 0;
	let hashesSinceReport = 0;
	let lastReport = Date.now();

	while (!stopped) {
		if (job === null) {
			await sleep(20);
			continue;
		}
		if (myGen !== generation) {
			myGen = generation;
			merkleRoot = merkleRootFor(job);
			nonce = 0; // fresh job → fresh sweep; distinct en2 per worker keeps searches independent
		}
		const target = BigInt('0x' + job.targetHex);
		const activeJob = job;
		const genAtBurstStart = generation;
		for (let i = 0; i < BURST; i++) {
			const nonceHex = (nonce >>> 0).toString(16).padStart(8, '0');
			const header = buildHeader(
				activeJob.versionHex,
				activeJob.prevHashDisplay,
				merkleRoot,
				activeJob.ntimeHex,
				activeJob.nbitsHex,
				nonceHex
			);
			const hashDisplay = headerHashDisplay(header);
			if (hashValueFromDisplay(hashDisplay) <= target) {
				parentPort.postMessage({
					type: 'found',
					generation: myGen,
					jobId: activeJob.jobId,
					en2: activeJob.en2,
					nonce: nonceHex,
					ntimeHex: activeJob.ntimeHex,
					hashDisplay
				});
				return;
			}
			nonce = (nonce + 1) >>> 0;
			hashesSinceReport++;
		}
		if (genAtBurstStart !== generation) continue; // job rotated mid-burst — restart clean next loop
		const now = Date.now();
		if (now - lastReport >= REPORT_MS) {
			parentPort.postMessage({ type: 'progress', workerId: workerData.workerId, hashes: hashesSinceReport });
			hashesSinceReport = 0;
			lastReport = now;
		}
		await new Promise((r) => setImmediate(r)); // yield so pending 'message's get processed
	}
}

main().catch((err) => {
	parentPort.postMessage({ type: 'error', workerId: workerData.workerId, message: String(err?.stack ?? err) });
});
