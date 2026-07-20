/**
 * V1 / V2 block-byte parity (Phase 5, docs/SV2-IMPLEMENTATION-PLAN.md §h risk
 * #4 + Deliverable b of cairn-qfez8.10). Pure unit test — no bitcoind, no
 * sockets.
 *
 * The whole SV2 headline architectural result (plan §0) is that the SV2 wire
 * fields ARE `job.ts`'s existing `coinb1Hex`/`coinb2Hex`/branches, just handed
 * to the client over a different transport. This test proves that literally:
 * it takes ONLY the fields a real SV2 client would see on the wire
 * (`coinbaseTxPrefix`/`coinbaseTxSuffix`/`merklePath` for an extended channel;
 * `merkleRoot` for a standard channel — from `channels.ts`'s `jobMessagesFor`,
 * never reaching back into the `CoinbaseVariant` closure) and reassembles a
 * block independently, then asserts the result is byte-identical to what the
 * V1 path (`variant.assemble`) produces for the same template/payout/
 * extranonce. A divergence here would mean an SV2 miner and a V1 miner could
 * disagree about what block a given (job, extranonce, nonce) represents —
 * exactly the bug class this test exists to catch.
 */
import { createHash } from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { describe, expect, it } from 'vitest';
import { NETWORKS, addressToOutputScript } from '../address';
import { buildJob } from '../job';
import type { GbtTemplate, MinerAuth } from '../types';
import { applyBranches, buildHeader, headerHashDisplay, internalToDisplay, sha256d, varint } from '../wire';
import { jobMessagesFor, type Channel } from './channels';
import type { NewExtendedMiningJob, NewMiningJob } from './codec';

const REGTEST = NETWORKS.regtest;
const POOL_TAG = 'heartwood-sv2-parity';

function addr(label: string): string {
	const h20 = createHash('sha256').update(label).digest().subarray(0, 20);
	return bitcoin.address.toBech32(h20, 0, REGTEST.bech32);
}

function makeAuth(label: string): MinerAuth {
	const address = addr(label);
	return {
		userId: 1,
		miningId: `mid-${label}`,
		walletId: 900,
		address,
		payoutScript: addressToOutputScript(address, REGTEST)
	};
}

function hex8(n: number): string {
	return (n >>> 0).toString(16).padStart(8, '0');
}

const WITNESS_COMMITMENT_HEX = '6a24aa21a9ed' + '11'.repeat(32); // realistic 38-byte commitment scriptPubKey

function makeTemplate(): GbtTemplate {
	return {
		version: 0x20000000,
		previousblockhash: createHash('sha256').update('parity-tip').digest('hex'),
		height: 800_000,
		curtime: 1_753_000_000,
		bits: '1d00ffff',
		coinbasevalue: 625_000_000,
		transactions: [
			{ txid: 'a'.repeat(64), hash: 'a'.repeat(64), data: 'deadbeef' },
			{ txid: 'b'.repeat(64), hash: 'b'.repeat(64), data: 'cafebabe' }
		],
		default_witness_commitment: WITNESS_COMMITMENT_HEX
	};
}

/** Minimal `Channel` for `jobMessagesFor` — no registry, full control over the
 *  extranonce split so it can be pinned to match the V1-side en1/en2 chosen below. */
function makeFakeChannel(auth: MinerAuth, kind: Channel['kind'], extranoncePrefixHex: string, extranonceSize: number): Channel {
	let counter = 1;
	return {
		id: 1,
		kind,
		auth,
		userIdentity: 'parity-miner',
		extranoncePrefixHex,
		extranonceSize,
		target: (1n << 256n) - 1n,
		versionRollingAllowed: false,
		jobs: new Map(),
		seenShares: new Map(),
		nextSv2JobId: () => counter++
	};
}

