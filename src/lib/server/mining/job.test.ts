/**
 * job.ts contract tests: deterministic in-memory GbtTemplate fixtures, no real
 * node. The merkle root is verified against an INDEPENDENT sha256d pairing
 * implementation (node:crypto, not wire.merkleBranches). The solo invariant —
 * exactly one value-bearing output paying the full reward — is asserted directly.
 */
import { createHash } from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { describe, expect, it } from 'vitest';
import { NETWORKS, addressToOutputScript } from './address';
import { buildJob, EXTRANONCE1_SIZE, EXTRANONCE2_SIZE } from './job';
import type { CoinbaseVariant, GbtTemplate } from './types';
import { displayToInternal, fromStratumPrevHash, hashValueFromDisplay } from './wire';

const net = NETWORKS.regtest;
const POOL_TAG = 'heartwood-solo';

// --- Independent primitives (node:crypto only — no wire.ts merkle code) ------

function sha256dDirect(buf: Buffer): Buffer {
	const a = createHash('sha256').update(buf).digest();
	return createHash('sha256').update(a).digest();
}

function merkleRootDirect(leavesLE: readonly Buffer[]): Buffer {
	if (leavesLE.length === 0) throw new Error('no leaves');
	let level: Buffer[] = leavesLE.map((b) => Buffer.from(b));
	while (level.length > 1) {
		if (level.length % 2 === 1) level.push(level[level.length - 1]!);
		const next: Buffer[] = [];
		for (let i = 0; i < level.length; i += 2) {
			next.push(sha256dDirect(Buffer.concat([level[i]!, level[i + 1]!])));
		}
		level = next;
	}
	return level[0]!;
}

// --- Deterministic fixtures --------------------------------------------------

/** Deterministic regtest p2wpkh address from a label (no keys needed). */
function addr(label: string): string {
	const h20 = createHash('sha256').update(label).digest().subarray(0, 20);
	return bitcoin.address.toBech32(h20, 0, net.bech32);
}

function payout(label: string): Uint8Array {
	return addressToOutputScript(addr(label), net);
}

function fixtureTx(seed: string): { data: string; txid: string; hash: string } {
	const tx = new bitcoin.Transaction();
	tx.version = 2;
	tx.addInput(createHash('sha256').update(`prevout-${seed}`).digest(), 0, 0xffffffff, Buffer.from('51', 'hex'));
	tx.addOutput(Buffer.from(addressToOutputScript(addr(`out-${seed}`), net)), 50_000);
	return { data: tx.toHex(), txid: tx.getId(), hash: tx.getId() };
}

function witnessCommitmentScript(wtxidsDisplay: readonly string[]): string {
	const leaves = [Buffer.alloc(32), ...wtxidsDisplay.map((h) => Buffer.from(h, 'hex').reverse())];
	const witnessRoot = merkleRootDirect(leaves);
	const commitment = sha256dDirect(Buffer.concat([witnessRoot, Buffer.alloc(32)]));
	return '6a24aa21a9ed' + commitment.toString('hex');
}

const PREV_HASH = createHash('sha256').update('prev-block').digest('hex');
const TX_A = fixtureTx('a');
const TX_B = fixtureTx('b');

const TEMPLATE_0TX: GbtTemplate = {
	version: 0x20000000,
	previousblockhash: PREV_HASH,
	height: 102,
	curtime: 1_750_000_000,
	bits: '207fffff',
	coinbasevalue: 5_000_000_000,
	transactions: []
};

const TEMPLATE_2TX: GbtTemplate = {
	version: 0x20000000,
	previousblockhash: PREV_HASH,
	height: 103,
	curtime: 1_750_000_123,
	bits: '207fffff',
	coinbasevalue: 5_000_012_345,
	transactions: [TX_A, TX_B],
	default_witness_commitment: witnessCommitmentScript([TX_A.hash, TX_B.hash])
};

const MINER = payout('miner-solo');

function cfg(jobId: string, poolTag = POOL_TAG) {
	return { network: net, poolTag, jobId, cleanJobs: true };
}

const EN1 = 'aabbccdd';
const EN2 = '11223344';
const NTIME0 = (TEMPLATE_0TX.curtime >>> 0).toString(16).padStart(8, '0');
const NTIME2 = (TEMPLATE_2TX.curtime >>> 0).toString(16).padStart(8, '0');
const NONCE = '0000002a';

