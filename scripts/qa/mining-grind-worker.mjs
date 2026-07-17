// Off-main-thread share grinder for the load harness.
//
// Runs in a worker_thread so the CPU cost of producing valid shares does NOT sit
// on the same thread as the engine under test — which is what makes the load
// test's event-loop-drift measurement meaningful (real miners are external
// hashers, not in-process). Pure node:crypto, matching src/lib/server/mining/
// wire.ts's byte-order conventions EXACTLY; any divergence is self-caught,
// because a mis-hashed share is rejected by the real engine (which uses wire.ts)
// and the harness's accepted-count assertion then fails loudly.
import { parentPort } from 'node:worker_threads';
import { createHash } from 'node:crypto';

const sha256 = (b) => createHash('sha256').update(b).digest();
const sha256d = (b) => sha256(sha256(b));
const rev = (b) => Buffer.from(b).reverse();
const le4 = (hex) => rev(Buffer.from(hex, 'hex'));
const hexBuf = (h) => Buffer.from(h, 'hex');

function merkleRootFor(coinb1, en1, en2, coinb2, branches) {
	const coinbase = Buffer.concat([hexBuf(coinb1), hexBuf(en1), hexBuf(en2), hexBuf(coinb2)]);
	let root = sha256d(coinbase);
	for (const b of branches) root = sha256d(Buffer.concat([root, hexBuf(b)]));
	return root;
}

parentPort.on('message', (msg) => {
	const { id, job, en1, en2, targetHex, maxNonces } = msg;
	const target = BigInt('0x' + targetHex);
	const prevInternal = rev(Buffer.from(job.prevHashDisplay, 'hex'));
	const merkleRoot = merkleRootFor(job.coinb1, en1, en2, job.coinb2, job.branches);
	const versionLE = le4(job.versionHex);
	const ntimeLE = le4(job.ntimeHex);
	const nbitsLE = le4(job.nbitsHex);
	const header = Buffer.concat([versionLE, prevInternal, merkleRoot, ntimeLE, nbitsLE, Buffer.alloc(4)]);
	for (let n = 0; n < maxNonces; n++) {
		header.writeUInt32LE(n >>> 0, 76);
		const hashDisplay = rev(sha256d(header)).toString('hex');
		if (BigInt('0x' + hashDisplay) <= target) {
			parentPort.postMessage({ id, en2, nonce: (n >>> 0).toString(16).padStart(8, '0'), hashDisplay });
			return;
		}
	}
	parentPort.postMessage({ id, en2, nonce: null });
});
