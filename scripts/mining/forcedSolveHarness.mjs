#!/usr/bin/env node
/**
 * Forced-solve regtest harness (cairn-vn43.2, mining-pool-scope epic
 * cairn-vn43). Scheduled as the P1 "long pole" gate for the whole mining
 * epic per docs/MINING-POOL-SCOPE.md Key decisions #4 / Risks #1 — the one
 * code path that must be flawless is template -> job -> solved share ->
 * submitblock -> the block being ACTUALLY CONFIRMED on a real chain, since
 * that path only gets exercised for real once every ~15,000-35,000 years of
 * home hashrate.
 *
 * SCOPE NOTE: cairn-vn43.1 (extracting the real Tessera-derived
 * stratum/job/coordinator engine into this repo) has not landed yet, and
 * Tessera's own regtest e2e (C:\dev\raffle\e2e\regtest-e2e.ts) is GPL-3.0 —
 * whether/how its code gets vendored into this MIT repo is still an open
 * scope-doc question (§ Open questions #5) pending Alex's licensing call.
 * So rather than block on either of those, this harness exercises the
 * SAME winning path directly against a real bitcoind: it builds its own
 * from-scratch solo coinbase (scripts/mining/soloBlockBuilder.mjs, using
 * only bitcoinjs-lib — MIT, already present), grinds regtest's trivially
 * easy proof-of-work, calls submitblock, and verifies on-chain — the exact
 * shape Tessera's e2e checks (coinbase conservation, block actually on the
 * main chain, payout eventually spendable), adapted for the solo (single
 * payout, no raffle/OP_RETURN-winners) design this epic settled on.
 *
 * When cairn-vn43.1's real engine exists, this harness should be pointed at
 * ITS job builder / stratum submit path instead of soloBlockBuilder.mjs's
 * standalone reference implementation — tracked as a follow-up on this bead.
 *
 * Runs fully self-contained: brings up its own ephemeral regtest bitcoind
 * (scripts/mining/regtestNode.mjs, own docker-compose project + port so it
 * never collides with other regtest stacks in this repo), forces
 * FORCED_SOLVE_BLOCKS blocks, matures them, verifies each one on-chain, and
 * tears the node down again — deterministic and fast enough for CI (a few
 * seconds of actual work plus however long `docker compose up` takes to pull
 * bitcoin/bitcoin:28.0 the first time).
 *
 *   npm run mining:forced-solve-harness
 */
import * as bitcoin from 'bitcoinjs-lib';
import { startRegtestNode } from './regtestNode.mjs';
import { buildForcedSolveBlock } from './soloBlockBuilder.mjs';

const network = bitcoin.networks.regtest;
const RUN_CAP_MS = 4 * 60_000; // well inside the brief's <5 min CI budget
const FORCED_SOLVE_BLOCKS = 3;
const WARMUP_BLOCKS = 101; // headroom past COINBASE_MATURITY for clean template state
const COINBASE_MATURITY = 100;

// Fixed, clearly-synthetic 20-byte "pubkey hashes" — this harness never
// needs a real private key (nothing here is signed): it only needs a stable
// scriptPubKey to assert the forced-solved coinbase pays exactly, and a
// second, distinct one to receive the throwaway warmup/maturity subsidies.
const PAYOUT_SCRIPT = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 0x42), network }).output;
const PAYOUT_ADDRESS = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 0x42), network }).address;
const THROWAWAY_ADDRESS = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 0xaa), network }).address;

const failures = [];
function fail(msg) {
	failures.push(msg);
	console.error(`[forced-solve] FAIL: ${msg}`);
}
function check(cond, msg) {
	if (!cond) fail(msg);
}

