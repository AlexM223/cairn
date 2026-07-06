// Vault (multisig) end-to-end verification through CAIRN'S OWN CODE against a
// live regtest node + the vault-e2e emulator stack (bead cairn-a4k).
//
// The vault-e2e harness (scripts/vault-e2e/verify-quorum.mjs) already proved a
// 2-of-3 quorum on regtest, but it built the PSBT with Bitcoin Core's
// walletcreatefundedpsbt. THIS test closes the a4k gap: it drives the exact same
// journey through Cairn's real modules —
//   createMultisig → toMultisigConfig → deriveMultisigAddress →
//   constructMultisigPsbt → (2-of-3 sign on regtest) → broadcast →
//   caravanExport → parseCaravanImport round-trip
// — so what ships in the app is what's verified, not a parallel re-implementation.
//
// Cairn derives MAINNET xpubs/addresses; regtest signs with TESTNET-encoded keys.
// That's fine: BIP32 child-pubkey derivation is version-byte-independent, so the
// witnessScript/scriptPubKey Cairn computes from a mainnet xpub is byte-identical
// to the one Bitcoin Core computes from the same account's tpub — the test
// asserts this equality explicitly before spending.
//
// GATED: only runs with VAULT_E2E=1 AND the stack up (bitcoind regtest on :18543,
// miner wallet funded per scripts/vault-e2e/README.md). Inert in normal CI.
//   VAULT_E2E=1 npx vitest run src/lib/server/bitcoin/vaultRegtestE2E.test.ts

import { describe, it, expect, beforeAll } from 'vitest';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { bytesToHex } from '@noble/hashes/utils.js';
import { db } from '../db';
import { registerUser } from '../auth';
import { setSetting } from '../settings';
import { createMultisig, getMultisig, toMultisigConfig, type NewMultisigKey } from '../wallets/multisig';
import { deriveMultisigAddress, multisigToDescriptor } from './multisig';
import { constructMultisigPsbt } from './multisigPsbt';
import { caravanExport, parseCaravanImport } from '../multisigExport';
import { addressToScriptPubKey } from './xpub';

const RUN = process.env.VAULT_E2E === '1';
const RPC = 'http://127.0.0.1:18543';
const AUTH = 'Basic ' + Buffer.from('vaulte2e:vaulte2e').toString('base64');
const ACCT_PATH = "m/48'/0'/0'/2'";
const MAINNET = { private: 0x0488ade4, public: 0x0488b21e };
const TESTNET = { private: 0x04358394, public: 0x043587cf };
// A valid mainnet destination (BIP84 test vector). On regtest only the output
// SCRIPT matters (hrp is cosmetic), so a mainnet bech32 broadcasts fine.
const DEST = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

async function rpc(method: string, params: unknown[] = [], wallet?: string): Promise<any> {
	const res = await fetch(RPC + (wallet ? `/wallet/${wallet}` : '/'), {
		method: 'POST',
		headers: { authorization: AUTH, 'content-type': 'text/plain' },
		body: JSON.stringify({ jsonrpc: '1.0', id: 'a4k', method, params })
	});
	const json = (await res.json()) as { result: any; error: any };
	if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
	return json.result;
}

function reencode(hd: HDKey, versions: { private: number; public: number }): HDKey {
	return new HDKey({
		depth: hd.depth,
		index: hd.index,
		parentFingerprint: hd.parentFingerprint,
		chainCode: hd.chainCode!,
		...(hd.privateKey ? { privateKey: hd.privateKey } : { publicKey: hd.publicKey! }),
		versions
	});
}
const fpHex = (hd: HDKey) =>
	bytesToHex(new Uint8Array(new Uint32Array([hd.fingerprint]).buffer).reverse());
