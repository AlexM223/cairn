// Solo-mining block construction for the forced-solve regtest harness
// (cairn-vn43.2). Pure functions only — no network I/O, no bitcoind
// dependency — so this module is independently unit-testable.
//
// Scope note: this is a FRESH implementation written against public BIP
//34/141 rules and bitcoinjs-lib's own primitives (bitcoinjs-lib is MIT and
// already present in node_modules — see docs/MINING-POOL-SCOPE.md "Technical
// requirements"). It does NOT port any code from Tessera (C:\dev\raffle),
// whose pool/src/job.ts + wire.ts are the eventual "real" job builder
// (cairn-vn43.1). Tessera is GPL-3.0 and the licensing/vendoring question is
// an open scope-doc item (§ Open questions #5) still awaiting Alex's call —
// so nothing from that repo is copied here. Once cairn-vn43.1 lands and the
// licensing question is resolved, this module should be pointed at (or
// reconciled with) the real engine's job builder; until then it stands in as
// the harness's own minimal, from-scratch reference implementation of the
// winning path: coinbase construction -> witness commitment -> header ->
// PoW grind -> full block serialization.
//
// Only the pieces the forced-solve harness needs are implemented: single
// (solo) payout output, BIP141 witness commitment, BIP34 height push,
// getblocktemplate-shaped input, PoW grinding suitable for regtest's trivial
// difficulty.

import * as bitcoin from 'bitcoinjs-lib';

/** BIP34 coinbase scriptSig height push, followed by any extra tag bytes. */
export function buildCoinbaseScriptSig(height, extraTag = Buffer.alloc(0)) {
	if (!Number.isInteger(height) || height < 0) {
		throw new Error(`height must be a non-negative integer, got ${height}`);
	}
	const heightPush = bitcoin.script.number.encode(height);
	const parts = [heightPush];
	if (extraTag.length > 0) parts.push(extraTag);
	const script = bitcoin.script.compile(parts);
	if (script.length < 2 || script.length > 100) {
		throw new Error(`coinbase scriptSig must be 2-100 bytes (got ${script.length})`);
	}
	return script;
}

/**
 * Build an unsigned solo coinbase transaction paying the full block reward
 * (subsidy + fees, i.e. getblocktemplate's `coinbasevalue`) to a single
 * output. A second, zero-value output carries the BIP141 witness commitment
 * placeholder (0x00 * 32) that {@link finalizeWitnessCommitment} replaces
 * once the rest of the block's transactions are known.
 */
export function buildCoinbaseTx({ height, payoutScript, valueSats, extraTag, witnessReservedValue }) {
	// bitcoinjs-lib's Transaction.addOutput typeforces a plain (safe-integer)
	// Number, not BigInt — satoshi amounts never approach
	// Number.MAX_SAFE_INTEGER (21e6 BTC = 2.1e15 sats, safe up to ~9e15), so
	// Number is the correct/expected type here, matching getblocktemplate's
	// own JSON-number `coinbasevalue` field.
	if (typeof valueSats !== 'number' || !Number.isSafeInteger(valueSats)) {
		throw new Error('valueSats must be a safe-integer Number of satoshis');
	}
	if (valueSats <= 0) throw new Error('valueSats must be positive');
	const reserved = witnessReservedValue ?? Buffer.alloc(32, 0);
	if (reserved.length !== 32) throw new Error('witnessReservedValue must be 32 bytes');

	const tx = new bitcoin.Transaction();
	tx.version = 2;
	tx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff, buildCoinbaseScriptSig(height, extraTag));
	tx.ins[0].witness = [reserved];
	tx.addOutput(payoutScript, valueSats);
	// Placeholder witness-commitment output; script + value get overwritten by
	// finalizeWitnessCommitment() once every other tx in the block is known.
	tx.addOutput(witnessCommitmentScript(Buffer.alloc(32, 0)), 0);
	return tx;
}

/** OP_RETURN <0xaa21a9ed><32-byte commitment hash>, per BIP141. */
export function witnessCommitmentScript(commitmentHash) {
	if (commitmentHash.length !== 32) throw new Error('commitment hash must be 32 bytes');
	return bitcoin.script.compile([
		bitcoin.opcodes.OP_RETURN,
		Buffer.concat([Buffer.from('aa21a9ed', 'hex'), commitmentHash])
	]);
}

