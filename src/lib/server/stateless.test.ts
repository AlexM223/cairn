import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HDKey } from '@scure/bip32';
import { Transaction, NETWORK } from '@scure/btc-signer';
import {
	parseStatelessSource,
	scanStatelessSource,
	buildStatelessPsbt,
	combineStatelessPsbts,
	broadcastStatelessPsbt,
	statelessErrorInfo
} from './stateless';
import { PRIVATE_KEY_REFUSAL } from './multisigExport';
import { deriveMultisigAddress } from './bitcoin/multisig';
import { addressToScripthash } from './bitcoin/xpub';
import { toMultisigConfig } from './wallets/multisig';
import { invalidateMultisigCache } from './multisigScan';

// The stateless flow exercises the real scan/psbt path up to the network
// edge; only the chain source itself is faked (same idiom as
// transactions.test.ts). multisigScan imports './chain/index' and stateless.ts
// imports './chain' — both specifiers resolve to the same module, but both
// are mocked explicitly so the coverage doesn't hinge on resolver behavior.
const { batchRequestMock, listUnspentMock, broadcastMock, getTxMock, getTxHexMock } = vi.hoisted(
	() => ({
		batchRequestMock: vi.fn(),
		listUnspentMock: vi.fn(),
		broadcastMock: vi.fn(),
		getTxMock: vi.fn(),
		getTxHexMock: vi.fn()
	})
);
vi.mock('./chain', () => ({
	getChain: () => ({
		electrum: {
			batchRequest: batchRequestMock,
			listUnspent: listUnspentMock,
			broadcast: broadcastMock
		},
		getTx: getTxMock,
		getTxHex: getTxHexMock
	})
}));
vi.mock('./chain/index', () => ({
	getChain: () => ({
		electrum: {
			batchRequest: batchRequestMock,
			listUnspent: listUnspentMock,
			broadcast: broadcastMock
		},
		getTx: getTxMock,
		getTxHex: getTxHexMock
	})
}));

// ── deterministic cosigner fixtures ──────────────────────────────────────────
// Master seeds 0x01…0x03 at the BIP-48 wsh path — the same test-only key
// family multisig.test.ts / multisigPsbt.test.ts pin.
const BIP48_PATH = "m/48'/0'/0'/2'";

function makeSigner(seedByte: number) {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive(BIP48_PATH);
	return {
		xpub: account.publicExtendedKey,
		fingerprint: (master.fingerprint >>> 0).toString(16).padStart(8, '0')
	};
}

const SIGNERS = [1, 2, 3].map(makeSigner);

/** A 2-of-3 Caravan wallet config over the fixture keys. */
const CARAVAN_2OF3 = JSON.stringify({
	name: 'Test multisig',
	addressType: 'P2WSH',
	network: 'mainnet',
	quorum: { requiredSigners: 2, totalSigners: 3 },
	extendedPublicKeys: SIGNERS.map((s, i) => ({
		name: `Cosigner ${i + 1}`,
		xpub: s.xpub,
		bip32Path: BIP48_PATH,
		xfp: s.fingerprint
	})),
	startingAddressIndex: 0
});

/** The matching receive descriptor (built through the real library so the
 *  checksum is correct). */