function reassembledCoinbaseHex(v: CoinbaseVariant, en1: string, en2: string): string {
	return v.coinb1Hex + en1 + en2 + v.coinb2Hex;
}

/**
 * Direct coinbase serialization with the extranonces substituted — built from
 * bitcoinjs primitives + setInputScript, NOT by slicing at offsets. If buildJob's
 * computed split offsets are wrong by even one byte, this cannot match.
 */
function directCoinbaseHex(template: GbtTemplate, payoutScript: Uint8Array, en1: string, en2: string): string {
	const tx = new bitcoin.Transaction();
	tx.version = 2;
	tx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff, Buffer.alloc(0));
	tx.addOutput(Buffer.from(payoutScript), template.coinbasevalue);
	if (template.default_witness_commitment) {
		tx.addOutput(Buffer.from(template.default_witness_commitment, 'hex'), 0);
	}
	const heightPush = bitcoin.script.compile([bitcoin.script.number.encode(template.height)]);
	tx.setInputScript(0, Buffer.concat([heightPush, Buffer.from(POOL_TAG, 'ascii'), Buffer.from(en1 + en2, 'hex')]));
	return tx.toHex();
}

function variantFor(template: GbtTemplate, jobId: string, p: Uint8Array = MINER): CoinbaseVariant {
	return buildJob(template, cfg(jobId)).personalize({ payoutScript: p });
}

// --- Merkle root -------------------------------------------------------------

describe('buildJob merkle root', () => {
	it('0-tx template: no branches, root == coinbase txid (LE)', () => {
		const built = buildJob(TEMPLATE_0TX, cfg('j0'));
		expect(built.job.merkleBranchesInternalHex).toHaveLength(0);
		const v = built.personalize({ payoutScript: MINER });
		const header = v.headerFor(EN1, EN2, NTIME0, NONCE);
		const coinbase = Buffer.from(reassembledCoinbaseHex(v, EN1, EN2), 'hex');
		const txidLE = sha256dDirect(coinbase);
		expect(header.subarray(36, 68).equals(txidLE)).toBe(true);
		expect(header.subarray(36, 68).equals(merkleRootDirect([txidLE]))).toBe(true);
	});

	it('2-tx template: header root matches a directly-computed sha256d-pairing root', () => {
		const built = buildJob(TEMPLATE_2TX, cfg('j1'));
		expect(built.job.merkleBranchesInternalHex).toHaveLength(2);
		const v = built.personalize({ payoutScript: MINER });
		const header = v.headerFor(EN1, EN2, NTIME2, NONCE);
		const coinbase = Buffer.from(reassembledCoinbaseHex(v, EN1, EN2), 'hex');
		const leaves = [
			sha256dDirect(coinbase),
			Buffer.from(TX_A.txid, 'hex').reverse(),
			Buffer.from(TX_B.txid, 'hex').reverse()
		];
		expect(header.subarray(36, 68).equals(merkleRootDirect(leaves))).toBe(true);
		expect(built.job.merkleBranchesInternalHex[0]).toBe(
			Buffer.from(TX_A.txid, 'hex').reverse().toString('hex')
		);
	});
});

// --- coinb1/coinb2 split, reassembly, and per-miner personalization ----------

