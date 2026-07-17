/**
 * Solo job builder: getblocktemplate → per-miner Stratum job.
 *
 * Rewritten from the Tessera pool job builder (C:\dev\raffle\pool\src\job.ts) for
 * SOLO mining. The Tessera winners/finder/OP_RETURN machinery is gone; in its
 * place `personalize({ payoutScript })` produces the single-output coinbase for
 * one miner: the FULL template coinbase value to that miner's payout script, plus
 * the zero-value SegWit witness-commitment output. There is no pool-fee output,
 * no reward split of any kind (legal hard gate cairn-vn43.14). Value conservation
 * (Σ outputs == coinbasevalue) is asserted, never assumed.
 *
 * Retained verbatim in spirit from Tessera (winning-path correctness):
 *  - BIP34 minimal height push, then the ASCII pool tag, then EN1(4B)+EN2(4B),
 *    the whole scriptSig capped at the 100-byte consensus limit (tag trimmed).
 *  - The exact coinb1/coinb2 split at the extranonce offset, with the
 *    offset-mismatch defense check.
 *  - headerFor / assemble closures and the shared merkle branches over the
 *    non-coinbase txids.
 *
 * All byte-order math goes through src/lib/server/mining/wire.ts — never here.
 */
import * as bitcoin from 'bitcoinjs-lib';
import type { AssembledBlock, BuiltJob, CoinbaseVariant, GbtTemplate, Network, StratumJob } from './types';
import {
	applyBranches,
	buildHeader,
	displayToInternal,
	headerHashDisplay,
	internalToDisplay,
	merkleBranches,
	sha256d,
	toStratumPrevHash,
	varint
} from './wire';

/** Extranonce sizes (4 bytes each). */
export const EXTRANONCE1_SIZE = 4;
export const EXTRANONCE2_SIZE = 4;
const EXTRANONCE_SIZE = EXTRANONCE1_SIZE + EXTRANONCE2_SIZE;

/** Consensus limit on the coinbase scriptSig. */
const MAX_SCRIPTSIG_SIZE = 100;

export interface JobConfig {
	readonly network: Network;
	readonly poolTag: string;
	readonly jobId: string;
	readonly cleanJobs: boolean;
}

/** Unsigned 32-bit value → 8-char BE hex exactly as carried in Stratum messages. */
function beHex32(n: number, what: string): string {
	if (!Number.isInteger(n)) throw new Error(`${what} must be an integer`);
	return (n >>> 0).toString(16).padStart(8, '0');
}

/** Strict hex → bytes with an exact length requirement (validate before parse). */
function hexToBytes(hex: string, expectedLen: number, what: string): Buffer {
	if (hex.length !== expectedLen * 2 || !/^[0-9a-fA-F]*$/.test(hex)) {
		throw new Error(`${what} must be ${expectedLen * 2} hex chars, got "${hex}"`);
	}
	return Buffer.from(hex, 'hex');
}

/** sats bigint → a JS number safe for bitcoinjs addOutput (range-checked). */
function toSatsNumber(v: bigint): number {
	if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`sats out of range: ${v}`);
	return Number(v);
}