async function main() {
	const t0 = Date.now();
	const deadline = t0 + RUN_CAP_MS;
	console.log('[forced-solve] starting fresh ephemeral regtest bitcoind...');
	const node = await startRegtestNode();
	const solved = []; // { height, blockId, coinbaseTxid, coinbaseValueSats }

	try {
		const rpc = node.rpc;

		console.log(`[forced-solve] warming up ${WARMUP_BLOCKS} base blocks...`);
		await rpc('generatetoaddress', [WARMUP_BLOCKS, THROWAWAY_ADDRESS]);
		check((await rpc('getblockcount')) === WARMUP_BLOCKS, `chain at warmup height ${WARMUP_BLOCKS}`);

		for (let i = 0; i < FORCED_SOLVE_BLOCKS; i++) {
			if (Date.now() > deadline) throw new Error(`exceeded ${RUN_CAP_MS}ms run cap before block ${i}`);

			const template = await rpc('getblocktemplate', [{ rules: ['segwit'] }]);
			const result = buildForcedSolveBlock({
				template,
				payoutScript: PAYOUT_SCRIPT,
				extraTag: Buffer.from(`cairn-forced-solve-${i}`)
			});

			// Local self-check BEFORE spending a submitblock round-trip: if our
			// own job builder produced something internally inconsistent, fail
			// loudly here rather than trusting bitcoind to catch it.
			check(result.block.checkProofOfWork(), `block ${i}: locally-built block passes checkProofOfWork()`);
			check(result.block.checkTxRoots(), `block ${i}: locally-built block passes checkTxRoots()`);

			const submitResult = await rpc('submitblock', [result.blockHex]);
			check(submitResult === null || submitResult === undefined, `block ${i}: submitblock accepted (got ${JSON.stringify(submitResult)})`);

			const tip = await rpc('getbestblockhash');
			check(tip === result.blockId, `block ${i}: chain tip is our submitted block (${result.blockId})`);

			solved.push({
				height: template.height,
				blockId: result.blockId,
				coinbaseTxid: result.coinbaseTxid,
				coinbaseValueSats: Number(template.coinbasevalue),
				attempts: result.attempts
			});
			console.log(
				`[forced-solve] block ${i}: height ${template.height}, hash ${result.blockId}, ` +
					`coinbase ${template.coinbasevalue} sats, nonce found in ${result.attempts} attempt(s)`
			);
		}

		console.log(`[forced-solve] maturing solved blocks with ${COINBASE_MATURITY} more blocks...`);
		await rpc('generatetoaddress', [COINBASE_MATURITY, THROWAWAY_ADDRESS]);

		console.log(`[forced-solve] verifying ${solved.length} solved blocks against the real chain...`);
		for (const s of solved) {
			const hashAtHeight = await rpc('getblockhash', [s.height]);
			check(hashAtHeight === s.blockId, `height ${s.height}: our block is the one on the main chain (not orphaned)`);

			const txout = await rpc('gettxout', [s.coinbaseTxid, 0, true]);
			if (txout === null) {
				fail(`height ${s.height}: coinbase output ${s.coinbaseTxid}:0 is missing or already spent`);
				continue;
			}
			check(
				txout.confirmations >= COINBASE_MATURITY,
				`height ${s.height}: payout has matured (${txout.confirmations} confirmations >= ${COINBASE_MATURITY})`
			);
			const paidSats = Math.round(txout.value * 1e8);
			check(
				paidSats === s.coinbaseValueSats,
				`height ${s.height}: on-chain payout ${paidSats} sats == template coinbasevalue ${s.coinbaseValueSats}`
			);
			check(
				txout.scriptPubKey.address === PAYOUT_ADDRESS,
				`height ${s.height}: payout landed on the expected address (got ${txout.scriptPubKey.address})`
			);
		}
	} catch (err) {
		fail(`unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
	} finally {
		await node.stop().catch((err) => fail(`node teardown failed: ${String(err)}`));
	}

	const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
	console.log('');
	console.log('================ MINING FORCED-SOLVE — REGTEST REPORT ================');
	console.log(`elapsed: ${elapsed}s   blocks forced-solved: ${solved.length}/${FORCED_SOLVE_BLOCKS}`);
	for (const s of solved) {
		console.log(`  height ${s.height}  ${s.blockId}  ${s.coinbaseValueSats} sats  (nonce in ${s.attempts} attempt(s))`);
	}
	if (failures.length === 0) {
		console.log('RESULT: PASS — template->job->submitblock->confirmed->matured verified against real bitcoind');
	} else {
		console.log(`RESULT: FAIL — ${failures.length} assertion(s) failed:`);
		for (const f of failures) console.log(`  x ${f}`);
	}
	console.log('========================================================================');

	process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error('[forced-solve] fatal:', err);
	process.exit(1);
});
