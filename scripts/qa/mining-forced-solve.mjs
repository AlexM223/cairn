#!/usr/bin/env node
// Forced-solve regtest e2e for the Heartwood solo mining engine
// (bead cairn-vn43.2, Deliverable 1 — the mainnet-enablement gate).
//
// Drives the REAL engine (src/lib/server/mining/{miningPool,stratum,job,...}.ts)
// against a REAL regtest bitcoind: getblocktemplate -> personalized job ->
// synthetic Stratum miner grinds a solving share -> engine assembles + submits
// the block -> bitcoind ACCEPTS it -> on-chain verification. This is the one
// path a home solo miner exercises for real roughly once per 15,000+ years, so
// it must be proven end to end.
//
// Verifies (brief steps 5-7):
//   * submitblock accepted; getblockcount incremented; best hash == solved hash
//   * coinbase pays the seeded user's derived bcrt1 address for the FULL
//     coinbasevalue (exactly one value output + the zero-value witness commitment)
//   * mining_blocks row status 'accepted'; wallet receive_cursor advanced by 1
//   * engine fatalErrors empty; coinbase matures after 100 further blocks
//   * PAYOUT ISOLATION: a second user replaying the winner's share on its own
//     connection cannot produce a payout to itself or alter the winner's block
//
//   node scripts/qa/mining-forced-solve.mjs
import { ensureTsRuntime } from './mining-bootstrap.mjs';
ensureTsRuntime(import.meta.url);

import { DatabaseSync } from 'node:sqlite';
import { HDKey } from '@scure/bip32';
import * as bitcoin from 'bitcoinjs-lib';

const { MiningPool } = await import('../../src/lib/server/mining/miningPool.ts');
const { MapAuthProvider } = await import('../../src/lib/server/mining/types.ts');
const { NETWORKS, addressToOutputScript } = await import('../../src/lib/server/mining/address.ts');
const { SyntheticMiner } = await import('./mining-miner.mjs');
const { startRegtestNode } = await import('./mining-regtest-node.mjs');

const REGTEST = NETWORKS.regtest;
const COINBASE_MATURITY = 100;
const RUN_CAP_MS = 4 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
function check(cond, msg) {
	if (cond) console.log(`  ok   ${msg}`);
	else {
		failures.push(msg);
		console.error(`  FAIL ${msg}`);
	}
}
async function until(cond, ms, label) {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
		await sleep(20);
	}
}

// A regtest-capable payout identity derived from a BIP84 account (bcrt1 p2wpkh).
function makeIdentity(seedByte, userId, walletId, miningId) {
	const master = HDKey.fromMasterSeed(new Uint8Array(64).fill(seedByte));
	const account = master.derive("m/84'/1'/0'");
	const leaf = master.derive("m/84'/1'/0'/0/0"); // receive index 0
	const address = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(leaf.publicKey), network: REGTEST }).address;
	return {
		userId,
		walletId,
		miningId,
		accountXpub: account.publicExtendedKey,
		auth: { userId, miningId, walletId, address, payoutScript: new Uint8Array(addressToOutputScript(address, REGTEST)) }
	};
}