/** Re-attach the SegWit witness commitment exactly as job.ts's `assemble` does
 *  (bitcoin.Transaction.fromHex → setWitness(0, [32 zero bytes]) → toBuffer),
 *  starting from the SAME legacy (witness-stripped) coinbase bytes both paths
 *  produce. This is the one non-`wire.ts` step both `assemble` and this test
 *  share — reimplemented here (not imported from job.ts) so the SV2-side
 *  reconstruction never reaches into job.ts internals. */
function attachWitnessCommitment(legacyCoinbase: Buffer, hasCommitment: boolean): Buffer {
	if (!hasCommitment) return legacyCoinbase;
	const cb = bitcoin.Transaction.fromHex(legacyCoinbase.toString('hex'));
	cb.setWitness(0, [Buffer.alloc(32)]);
	return cb.toBuffer();
}

describe('SV2/V1 block-byte parity', () => {
	it('extended channel: coinbaseTxPrefix/Suffix/merklePath alone reassemble a byte-identical block to variant.assemble()', () => {
		const template = makeTemplate();
		const auth = makeAuth('extended-parity');
		const built = buildJob(template, { network: REGTEST, poolTag: POOL_TAG, jobId: 'parity-ext-1', cleanJobs: true });
		const variant = built.personalize({ payoutScript: auth.payoutScript });

		const en1Hex = '11223344';
		const en2Hex = 'aabbccdd';
		const ntimeHex = built.job.ntimeHex;
		const nonceHex = '00000001';

		// --- V1 path: the exact closure StratumServer/handleSolve call. ---
		const v1 = variant.assemble(en1Hex, en2Hex, ntimeHex, nonceHex);

		// --- SV2 path: reconstruct using ONLY what an extended-channel client
		//     receives over the wire (NewExtendedMiningJob), never `variant`. ---
		const ch = makeFakeChannel(auth, 'extended', en1Hex, 4);
		const jm = jobMessagesFor(ch, built);
		expect(jm.newJob.kind).toBe('extended');
		const msg = (jm.newJob as { kind: 'extended'; msg: NewExtendedMiningJob }).msg;

		// Sanity: the wire fields ARE coinb1Hex/coinb2Hex (plan §0's headline claim).
		expect(Buffer.from(msg.coinbaseTxPrefix).toString('hex')).toBe(variant.coinb1Hex);
		expect(Buffer.from(msg.coinbaseTxSuffix).toString('hex')).toBe(variant.coinb2Hex);

		const fullExtranonce = Buffer.from(en1Hex + en2Hex, 'hex'); // ch.extranoncePrefixHex ‖ client extranonce
		const coinbaseBytes = Buffer.concat([Buffer.from(msg.coinbaseTxPrefix), fullExtranonce, Buffer.from(msg.coinbaseTxSuffix)]);
		const merkleRoot = applyBranches(
			sha256d(coinbaseBytes),
			msg.merklePath.map((b) => Buffer.from(b))
		);
		const header = buildHeader(hex8(msg.version), built.job.prevHashDisplay, merkleRoot, ntimeHex, built.job.nbitsHex, nonceHex);
		const coinbaseSerialized = attachWitnessCommitment(coinbaseBytes, Boolean(template.default_witness_commitment));
		const txData = template.transactions.map((t) => Buffer.from(t.data, 'hex'));
		const sv2Block = Buffer.concat([header, varint(1 + txData.length), coinbaseSerialized, ...txData]);

		expect(sv2Block.toString('hex')).toBe(v1.blockHex);
		expect(headerHashDisplay(header)).toBe(v1.blockHashDisplay);
		expect(internalToDisplay(sha256d(coinbaseBytes))).toBe(v1.coinbaseTxidDisplay);
	});

	it('extended channel: a non-default (min_extranonce_size) split still reassembles byte-identical bytes', () => {
		// Plan §b.1: server prefix 8-m, client size m. Use m=2 (server keeps 6 bytes).
		const template = makeTemplate();
		const auth = makeAuth('extended-split-parity');
		const built = buildJob(template, { network: REGTEST, poolTag: POOL_TAG, jobId: 'parity-ext-2', cleanJobs: true });
		const variant = built.personalize({ payoutScript: auth.payoutScript });

		const serverPrefixHex = '0102030405ff'; // 6 bytes
		const clientExtranonceHex = '99aa'; // 2 bytes
		const en1Hex = serverPrefixHex.slice(0, 8); // first 4 bytes of the full 8-byte zone
		const en2Hex = serverPrefixHex.slice(8) + clientExtranonceHex; // remaining bytes
		const ntimeHex = built.job.ntimeHex;
		const nonceHex = '00000002';

		const v1 = variant.assemble(en1Hex, en2Hex, ntimeHex, nonceHex);

		const ch = makeFakeChannel(auth, 'extended', serverPrefixHex, 2);
		const jm = jobMessagesFor(ch, built);
		const msg = (jm.newJob as { kind: 'extended'; msg: NewExtendedMiningJob }).msg;

		const fullExtranonce = Buffer.from(serverPrefixHex + clientExtranonceHex, 'hex');
		expect(fullExtranonce).toHaveLength(8);
		const coinbaseBytes = Buffer.concat([Buffer.from(msg.coinbaseTxPrefix), fullExtranonce, Buffer.from(msg.coinbaseTxSuffix)]);
		const merkleRoot = applyBranches(
			sha256d(coinbaseBytes),
			msg.merklePath.map((b) => Buffer.from(b))
		);
		const header = buildHeader(hex8(msg.version), built.job.prevHashDisplay, merkleRoot, ntimeHex, built.job.nbitsHex, nonceHex);
		const coinbaseSerialized = attachWitnessCommitment(coinbaseBytes, Boolean(template.default_witness_commitment));
		const txData = template.transactions.map((t) => Buffer.from(t.data, 'hex'));
		const sv2Block = Buffer.concat([header, varint(1 + txData.length), coinbaseSerialized, ...txData]);

		expect(sv2Block.toString('hex')).toBe(v1.blockHex);
		expect(headerHashDisplay(header)).toBe(v1.blockHashDisplay);
	});

	it('standard channel: server-computed merkle_root matches the V1 merkle root for the equivalent full-8-byte extranonce', () => {
		// Standard channels never see coinb1/coinb2 (the server owns the whole
		// 8-byte zone and folds the merkle root itself) — a real SV2 standard
		// client cannot reassemble the FULL block client-side by design (only the
		// server does, at solve time, from its own frozen `variant`). Parity here
		// is therefore header/hash parity against the V1 path using the
		// server-owned prefix as en1‖en2, not full-block-byte parity.
		const template = makeTemplate();
		const auth = makeAuth('standard-parity');
		const built = buildJob(template, { network: REGTEST, poolTag: POOL_TAG, jobId: 'parity-std-1', cleanJobs: true });
		const variant = built.personalize({ payoutScript: auth.payoutScript });

		const fullPrefixHex = 'deadbeefcafef00d'; // full 8-byte server-owned zone
		const en1Hex = fullPrefixHex.slice(0, 8);
		const en2Hex = fullPrefixHex.slice(8);
		const ntimeHex = built.job.ntimeHex;
		const nonceHex = '00000003';

		const v1 = variant.assemble(en1Hex, en2Hex, ntimeHex, nonceHex);

		const ch = makeFakeChannel(auth, 'standard', fullPrefixHex, 0);
		const jm = jobMessagesFor(ch, built);
		expect(jm.newJob.kind).toBe('standard');
		const msg = (jm.newJob as { kind: 'standard'; msg: NewMiningJob }).msg;

		const header = buildHeader(hex8(msg.version), built.job.prevHashDisplay, Buffer.from(msg.merkleRoot), ntimeHex, built.job.nbitsHex, nonceHex);

		expect(headerHashDisplay(header)).toBe(v1.blockHashDisplay);
	});
});