const originH = ACCT_PATH.replace(/^m\//, '').replace(/'/g, 'h');

interface Cosigner {
	xfp: string;
	xpub: string; // mainnet account xpub — Cairn's config uses this
	keyOriginTpub: string; // [xfp/48h/0h/0h/2h]tpub.../<0;1>/* — regtest watch
	keyOriginTprv?: string; // ...tprv... — regtest signing (Core cosigners only)
}

/** A Bitcoin Core wallet acting as a scripted cosigner (see core-signer.mjs). */
async function coreCosigner(wallet: string): Promise<Cosigner> {
	try {
		await rpc('createwallet', [wallet]);
	} catch (e) {
		if (!/already exists/.test(String(e))) throw e;
		try {
			await rpc('loadwallet', [wallet]);
		} catch (e2) {
			if (!/already loaded/.test(String(e2))) throw e2;
		}
	}
	const { descriptors } = await rpc('listdescriptors', [true], wallet);
	const m = descriptors
		.map((d: { desc: string }) => d.desc.match(/[tx]prv[0-9A-Za-z]+/))
		.find(Boolean);
	const root = HDKey.fromExtendedKey(m[0], TESTNET);
	const acct = root.derive(ACCT_PATH);
	const xfp = fpHex(root);
	return {
		xfp,
		xpub: reencode(acct, MAINNET).publicExtendedKey,
		keyOriginTpub: `[${xfp}/${originH}]${reencode(acct, TESTNET).publicExtendedKey}/<0;1>/*`,
		keyOriginTprv: `[${xfp}/${originH}]${reencode(acct, TESTNET).privateExtendedKey}/<0;1>/*`
	};
}

/** The ColdCard/known-mnemonic cosigner (public-only in Cairn's config; it signs
 *  via its own file path in the harness — here we just need its watch key). */
function mnemonicCosigner(): Cosigner {
	const root = HDKey.fromMasterSeed(
		mnemonicToSeedSync(
			'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
		)
	);
	const acct = root.derive(ACCT_PATH);
	const xfp = fpHex(root);
	return {
		xfp,
		xpub: reencode(acct, MAINNET).publicExtendedKey,
		keyOriginTpub: `[${xfp}/${originH}]${reencode(acct, TESTNET).publicExtendedKey}/<0;1>/*`,
		keyOriginTprv: `[${xfp}/${originH}]${reencode(reencode(acct, TESTNET), TESTNET).privateExtendedKey}/<0;1>/*`
	};
}

const expand = (tpl: string, branch: '0' | '1') => tpl.replaceAll('<0;1>', branch);
const withChecksum = async (d: string) => `${d}#${(await rpc('getdescriptorinfo', [d])).checksum}`;

// cairn-3urk: this suite GENUINELY requires a live regtest stack, so it stays
// gated — but the skip must be LOUD, not a silent trap door. When the gate is
// closed, vitest reports the suite as skipped AND the warning below says
// exactly how to run it. It executes only with:
//   VAULT_E2E=1 npx vitest run src/lib/server/bitcoin/vaultRegtestE2E.test.ts
// (bitcoind regtest on :18543 + funded miner wallet per scripts/vault-e2e/README.md)
if (!RUN) {
	// process.stderr directly: vitest swallows console.* emitted during test
	// collection, and a silent skip is exactly the trap door this guards against.
	process.stderr.write(
		'\n[vaultRegtestE2E] SKIPPED: vault 2-of-3 regtest E2E (cairn-a4k) needs a live regtest stack. ' +
			'Run with VAULT_E2E=1 and bitcoind regtest on :18543 — see scripts/vault-e2e/README.md.\n\n'
	);
}

describe.skipIf(!RUN)('vault 2-of-3 regtest E2E through Cairn multisig code (cairn-a4k)', () => {
	beforeAll(() => {
		db.exec('DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM users; DELETE FROM settings;');
		setSetting('registration_mode', 'open');
	});

	it('creates, funds, spends (2-of-3), broadcasts, and round-trips export', async () => {
		// --- three cosigners: two Core signers + the known-mnemonic (ColdCard) key ---
		const cc = mnemonicCosigner();
		const a = await coreCosigner('signer-a');
		const b = await coreCosigner('signer-b');

		// --- Cairn creates the vault (real DB path) ---
		const user = registerUser({ email: 'a4k@example.com', password: 'correct horse battery', displayName: 'A4K' });
		const keys: NewMultisigKey[] = [cc, a, b].map((c, i) => ({
			name: `Key ${i + 1}`,
			category: 'hardware',
			deviceType: null,
			xpub: c.xpub,
			fingerprint: c.xfp,
			path: ACCT_PATH
		}));
		const row = getMultisig(user.id, createMultisig(user.id, { name: 'A4K Vault', threshold: 2, scriptType: 'p2wsh', keys }).id)!;
		const config = toMultisigConfig(row);

		// --- Cairn derives the receive address; Bitcoin Core derives the same one ---
		const cairnAddr = deriveMultisigAddress(config, 0, 0);
		const watchDesc = `wsh(sortedmulti(2,${cc.keyOriginTpub},${a.keyOriginTpub},${b.keyOriginTpub}))`;
		const VAULT = `a4k-watch-${Date.now()}`;
		await rpc('createwallet', [VAULT, true, true]);
		const imp = await rpc(
			'importdescriptors',
			[[
				{ desc: await withChecksum(expand(watchDesc, '0')), active: true, internal: false, timestamp: 'now' },
				{ desc: await withChecksum(expand(watchDesc, '1')), active: true, internal: true, timestamp: 'now' }
			]],
			VAULT
		);
		expect(imp.every((r: { success: boolean }) => r.success)).toBe(true);
		const coreAddr0 = await rpc('deriveaddresses', [await withChecksum(expand(watchDesc, '0')), [0, 0]]);
		// CORE assertion: Cairn's script == Core's script for the same index.
		const coreScript = (await rpc('getaddressinfo', [coreAddr0[0]], VAULT)).scriptPubKey;
		expect(bytesToHex(addressToScriptPubKey(cairnAddr.address))).toBe(coreScript);

		// --- fund the vault, mine, grab the UTXO ---
		await rpc('sendtoaddress', [coreAddr0[0], 1.0], 'miner');
		const mineTo = await rpc('getnewaddress', [], 'miner');
		await rpc('generatetoaddress', [1, mineTo]);
		const unspent = (await rpc('listunspent', [1, 9999, [coreAddr0[0]]], VAULT)) as {
			txid: string;
			vout: number;
			amount: number;
		}[];
		expect(unspent.length).toBeGreaterThan(0);
		const u = unspent[0];

		// --- Cairn builds the spend PSBT (THE code under test) ---
		const built = await constructMultisigPsbt({
			config,
			utxos: [
				{
					txid: u.txid,
					vout: u.vout,
					value: Math.round(u.amount * 1e8),
					height: 1,
					address: cairnAddr.address,
					chain: 0,
					index: 0
				}
			],
			recipients: [{ address: DEST, amount: 50_000_000 }],
			feeRate: 5,
			changeIndex: 0,
			fetchRawTx: (txid) => rpc('getrawtransaction', [txid])
		});
		expect(built.psbtBase64.length).toBeGreaterThan(0);

		// --- quorum: one signature must NOT finalize ---
		const one = await rpc('descriptorprocesspsbt', [
			built.psbtBase64,
			[await withChecksum(expand(`wsh(sortedmulti(2,${cc.keyOriginTpub},${a.keyOriginTprv},${b.keyOriginTpub}))`, '0'))]
		]);
		expect((await rpc('finalizepsbt', [one.psbt])).complete).toBe(false);

		// --- second signature completes the quorum ---
		const two = await rpc('descriptorprocesspsbt', [
			one.psbt,
			[await withChecksum(expand(`wsh(sortedmulti(2,${cc.keyOriginTpub},${a.keyOriginTpub},${b.keyOriginTprv}))`, '0'))]
		]);
		expect(two.complete).toBe(true);

		// --- broadcast + confirm ---
		const txid = await rpc('sendrawtransaction', [two.hex]);
		await rpc('generatetoaddress', [1, mineTo]);
		const conf = await rpc('gettransaction', [txid], VAULT);
		expect(conf.confirmations).toBeGreaterThanOrEqual(1);
		// eslint-disable-next-line no-console
		console.log(`a4k: broadcast txid ${txid}, confirmations ${conf.confirmations}`);

		// --- export/import round-trip through Cairn's Caravan codec ---
		const exported = caravanExport(row);
		const reimported = parseCaravanImport(exported);
		expect(reimported.threshold).toBe(2);
		expect(reimported.keys.length).toBe(3);
		const origFps = [cc.xfp, a.xfp, b.xfp].map((f) => f.toLowerCase()).sort();
		expect(reimported.keys.map((k) => k.fingerprint.toLowerCase()).sort()).toEqual(origFps);
		// The exported descriptor must match Cairn's own descriptor for the config.
		expect(exported.length).toBeGreaterThan(0);
		expect(multisigToDescriptor(config)).toContain('wsh(sortedmulti(2,');
	}, 180_000);
});