describe('coinbase split and reassembly', () => {
	it('coinb1+EN1+EN2+coinb2 equals a direct serialization with extranonces substituted (2-tx)', () => {
		const v = variantFor(TEMPLATE_2TX, 'j3');
		expect(reassembledCoinbaseHex(v, EN1, EN2)).toBe(directCoinbaseHex(TEMPLATE_2TX, MINER, EN1, EN2));
	});

	it('matches the direct serialization for the 0-tx template too', () => {
		const v = variantFor(TEMPLATE_0TX, 'j4');
		expect(reassembledCoinbaseHex(v, EN1, EN2)).toBe(directCoinbaseHex(TEMPLATE_0TX, MINER, EN1, EN2));
		expect(reassembledCoinbaseHex(v, '00000000', '00000000')).toBe(
			directCoinbaseHex(TEMPLATE_0TX, MINER, '00000000', '00000000')
		);
	});

	it('puts the extranonces at the very end of the scriptSig, after BIP34 height + tag', () => {
		const v = variantFor(TEMPLATE_2TX, 'j5');
		const parsed = bitcoin.Transaction.fromHex(reassembledCoinbaseHex(v, EN1, EN2));
		const scriptSig = parsed.ins[0]!.script;
		expect(scriptSig.subarray(-(EXTRANONCE1_SIZE + EXTRANONCE2_SIZE)).toString('hex')).toBe(EN1 + EN2);
		const heightPush = bitcoin.script.compile([bitcoin.script.number.encode(TEMPLATE_2TX.height)]);
		expect(scriptSig.subarray(0, heightPush.length).equals(heightPush)).toBe(true);
		expect(scriptSig.subarray(heightPush.length, heightPush.length + POOL_TAG.length).toString('ascii')).toBe(
			POOL_TAG
		);
	});

	it('trims an oversized pool tag so scriptSig stays ≤ 100 bytes', () => {
		const v = buildJob({ ...TEMPLATE_0TX, height: 840_000 }, cfg('j6', 'x'.repeat(200))).personalize({
			payoutScript: MINER
		});
		const parsed = bitcoin.Transaction.fromHex(reassembledCoinbaseHex(v, EN1, EN2));
		const scriptSig = parsed.ins[0]!.script;
		expect(scriptSig.length).toBeLessThanOrEqual(100);
		expect(scriptSig.subarray(-8).toString('hex')).toBe(EN1 + EN2);
	});

	it('rejects extranonces of the wrong length', () => {
		const v = variantFor(TEMPLATE_0TX, 'j7');
		expect(() => v.headerFor('aabb', EN2, NTIME0, NONCE)).toThrow(/extranonce1/);
		expect(() => v.headerFor(EN1, 'aabbccddee', NTIME0, NONCE)).toThrow(/extranonce2/);
		expect(() => v.headerFor(EN1, 'zzzzzzzz', NTIME0, NONCE)).toThrow(/extranonce2/);
	});

	it('different miners get different personalized coinbases on the SAME jobId', () => {
		const built = buildJob(TEMPLATE_2TX, cfg('shared'));
		const a = built.personalize({ payoutScript: payout('miner-a') });
		const b = built.personalize({ payoutScript: payout('miner-b') });
		// coinb1 (input side) is identical; coinb2 (outputs) carries the payout, so it differs.
		expect(a.coinb1Hex).toBe(b.coinb1Hex);
		expect(a.coinb2Hex).not.toBe(b.coinb2Hex);
		// and the block hashes differ for the same (en, ntime, nonce)
		const ha = a.headerFor(EN1, EN2, NTIME2, NONCE);
		const hb = b.headerFor(EN1, EN2, NTIME2, NONCE);
		expect(ha.equals(hb)).toBe(false);
	});
});

// --- Solo invariant: exactly one value-bearing output paying the full reward -

describe('solo coinbase outputs (legal hard gate: no reward splitting)', () => {
	it('2-tx template: single payout output = full coinbasevalue, + zero-value witness commitment', () => {
		const v = variantFor(TEMPLATE_2TX, 'j11');
		const parsed = bitcoin.Transaction.fromHex(reassembledCoinbaseHex(v, EN1, EN2));
		const sum = parsed.outs.reduce((s, o) => s + BigInt(o.value), 0n);
		expect(sum).toBe(BigInt(TEMPLATE_2TX.coinbasevalue));
		// exactly ONE value-bearing output, and it pays the miner the whole reward
		const valueOuts = parsed.outs.filter((o) => BigInt(o.value) > 0n);
		expect(valueOuts).toHaveLength(1);
		expect(BigInt(valueOuts[0]!.value)).toBe(BigInt(TEMPLATE_2TX.coinbasevalue));
		expect(valueOuts[0]!.script.equals(Buffer.from(MINER))).toBe(true);
		// out[0] = payout, out[1] = zero-value witness commitment
		expect(parsed.outs).toHaveLength(2);
		expect(parsed.outs[1]!.value).toBe(0);
		expect(parsed.outs[1]!.script.toString('hex')).toBe(TEMPLATE_2TX.default_witness_commitment);
	});

	it('0-tx template: a single payout output, no witness commitment', () => {
		const v = variantFor(TEMPLATE_0TX, 'j12');
		const parsed = bitcoin.Transaction.fromHex(reassembledCoinbaseHex(v, EN1, EN2));
		expect(parsed.outs).toHaveLength(1);
		expect(BigInt(parsed.outs[0]!.value)).toBe(BigInt(TEMPLATE_0TX.coinbasevalue));
		expect(parsed.outs[0]!.script.equals(Buffer.from(MINER))).toBe(true);
	});

	it('rejects a negative coinbasevalue (value guard)', () => {
		expect(() => buildJob({ ...TEMPLATE_0TX, coinbasevalue: -1 }, cfg('neg'))).toThrow(/non-negative/);
	});

	it('rejects an out-of-range coinbasevalue when personalized (conservation guard)', () => {
		// A normal block reward personalizes fine.
		const ok = buildJob({ ...TEMPLATE_0TX, coinbasevalue: 5_000_000_000 }, cfg('ok'));
		expect(() => ok.personalize({ payoutScript: MINER })).not.toThrow();
		// One beyond Number.MAX_SAFE_INTEGER trips toSatsNumber before any output is built.
		const over = buildJob(
			{ ...TEMPLATE_0TX, coinbasevalue: Number.MAX_SAFE_INTEGER + 2 } as GbtTemplate,
			cfg('over')
		);
		expect(() => over.personalize({ payoutScript: MINER })).toThrow(/out of range/);
	});
});