export function buildJob(template: GbtTemplate, cfg: JobConfig): BuiltJob {
	// Validate the fields we slot directly into the header.
	hexToBytes(template.bits, 4, 'template.bits');
	const coinbaseValueSats = BigInt(template.coinbasevalue);
	if (coinbaseValueSats < 0n) throw new Error('coinbase value must be non-negative');
	if (!Number.isInteger(template.height) || template.height < 0 || template.height > 0xffffffff) {
		throw new Error(`template height out of range: ${template.height}`);
	}

	// ── Shared across every per-miner variant ─────────────────────────────────
	const witnessCommitment = template.default_witness_commitment ?? null;
	const branches = merkleBranches(template.transactions.map((t) => displayToInternal(t.txid)));
	const txData = template.transactions.map((t) => Buffer.from(t.data, 'hex'));
	const versionHex = beHex32(template.version, 'template.version');
	const nbitsHex = template.bits.toLowerCase();
	const ntimeHex = beHex32(template.curtime, 'template.curtime');
	const prevHashStratum = toStratumPrevHash(template.previousblockhash);

	// scriptSig = BIP34 heightPush ‖ tag ‖ EN1 ‖ EN2 (raw concat after the height
	// push; ≤100 bytes — trim the tag). Shared by every variant (the payout
	// changes only an OUTPUT, never the input script), so the extranonce split
	// offset is identical for all miners.
	const heightPush = bitcoin.script.compile([bitcoin.script.number.encode(template.height)]);
	let tag = Buffer.from(cfg.poolTag, 'ascii');
	if (heightPush.length + tag.length + EXTRANONCE_SIZE > MAX_SCRIPTSIG_SIZE) {
		tag = tag.subarray(0, Math.max(0, MAX_SCRIPTSIG_SIZE - heightPush.length - EXTRANONCE_SIZE));
	}
	const scriptPrefix = Buffer.concat([heightPush, tag]);
	const scriptLen = scriptPrefix.length + EXTRANONCE_SIZE;
	if (scriptLen > MAX_SCRIPTSIG_SIZE) {
		// Defense in depth: an over-limit scriptSig is a consensus violation the
		// network rejects silently. Assert the trim actually worked.
		throw new Error(`scriptSig ${scriptLen} exceeds consensus limit ${MAX_SCRIPTSIG_SIZE}`);
	}
	const en1Offset = 4 + 1 + 36 + varint(scriptLen).length + scriptPrefix.length;

	/**
	 * Build one miner's coinbase variant: exactly one value-bearing output (the
	 * miner's payout script, full coinbase value) plus the zero-value witness
	 * commitment. Value conservation asserted here (the invariant the whole solo
	 * payout story rests on).
	 */
	const makeVariant = (payoutScript: Uint8Array): CoinbaseVariant => {
		const tx = new bitcoin.Transaction();
		tx.version = 2;
		tx.addInput(
			Buffer.alloc(32, 0),
			0xffffffff,
			0xffffffff,
			Buffer.concat([scriptPrefix, Buffer.alloc(EXTRANONCE_SIZE, 0)])
		);
		// THE single value-bearing output: the full reward to the miner's script.
		tx.addOutput(Buffer.from(payoutScript), toSatsNumber(coinbaseValueSats));
		// SegWit witness-commitment output (zero value, so conservation holds).
		if (witnessCommitment) tx.addOutput(Buffer.from(witnessCommitment, 'hex'), 0);

		// Conservation + shape check (legal hard gate cairn-vn43.14): exactly one
		// value-bearing output carrying all of coinbasevalue, plus at most the
		// zero-value commitment. Anything else is a split — refuse to build it.
		const valueOuts = tx.outs.filter((o) => BigInt(o.value) > 0n);
		if (valueOuts.length > 1) {
			throw new Error(`solo coinbase has ${valueOuts.length} value-bearing outputs — splitting is forbidden`);
		}
		const total = tx.outs.reduce((sum, o) => sum + BigInt(o.value), 0n);
		if (total !== coinbaseValueSats) {
			throw new Error(`value conservation violated: outputs ${total} != coinbase ${coinbaseValueSats}`);
		}

		const serialized = tx.toBuffer(); // no witness set → legacy bytes
		if (
			!serialized.subarray(en1Offset, en1Offset + EXTRANONCE_SIZE).equals(Buffer.alloc(EXTRANONCE_SIZE, 0))
		) {
			throw new Error('extranonce split offset mismatch'); // defense in depth
		}
		const coinb1 = serialized.subarray(0, en1Offset);
		const coinb2 = serialized.subarray(en1Offset + EXTRANONCE_SIZE);

		const coinbaseFor = (en1Hex: string, en2Hex: string): Buffer =>
			Buffer.concat([
				coinb1,
				hexToBytes(en1Hex, EXTRANONCE1_SIZE, 'extranonce1'),
				hexToBytes(en2Hex, EXTRANONCE2_SIZE, 'extranonce2'),
				coinb2
			]);

		const headerFor = (en1Hex: string, en2Hex: string, ntimeArg: string, nonceHex: string): Buffer => {
			const coinbaseTxidLE = sha256d(coinbaseFor(en1Hex, en2Hex));
			const root = applyBranches(coinbaseTxidLE, branches);
			return buildHeader(versionHex, template.previousblockhash, root, ntimeArg, nbitsHex, nonceHex);
		};

		const assemble = (en1Hex: string, en2Hex: string, ntimeArg: string, nonceHex: string): AssembledBlock => {
			const header = headerFor(en1Hex, en2Hex, ntimeArg, nonceHex);
			const legacyCoinbase = coinbaseFor(en1Hex, en2Hex);
			const coinbaseTxidDisplay = internalToDisplay(sha256d(legacyCoinbase));
			let coinbaseSerialized = legacyCoinbase;
			if (witnessCommitment) {
				const cb = bitcoin.Transaction.fromHex(legacyCoinbase.toString('hex'));
				cb.setWitness(0, [Buffer.alloc(32)]);
				coinbaseSerialized = cb.toBuffer();
			}
			const block = Buffer.concat([header, varint(1 + txData.length), coinbaseSerialized, ...txData]);
			return {
				blockHex: block.toString('hex'),
				blockHashDisplay: headerHashDisplay(header),
				coinbaseTxidDisplay
			};
		};

		return { coinb1Hex: coinb1.toString('hex'), coinb2Hex: coinb2.toString('hex'), headerFor, assemble };
	};

	const job: StratumJob = {
		jobId: cfg.jobId,
		prevHashDisplay: template.previousblockhash,
		prevHashStratum,
		merkleBranchesInternalHex: branches.map((b) => b.toString('hex')),
		versionHex,
		nbitsHex,
		ntimeHex,
		height: template.height,
		coinbaseValueSats,
		cleanJobs: cfg.cleanJobs
	};

	return {
		job,
		personalize: ({ payoutScript }) => makeVariant(payoutScript)
	};
}