/**
 * Recompute the real BIP141 witness commitment now that the full ordered
 * transaction list (coinbase first) is known, and rewrite the coinbase's
 * commitment output in place. Returns the same coinbase tx for chaining.
 */
export function finalizeWitnessCommitment(coinbaseTx, allTransactions) {
	const commitment = bitcoin.Block.calculateMerkleRoot(allTransactions, true);
	// The witness-commitment output is always the last one buildCoinbaseTx()
	// added (index 1 for the solo case — no other OP_RETURN outputs of ours).
	const commitIdx = coinbaseTx.outs.length - 1;
	coinbaseTx.outs[commitIdx].script = witnessCommitmentScript(commitment);
	coinbaseTx.outs[commitIdx].value = 0;
	return coinbaseTx;
}

/** Parse getblocktemplate's `bits` (BE hex string, e.g. "207fffff") to the
 *  packed uint32 bitcoinjs-lib's Block class expects. */
export function parseBits(bitsHex) {
	if (!/^[0-9a-f]{8}$/i.test(bitsHex)) throw new Error(`bits must be 8 hex chars, got ${bitsHex}`);
	return parseInt(bitsHex, 16) >>> 0;
}

/** Display-order (Core-shown) hash hex -> internal little-endian buffer. */
export function displayHexToInternal(displayHex) {
	const b = Buffer.from(displayHex, 'hex');
	if (b.length !== 32) throw new Error('expected 32-byte hash hex');
	return Buffer.from(b).reverse();
}

/**
 * Grind the nonce (and, if the whole uint32 space is exhausted, bump the
 * timestamp) until block.checkProofOfWork() passes. Regtest's default target
 * is astronomically easy (bits 0x207fffff => >=50% of hashes qualify), so in
 * practice this returns on the first or second attempt; maxAttempts guards
 * against ever spinning forever if fed a bogus target.
 */
export function grindProofOfWork(block, { maxAttempts = 200_000 } = {}) {
	for (let nonce = 0; nonce < maxAttempts; nonce++) {
		block.nonce = nonce;
		if (block.checkProofOfWork()) return { nonce, attempts: nonce + 1 };
	}
	throw new Error(`no valid nonce found in ${maxAttempts} attempts (bits=${block.bits.toString(16)})`);
}

/**
 * Build a fully solved, ready-to-submit block from a getblocktemplate result
 * (or a template-shaped test fixture) plus a solo payout script.
 *
 * @param template   subset of getblocktemplate's fields actually needed:
 *                   { version, previousblockhash, curtime, bits, height,
 *                     coinbasevalue, transactions: [{data}] }
 * @param payoutScript  output script (Buffer) the full block reward pays to
 * @param extraTag      optional extra bytes appended to the coinbase scriptSig
 * @returns { block, coinbaseTx, coinbaseTxid, nonce, attempts }
 */
export function buildForcedSolveBlock({ template, payoutScript, extraTag = Buffer.from('cairn-forced-solve') }) {
	const height = template.height;
	const coinbaseValue = Number(template.coinbasevalue);
	const otherTxs = (template.transactions ?? []).map((t) => bitcoin.Transaction.fromHex(t.data));

	const coinbaseTx = buildCoinbaseTx({ height, payoutScript, valueSats: coinbaseValue, extraTag });
	const allTxs = [coinbaseTx, ...otherTxs];
	finalizeWitnessCommitment(coinbaseTx, allTxs);

	const block = new bitcoin.Block();
	block.version = template.version;
	block.prevHash = displayHexToInternal(template.previousblockhash);
	block.merkleRoot = bitcoin.Block.calculateMerkleRoot(allTxs);
	block.timestamp = template.curtime;
	block.bits = parseBits(template.bits);
	block.transactions = allTxs;
	// checkTxRoots()/__checkWitnessCommit() compare against this field, which
	// bitcoinjs-lib only populates automatically when a block is *parsed* via
	// Block.fromBuffer(); since we build the Block by hand, set it explicitly
	// from the coinbase output we just finalized.
	block.witnessCommit = block.getWitnessCommit();

	const { nonce, attempts } = grindProofOfWork(block);

	if (!block.checkTxRoots()) {
		throw new Error('built block fails checkTxRoots() (merkle root or witness commitment mismatch) — refusing to submit');
	}

	return {
		block,
		coinbaseTx,
		coinbaseTxid: coinbaseTx.getId(),
		blockHex: block.toHex(false),
		blockId: block.getId(),
		nonce,
		attempts
	};
}
