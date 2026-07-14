// Unit tests for the forced-solve harness's block builder (cairn-vn43.2).
// Pure logic only — no bitcoind, no docker. Run via `npm test` (vitest picks
// this up per the scripts/**/*.test.mjs include added to vitest.config.ts).
import { describe, it, expect } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import {
	buildCoinbaseScriptSig,
	buildCoinbaseTx,
	witnessCommitmentScript,
	finalizeWitnessCommitment,
	parseBits,
	displayHexToInternal,
	grindProofOfWork,
	buildForcedSolveBlock
} from './soloBlockBuilder.mjs';

const network = bitcoin.networks.regtest;
const payoutScript = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 0x42), network }).output;

const REGTEST_EASY_BITS = '207fffff'; // Core's regtest default: >=50% of hashes qualify
const baseTemplate = () => ({
	version: 0x20000000,
	previousblockhash: '00'.repeat(31) + '01',
	curtime: 1_700_000_000,
	bits: REGTEST_EASY_BITS,
	height: 200,
	coinbasevalue: 5_000_000_000,
	transactions: []
});

describe('buildCoinbaseScriptSig', () => {
	it('encodes BIP34 height as the first push', () => {
		const script = buildCoinbaseScriptSig(200);
		const decompiled = bitcoin.script.decompile(script);
		expect(bitcoin.script.number.decode(decompiled[0])).toBe(200);
	});

	it('rejects a negative height', () => {
		expect(() => buildCoinbaseScriptSig(-1)).toThrow(/non-negative/);
	});

	it('appends the extra tag after the height push', () => {
		const tag = Buffer.from('cairn-forced-solve');
		const script = buildCoinbaseScriptSig(1, tag);
		const decompiled = bitcoin.script.decompile(script);
		expect(decompiled[1].equals(tag)).toBe(true);
	});

	it('stays within the consensus 2-100 byte coinbase scriptSig bound', () => {
		const script = buildCoinbaseScriptSig(700_000, Buffer.from('cairn-forced-solve'));
		expect(script.length).toBeGreaterThanOrEqual(2);
		expect(script.length).toBeLessThanOrEqual(100);
	});
});

describe('witnessCommitmentScript', () => {
	it('produces the BIP141 OP_RETURN 0xaa21a9ed<hash> prefix', () => {
		const hash = Buffer.alloc(32, 0xab);
		const script = witnessCommitmentScript(hash);
		expect(script.subarray(0, 6).toString('hex')).toBe('6a24aa21a9ed');
		expect(script.subarray(6, 38).equals(hash)).toBe(true);
	});

	it('rejects a non-32-byte hash', () => {
		expect(() => witnessCommitmentScript(Buffer.alloc(31))).toThrow(/32 bytes/);
	});
});

describe('buildCoinbaseTx', () => {
	it('pays the full block reward to the single payout output', () => {
		const tx = buildCoinbaseTx({ height: 200, payoutScript, valueSats: 5_000_000_000 });
		expect(tx.outs[0].value).toBe(5_000_000_000);
		expect(tx.outs[0].script.equals(payoutScript)).toBe(true);
	});

	it('sets the witness reserved value (32 zero bytes) on the coinbase input', () => {
		const tx = buildCoinbaseTx({ height: 200, payoutScript, valueSats: 100 });
		expect(tx.ins[0].witness).toHaveLength(1);
		expect(tx.ins[0].witness[0].equals(Buffer.alloc(32, 0))).toBe(true);
	});

	it('rejects a non-safe-integer or non-positive value', () => {
		expect(() => buildCoinbaseTx({ height: 200, payoutScript, valueSats: 100n })).toThrow(/safe-integer/);
		expect(() => buildCoinbaseTx({ height: 200, payoutScript, valueSats: 0 })).toThrow(/positive/);
		expect(() => buildCoinbaseTx({ height: 200, payoutScript, valueSats: -10 })).toThrow(/positive/);
	});
});

describe('finalizeWitnessCommitment', () => {
	it('rewrites the commitment output to a real BIP141 commitment matching Block.calculateMerkleRoot', () => {
		const tx = buildCoinbaseTx({ height: 200, payoutScript, valueSats: 100 });
		finalizeWitnessCommitment(tx, [tx]);
		const expected = bitcoin.Block.calculateMerkleRoot([tx], true);
		expect(tx.outs[1].script.subarray(6, 38).equals(expected)).toBe(true);
		expect(tx.outs[1].value).toBe(0);
	});
});