// Minimal Cairn DB subset (mirrors src/lib/server/db.ts DDL for these tables) so
// the harness exercises the bridge's persistence contract on a real schema.
function seedDb(identities) {
	const db = new DatabaseSync(':memory:');
	db.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE);
		CREATE TABLE wallets (
			id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT, type TEXT,
			xpub TEXT, script_type TEXT, receive_cursor INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE mining_prefs (
			user_id INTEGER PRIMARY KEY, mining_id TEXT UNIQUE, enabled INTEGER NOT NULL DEFAULT 0,
			payout_wallet_id INTEGER);
		CREATE TABLE mining_blocks (
			id INTEGER PRIMARY KEY AUTOINCREMENT, height INTEGER NOT NULL, block_hash TEXT NOT NULL UNIQUE,
			coinbase_txid TEXT, user_id INTEGER, worker_name TEXT, wallet_id INTEGER,
			payout_address TEXT NOT NULL, coinbase_value_sats TEXT NOT NULL, submit_result TEXT NOT NULL);
	`);
	for (const id of identities) {
		db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(id.userId, `${id.miningId}@example.test`);
		db.prepare(
			'INSERT INTO wallets (id, user_id, name, type, xpub, script_type, receive_cursor) VALUES (?, ?, ?, ?, ?, ?, 0)'
		).run(id.walletId, id.userId, 'payout', 'xpub', id.accountXpub, 'p2wpkh');
		db.prepare('INSERT INTO mining_prefs (user_id, mining_id, enabled, payout_wallet_id) VALUES (?, ?, 1, ?)').run(
			id.userId,
			id.miningId,
			id.walletId
		);
	}
	return db;
}

// Reproduces index.ts handleBlockAccepted's durable effects: record the block
// row and advance the finder's receive cursor exactly once.
function persistAcceptedBlock(db, solve, blockHash, coinbaseTxid) {
	db.prepare(
		`INSERT INTO mining_blocks (height, block_hash, coinbase_txid, user_id, worker_name, wallet_id,
		    payout_address, coinbase_value_sats, submit_result)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`
	).run(solve.height, blockHash, coinbaseTxid, solve.userId, solve.worker, solve.walletId, solve.address, solve.coinbaseValueSats.toString());
	db.prepare('UPDATE wallets SET receive_cursor = receive_cursor + 1 WHERE id = ? AND user_id = ?').run(solve.walletId, solve.userId);
}

async function main() {
	const t0 = Date.now();
	console.log('[forced-solve] bringing up regtest bitcoind...');
	let node;
	try {
		node = await startRegtestNode();
	} catch (e) {
		console.log(`\nBLOCKED: ${e.message}`);
		console.log('Deliverable: harness is complete; run on a box with a bitcoind binary or docker to execute.');
		process.exit(2);
	}
	console.log(`[forced-solve] regtest up via ${node.kind}`);

	const winner = makeIdentity(0x11, 1, 101, 'mid-winner');
	const other = makeIdentity(0x22, 2, 102, 'mid-other');
	const db = seedDb([winner, other]);
	const throwaway = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, 0xaa), network: REGTEST }).address;

	const rpc = { call: (method, params = []) => node.rpc.call(method, params) };
	const accepted = [];
	const rejected = [];
	const pool = new MiningPool({
		rpc,
		config: {
			bindHost: '127.0.0.1',
			port: 19333,
			network: REGTEST,
			poolTag: 'heartwood-forced-solve',
			shareDifficulty: 0.000001, // floor: ~4k-hash share that also clears regtest PoW
			vardiffEnabled: false,
			vardiffTargetPerMin: 6,
			maxDifficulty: 2 ** 40,
			maxConnections: 64,
			blockPolicyShift: 0
		},
		authProvider: new MapAuthProvider([winner.auth, other.auth]),
		tipPollIntervalMs: 300,
		feeRefreshMs: 3_600_000,
		onBlockAccepted: (solve, blockHash, coinbaseTxid) => {
			accepted.push({ solve, blockHash, coinbaseTxid });
			persistAcceptedBlock(db, solve, blockHash, coinbaseTxid);
		},
		onBlockRejected: (solve, reason) => rejected.push({ solve, reason }),
		log: () => {}
	});

	try {
		// 1. Bootstrap spendable coinbase / stable template state.
		console.log('[forced-solve] mining 101 bootstrap blocks...');
		await node.rpc.call('generatetoaddress', [101, throwaway]);
		check((await node.rpc.call('getblockcount')) === 101, 'chain bootstrapped to height 101');
		const heightBefore = 101;

		// 2. Start the real engine; it polls the tip and builds the first job.
		await pool.start();
		await until(() => pool.status().lastJobAt !== null, 8000, 'first job');

		// 3. Connect BOTH miners to the SAME job (so the isolation replay tests
		//    payout-binding, not mere staleness).
		const m1 = new SyntheticMiner(19333);
		await m1.connect();
		await m1.handshake(winner.auth.miningId, 'w1');
		const m2 = new SyntheticMiner(19333);
		await m2.connect();
		await m2.handshake(other.auth.miningId, 'w1');
		check(pool.status().minerCount === 2, 'both miners authorized on the engine');

		// 4. Winner grinds a solving share (regtest PoW ⇒ a floor-diff share solves).
		const found = m1.grind('00000001', { maxNonces: 8_000_000 });
		check(!!found, 'winner ground a solving share');
		const winningJobId = found.jobId;
		const winningNtime = m1.job.ntimeHex; // capture before the solve advances the tip

		// 5. Winner submits → engine assembles + submits the block → bitcoind accepts.
		check(await m1.submit(found.jobId, found.en2, found.nonce), 'winning share accepted by the engine');
		await until(() => accepted.length === 1, 8000, 'block accepted callback');

		const rec = accepted[0];
		const bestHash = await node.rpc.call('getbestblockhash');
		const countAfter = await node.rpc.call('getblockcount');
		check(countAfter === heightBefore + 1, `getblockcount incremented ${heightBefore}→${countAfter}`);
		check(bestHash === rec.blockHash, 'chain tip is exactly the engine-assembled block');
		check(rec.blockHash === found.hashDisplay, 'accepted block hash == the share the miner solved');
		check(pool.status().fatalErrors.length === 0, 'engine fatalErrors empty after solve');

		// 6. On-chain coinbase shape: one value output for the FULL reward to the
		//    winner's derived address, plus the zero-value witness commitment.
		const block = await node.rpc.call('getblock', [bestHash, 2]);
		const coinbaseTx = block.tx[0];
		const valueOuts = coinbaseTx.vout.filter((o) => o.value > 0);
		const zeroOuts = coinbaseTx.vout.filter((o) => o.value === 0);
		check(valueOuts.length === 1, `coinbase has exactly ONE value-bearing output (got ${valueOuts.length})`);
		check(zeroOuts.length >= 1, 'coinbase carries the zero-value witness commitment output');
		const paidSats = Math.round(valueOuts[0].value * 1e8);
		check(paidSats === Number(rec.solve.coinbaseValueSats), `coinbase pays the FULL value ${paidSats} == template ${rec.solve.coinbaseValueSats}`);
		check(valueOuts[0].scriptPubKey.address === winner.auth.address, `coinbase pays the winner's derived address ${winner.auth.address}`);
		check(coinbaseTx.txid === rec.coinbaseTxid, 'engine-reported coinbase txid matches the on-chain coinbase');

		// 7. Bridge persistence: mining_blocks accepted row + cursor advanced by 1.
		const row = db.prepare('SELECT * FROM mining_blocks WHERE block_hash = ?').get(rec.blockHash);
		check(!!row && row.submit_result === 'accepted', "mining_blocks row recorded status 'accepted'");
		check(row && row.user_id === winner.userId && row.wallet_id === winner.walletId, 'block row attributes to the winner user/wallet');
		const cursor = db.prepare('SELECT receive_cursor AS c FROM wallets WHERE id = ?').get(winner.walletId).c;
		check(cursor === 1, `winner wallet receive_cursor advanced by exactly 1 (0→${cursor})`);

		// 8. PAYOUT ISOLATION: the other user replays the winner's exact share on
		//    ITS OWN connection. It must not pay itself, nor alter the winner's block.
		const iso = await m2.submitRaw(winningJobId, found.en2, winningNtime, found.nonce);
		check(iso.result !== true, 'replay of the winner share on another user connection is rejected');
		await sleep(500);
		check(accepted.length === 1, 'no second block resulted from the replay (winner block stands)');
		check(accepted[0].solve.userId === winner.userId, 'the sole accepted block still pays the winner (payout isolation holds)');
		const otherRow = db.prepare('SELECT COUNT(*) AS n FROM mining_blocks WHERE user_id = ?').get(other.userId).n;
		check(otherRow === 0, 'the replaying user has NO block row (never paid via another miner’s share)');

		m1.destroy();
		m2.destroy();
		await pool.stop();

		// 9. Maturity: 100 further blocks make the coinbase spendable.
		console.log('[forced-solve] maturing the coinbase (+100 blocks)...');
		await node.rpc.call('generatetoaddress', [COINBASE_MATURITY, throwaway]);
		const txout = await node.rpc.call('gettxout', [rec.coinbaseTxid, valueOuts[0].n, true]);
		check(!!txout, 'matured coinbase output is still unspent');
		check(txout && txout.confirmations >= COINBASE_MATURITY + 1, `coinbase matured (${txout?.confirmations} confs ≥ ${COINBASE_MATURITY + 1})`);
	} catch (err) {
		failures.push(`unhandled: ${err.stack ?? err.message}`);
		console.error('FATAL', err);
	} finally {
		try {
			await pool.stop();
		} catch {
			/* already stopped */
		}
		await node.stop().catch((e) => console.error('teardown:', e.message));
		db.close();
	}

	const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
	console.log('\n================ MINING FORCED-SOLVE — REGTEST e2e ================');
	console.log(`elapsed ${elapsed}s  (cap ${RUN_CAP_MS / 1000}s)  backend: ${node.kind}`);
	if (failures.length === 0) {
		console.log('RESULT: PASS — real engine solved + confirmed a block on real bitcoind, payout isolated, matured');
	} else {
		console.log(`RESULT: FAIL — ${failures.length} assertion(s):`);
		for (const f of failures) console.log(`  x ${f}`);
	}
	console.log('===================================================================');
	process.exit(failures.length === 0 ? 0 : 1);
}

main();
