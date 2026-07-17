// Fake Bitcoin Core RpcLike for the load / edge-case harness: serves a fixed
// tip + block template and accepts (records) submitblock. No bitcoind needed.
//
// The template uses a HARD nbits (diff-1, '1d00ffff') so a share at the harness's
// easy shareDifficulty flows constantly while a share almost never also SOLVES —
// cleanly separating "share throughput" (what the load test stresses) from the
// rare block-found path (exercised for real by mining-forced-solve.mjs).
import { createHash } from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { addressToOutputScript } from '../../src/lib/server/mining/address.ts';

const TIP_HASH = createHash('sha256').update('heartwood-load-tip').digest('hex');
const TIP_HEIGHT = 200_000;

// HARD nbits (~65536× diff-1): a floor-difficulty share (prob ~2^-12) flows
// constantly while it essentially never also SOLVES (solve prob ~2^-48), so the
// load test stresses share throughput without ever tripping the block path.
export const LOAD_TEMPLATE = {
	version: 0x20000000,
	previousblockhash: TIP_HASH,
	height: TIP_HEIGHT + 1,
	curtime: 1_750_000_000,
	bits: '1b00ffff',
	coinbasevalue: 312_500_000,
	transactions: []
};

// EASY regtest nbits ('207fffff'): with blockPolicyShift 0 every accepted share
// also SOLVES — used by the frozen-payout solve check that needs a block.
export const EASY_TEMPLATE = {
	...LOAD_TEMPLATE,
	bits: '207fffff'
};

export class FakeRpc {
	constructor(template = LOAD_TEMPLATE) {
		this.template = template;
		this.submitted = [];
		this.gbtCalls = 0;
		this.submitResult = null; // null == accepted
	}

	async call(method, params = []) {
		switch (method) {
			case 'getbestblockhash':
				return this.template.previousblockhash;
			case 'getblock':
				return { height: this.template.height - 1 };
			case 'getblocktemplate':
				this.gbtCalls++;
				return { ...this.template };
			case 'submitblock':
				this.submitted.push(params[0]);
				return this.submitResult;
			default:
				throw new Error(`unexpected rpc ${method}`);
		}
	}
}

/** A deterministic regtest MinerAuth (bcrt1) for a synthetic miningId/user. */
export function makeMiner(miningId, userId, walletId, seedByte, network) {
	const address = bitcoin.payments.p2wpkh({ hash: Buffer.alloc(20, seedByte), network }).address;
	return { userId, miningId, walletId, address, payoutScript: new Uint8Array(addressToOutputScript(address, network)) };
}