describe('parseBits / displayHexToInternal', () => {
	it('parses an 8-hex-char bits string to the packed uint32', () => {
		expect(parseBits('207fffff')).toBe(0x207fffff);
	});

	it('rejects malformed bits', () => {
		expect(() => parseBits('xyz')).toThrow(/bits must be/);
		expect(() => parseBits('20ff')).toThrow(/bits must be/);
	});

	it('reverses display-order hash hex to internal LE bytes', () => {
		const display = '00'.repeat(31) + 'ff';
		const internal = displayHexToInternal(display);
		expect(internal.subarray(0, 1).toString('hex')).toBe('ff');
		expect(internal.subarray(31, 32).toString('hex')).toBe('00');
	});
});

describe('grindProofOfWork', () => {
	it('finds a valid nonce immediately at regtest-easy difficulty', () => {
		const template = baseTemplate();
		const coinbaseTx = buildCoinbaseTx({ height: template.height, payoutScript, valueSats: template.coinbasevalue });
		finalizeWitnessCommitment(coinbaseTx, [coinbaseTx]);
		const block = new bitcoin.Block();
		block.version = template.version;
		block.prevHash = displayHexToInternal(template.previousblockhash);
		block.merkleRoot = bitcoin.Block.calculateMerkleRoot([coinbaseTx]);
		block.timestamp = template.curtime;
		block.bits = parseBits(template.bits);
		block.transactions = [coinbaseTx];

		const { nonce, attempts } = grindProofOfWork(block);
		expect(attempts).toBeGreaterThan(0);
		expect(nonce).toBe(block.nonce);
		expect(block.checkProofOfWork()).toBe(true);
	});

	it('throws instead of spinning forever against an impossible target', () => {
		const template = baseTemplate();
		const coinbaseTx = buildCoinbaseTx({ height: template.height, payoutScript, valueSats: template.coinbasevalue });
		finalizeWitnessCommitment(coinbaseTx, [coinbaseTx]);
		const block = new bitcoin.Block();
		block.version = template.version;
		block.prevHash = displayHexToInternal(template.previousblockhash);
		block.merkleRoot = bitcoin.Block.calculateMerkleRoot([coinbaseTx]);
		block.timestamp = template.curtime;
		// Maximum-difficulty bits (smallest possible target) — no nonce will
		// ever satisfy this within a small attempt cap.
		block.bits = parseBits('03000001');
        block.transactions = [coinbaseTx];

		expect(() => grindProofOfWork(block, { maxAttempts: 50 })).toThrow(/no valid nonce found/);
	});
});

describe('buildForcedSolveBlock (integration of the above)', () => {
	it('builds a block that is internally self-consistent: PoW + merkle + witness commitment', () => {
		const template = baseTemplate();
		const result = buildForcedSolveBlock({ template, payoutScript });

		expect(result.block.checkProofOfWork()).toBe(true);
		expect(result.block.checkTxRoots()).toBe(true);
		expect(result.coinbaseTxid).toMatch(/^[0-9a-f]{64}$/);
		expect(result.blockId).toMatch(/^[0-9a-f]{64}$/);
		// Conservation: the payout output equals the template's coinbasevalue
		// exactly (this is the property the forced-solve harness ultimately
		// re-checks against the real chain after submitblock).
		expect(result.coinbaseTx.outs[0].value).toBe(template.coinbasevalue);
	});

	it('reproduces the same block deterministically for the same template', () => {
		const template = baseTemplate();
		const a = buildForcedSolveBlock({ template, payoutScript });
		const b = buildForcedSolveBlock({ template, payoutScript });
		expect(a.blockId).toBe(b.blockId);
		expect(a.blockHex).toBe(b.blockHex);
	});

	it('changes the block hash when the height (and therefore BIP34 push + payout target) changes', () => {
		const t1 = baseTemplate();
		const t2 = { ...baseTemplate(), height: 201 };
		const a = buildForcedSolveBlock({ template: t1, payoutScript });
		const b = buildForcedSolveBlock({ template: t2, payoutScript });
		expect(a.blockId).not.toBe(b.blockId);
	});

	it('includes non-coinbase template transactions in both merkle roots', () => {
		// A minimal valid nonsense tx just to exercise the "other transactions"
		// path — buildForcedSolveBlock does not validate tx semantics, only
		// wires them into the merkle/witness computation, mirroring what a
		// real getblocktemplate.transactions[] entry looks like ({ data }).
		const other = new bitcoin.Transaction();
		other.version = 1;
		other.addInput(Buffer.alloc(32, 0x11), 0, 0xffffffff);
		other.addOutput(payoutScript, 1000);
		const template = { ...baseTemplate(), transactions: [{ data: other.toHex() }] };

		const result = buildForcedSolveBlock({ template, payoutScript });
		expect(result.block.transactions).toHaveLength(2);
		expect(result.block.checkTxRoots()).toBe(true);
	});
});