function descriptor2of3(): string {
	const { multisig } = parseStatelessSource(CARAVAN_2OF3);
	return `wsh(sortedmulti(2,${multisig.keys
		.map((k) => `[${k.fingerprint}/48h/0h/0h/2h]${k.xpub}/0/*`)
		.join(',')}))`;
}

const RECIPIENT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

/** A synthetic funding tx paying the multisig's 0/0 address; real txid. */
function fundingTx(address: string, value: number): { hex: string; txid: string } {
	const tx = new Transaction({ allowUnknownInputs: true, disableScriptCheck: true });
	tx.addInput({ txid: '00'.repeat(32), index: 0 });
	tx.addOutputAddress(address, BigInt(value), NETWORK);
	return { hex: tx.hex, txid: tx.id };
}

/** Wire the chain mocks so the multisig has exactly one 150k-sat coin at 0/0. */
function fundMultisigAtZero(): { address: string; fund: { hex: string; txid: string } } {
	const { multisig } = parseStatelessSource(CARAVAN_2OF3);
	const address = deriveMultisigAddress(toMultisigConfig(multisig), 0, 0).address;
	const sh = addressToScripthash(address);
	const fund = fundingTx(address, 150_000);

	batchRequestMock.mockImplementation(
		async (reqs: { method: string; params: [string] }[]) =>
			reqs.map((r) => {
				if (r.method === 'blockchain.scripthash.get_history') {
					return r.params[0] === sh ? [{ tx_hash: fund.txid, height: 800_000 }] : [];
				}
				// getMultisigUtxos now batches listunspent via batchRequest (task 4).
				if (r.method === 'blockchain.scripthash.listunspent') {
					return r.params[0] === sh
						? [{ tx_hash: fund.txid, tx_pos: 0, value: 150_000, height: 800_000 }]
						: [];
				}
				return r.params[0] === sh
					? { confirmed: 150_000, unconfirmed: 0 }
					: { confirmed: 0, unconfirmed: 0 };
			})
	);
	listUnspentMock.mockImplementation(async (scripthash: string) =>
		scripthash === sh ? [{ tx_hash: fund.txid, tx_pos: 0, value: 150_000, height: 800_000 }] : []
	);
	getTxMock.mockImplementation(async (txid: string) => {
		if (txid !== fund.txid) throw new Error(`unexpected getTx(${txid})`);
		return {
			txid,
			vout: [{ address, value: 150_000 }],
			vin: [],
			blockTime: 1_700_000_000,
			fee: 500
		};
	});
	getTxHexMock.mockImplementation(async (txid: string) => {
		if (txid !== fund.txid) throw new Error(`unexpected getTxHex(${txid})`);
		return fund.hex;
	});

	return { address, fund };
}

beforeEach(() => {
	batchRequestMock.mockReset();
	listUnspentMock.mockReset();
	broadcastMock.mockReset();
	getTxMock.mockReset();
	getTxHexMock.mockReset();
	// The scan cache is keyed on the config's descriptor and lives 60s — every
	// test starts from a cold cache so the mocks above are actually exercised.
	invalidateMultisigCache();
});

// ── parsing ──────────────────────────────────────────────────────────────────

describe('parseStatelessSource', () => {
	it('parses a Caravan JSON into an ephemeral, never-persisted MultisigRow', () => {
		const { config, multisig } = parseStatelessSource(CARAVAN_2OF3);
		expect(config.threshold).toBe(2);
		expect(config.totalKeys).toBe(3);
		expect(config.scriptType).toBe('p2wsh');
		expect(config.name).toBe('Test multisig');
		expect(config.keys.map((k) => k.fingerprint)).toEqual(SIGNERS.map((s) => s.fingerprint));

		// The ephemeral marker: ids 0, nothing that could collide with a row.
		expect(multisig.id).toBe(0);
		expect(multisig.userId).toBe(0);
		expect(multisig.keys).toHaveLength(3);
	});

	it('parses a descriptor and keeps its parsed script type', () => {
		const { config } = parseStatelessSource(descriptor2of3());
		expect(config.threshold).toBe(2);
		expect(config.scriptType).toBe('p2wsh');
		// Descriptors carry no names — synthesized ones fill the roster.
		expect(config.keys[0].name).toBe('Key 1');
	});

	it('descriptor and Caravan JSON of the same multisig derive the same 0/0 address', () => {
		const a = parseStatelessSource(CARAVAN_2OF3).multisig;
		const b = parseStatelessSource(descriptor2of3()).multisig;
		expect(deriveMultisigAddress(toMultisigConfig(a), 0, 0).address).toBe(
			deriveMultisigAddress(toMultisigConfig(b), 0, 0).address
		);
	});

	it('refuses private key material loudly, before any parsing', () => {
		const xprv =
			'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';
		for (const source of [xprv, `{"extendedPublicKeys":[{"xpub":"${xprv}"}]}`]) {
			expect(() => parseStatelessSource(source)).toThrowError(PRIVATE_KEY_REFUSAL);
		}
	});

	it('rejects empty input and non-multisig text with presentable messages', () => {
		expect(() => parseStatelessSource('')).toThrow(/paste a descriptor/i);
		expect(() => parseStatelessSource('not a descriptor')).toThrow();
		expect(statelessErrorInfo(safeCatch(() => parseStatelessSource('nope'))).status).toBe(400);
	});
});

function safeCatch(fn: () => unknown): unknown {
	try {
		fn();
		throw new Error('expected throw');
	} catch (e) {
		return e;
	}
}

// ── scan ─────────────────────────────────────────────────────────────────────

describe('scanStatelessSource', () => {
	it('scans an ephemeral multisig over the mocked chain: balance, utxos, addresses, test address', async () => {
		const { address, fund } = fundMultisigAtZero();

		const scan = await scanStatelessSource(CARAVAN_2OF3);

		expect(scan.balance).toEqual({ confirmed: 150_000, unconfirmed: 0 });
		expect(scan.utxos).toHaveLength(1);
		expect(scan.utxos[0]).toMatchObject({
			txid: fund.txid,
			vout: 0,
			value: 150_000,
			address,
			chain: 0,
			index: 0
		});

		// Receive preview: index order, used flag on the funded address only.
		expect(scan.addresses.length).toBeGreaterThan(1);
		expect(scan.addresses.length).toBeLessThanOrEqual(10);
		expect(scan.addresses[0]).toEqual({ address, index: 0, used: true });
		expect(scan.addresses[1].used).toBe(false);

		expect(scan.testAddress).toBe(address);
		expect(scan.descriptor).toMatch(/^wsh\(sortedmulti\(2,/);
		expect(scan.descriptor).toMatch(/#[a-z0-9]{8}$/);
		expect(scan.registration).toContain('Policy: 2 of 3');
		expect(scan.config.threshold).toBe(2);
	});
});

// ── build ────────────────────────────────────────────────────────────────────

describe('buildStatelessPsbt', () => {
	it('builds a PSBT over the posted config with change and 0-of-M progress', async () => {
		const { fund } = fundMultisigAtZero();

		const { details, progress } = await buildStatelessPsbt(CARAVAN_2OF3, {
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: 5
		});

		expect(details.amount).toBe(50_000);
		expect(details.recipient).toBe(RECIPIENT);
		expect(details.inputs).toEqual([
			expect.objectContaining({ txid: fund.txid, vout: 0, value: 150_000 })
		]);
		expect(details.change).not.toBeNull();
		// Parents were fetched (nonWitnessUtxo path) → the mass block rides along.
		expect(details.signingMass).toBeDefined();

		expect(progress).toMatchObject({ required: 2, collected: 0, complete: false });
		expect(progress.remainingFingerprints.sort()).toEqual(
			SIGNERS.map((s) => s.fingerprint).sort()
		);

		// Same build from the equivalent descriptor — the source format never
		// changes the transaction's structure.
		invalidateMultisigCache();
		const viaDescriptor = await buildStatelessPsbt(descriptor2of3(), {
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: 5
		});
		expect(viaDescriptor.details.fee).toBe(details.fee);
		expect(viaDescriptor.details.inputs).toEqual(details.inputs);
	});

	it('surfaces construction refusals (nothing spendable) as PsbtError → 400', async () => {
		// Everything unused/empty on-chain.
		batchRequestMock.mockImplementation(async (reqs: { method: string }[]) =>
			reqs.map((r) =>
				r.method === 'blockchain.scripthash.get_history'
					? []
					: { confirmed: 0, unconfirmed: 0 }
			)
		);
		listUnspentMock.mockResolvedValue([]);

		const attempt = buildStatelessPsbt(CARAVAN_2OF3, {
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: 5
		});
		await expect(attempt).rejects.toMatchObject({ name: 'PsbtError', code: 'no_utxos' });
		expect(statelessErrorInfo(await attempt.catch((e) => e)).status).toBe(400);
	});
});

// ── combine + broadcast ──────────────────────────────────────────────────────

describe('combineStatelessPsbts / broadcastStatelessPsbt', () => {
	it('combining a PSBT with itself is idempotent and reports live progress', async () => {
		fundMultisigAtZero();
		const { details } = await buildStatelessPsbt(CARAVAN_2OF3, {
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: 5
		});

		const { psbt, progress } = combineStatelessPsbts(
			CARAVAN_2OF3,
			details.psbtBase64,
			details.psbtBase64
		);
		expect(typeof psbt).toBe('string');
		expect(progress).toMatchObject({ required: 2, collected: 0, complete: false });
	});

	it('refuses to broadcast below quorum with an "X of M" message, before touching the network', async () => {
		fundMultisigAtZero();
		const { details } = await buildStatelessPsbt(CARAVAN_2OF3, {
			recipients: [{ address: RECIPIENT, amount: 50_000 }],
			feeRate: 5
		});

		await expect(broadcastStatelessPsbt(CARAVAN_2OF3, details.psbtBase64)).rejects.toThrow(
			/Only 0 of 2 signatures collected/
		);
		expect(broadcastMock).not.toHaveBeenCalled();
	});

	it('maps garbage PSBTs to a presentable 400, never a 502', () => {
		const err = safeCatch(() => combineStatelessPsbts(CARAVAN_2OF3, 'garbage!!', 'garbage!!'));
		const info = statelessErrorInfo(err);
		expect(info.status).toBe(400);
		expect(info.message.length).toBeGreaterThan(0);
	});
});