// --- Header + assemble -------------------------------------------------------

describe('headerFor + assemble', () => {
	it('header is 80 bytes with every field in place', () => {
		const v = variantFor(TEMPLATE_2TX, 'j8');
		const header = v.headerFor(EN1, EN2, NTIME2, NONCE);
		expect(header.length).toBe(80);
		expect(header.readUInt32LE(0)).toBe(TEMPLATE_2TX.version);
		expect(header.subarray(4, 36).equals(displayToInternal(PREV_HASH))).toBe(true);
		expect(header.readUInt32LE(68)).toBe(TEMPLATE_2TX.curtime);
		expect(header.readUInt32LE(72)).toBe(parseInt(TEMPLATE_2TX.bits, 16));
		expect(header.readUInt32LE(76)).toBe(parseInt(NONCE, 16));
	});

	it('exposes Stratum job fields consistent with the template', () => {
		const j = buildJob(TEMPLATE_2TX, cfg('j10')).job;
		expect(j.jobId).toBe('j10');
		expect(j.versionHex).toBe('20000000');
		expect(j.nbitsHex).toBe('207fffff');
		expect(j.ntimeHex).toBe(NTIME2);
		expect(j.height).toBe(103);
		expect(j.coinbaseValueSats).toBe(5_000_012_345n);
		expect(j.prevHashDisplay).toBe(PREV_HASH);
		expect(fromStratumPrevHash(j.prevHashStratum)).toBe(PREV_HASH);
	});

	it('2-tx block = header ‖ varint(3) ‖ segwit coinbase ‖ tx data, witness = [32 zero bytes]', () => {
		const v = variantFor(TEMPLATE_2TX, 'j14');
		const header = v.headerFor(EN1, EN2, NTIME2, NONCE);
		const { blockHex, blockHashDisplay, coinbaseTxidDisplay } = v.assemble(EN1, EN2, NTIME2, NONCE);
		const legacyHex = reassembledCoinbaseHex(v, EN1, EN2);
		const cbWitness = bitcoin.Transaction.fromHex(legacyHex);
		cbWitness.setWitness(0, [Buffer.alloc(32)]);
		expect(blockHex).toBe(header.toString('hex') + '03' + cbWitness.toHex() + TX_A.data + TX_B.data);
		expect(coinbaseTxidDisplay).toBe(bitcoin.Transaction.fromHex(legacyHex).getId());
		expect(displayToInternal(blockHashDisplay).equals(sha256dDirect(header))).toBe(true);
		expect(hashValueFromDisplay(blockHashDisplay)).toBeGreaterThan(0n);
	});

	it('0-tx block without witness commitment stays fully legacy', () => {
		const v = variantFor(TEMPLATE_0TX, 'j15');
		const header = v.headerFor(EN1, EN2, NTIME0, NONCE);
		const { blockHex, coinbaseTxidDisplay } = v.assemble(EN1, EN2, NTIME0, NONCE);
		const legacyHex = reassembledCoinbaseHex(v, EN1, EN2);
		expect(blockHex).toBe(header.toString('hex') + '01' + legacyHex);
		expect(coinbaseTxidDisplay).toBe(bitcoin.Transaction.fromHex(legacyHex).getId());
		expect(header.subarray(36, 68).equals(displayToInternal(coinbaseTxidDisplay))).toBe(true);
	});
});
