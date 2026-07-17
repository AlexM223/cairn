/**
 * Address → output script, ECC-free (ported from C:\dev\raffle\core\src\coinbase.ts,
 * the addressToOutputScript / validateAddressEncodable / network-map slice only).
 *
 * bitcoinjs's toOutputScript needs an ECC lib initialized for taproot; but a
 * witness-vN output script is just OP_N <program> — no curve math — so segwit
 * addresses are built directly from the (checksum-validated) bech32/bech32m
 * decode. This keeps the mining engine free of any secp256k1 initialization.
 */
import * as bitcoin from 'bitcoinjs-lib';
import type { Network } from './types';

/**
 * Network name → bitcoinjs params. testnet4/testnet5 share testnet3's address
 * formats (bech32 hrp 'tb', identical version bytes) — only the p2p network
 * magic differs, and that lives in bitcoind, which the engine only talks to over
 * RPC. Aliased explicitly so NETWORK=testnet4 resolves to real testnet params
 * instead of silently falling back to regtest (which would mis-encode every
 * payout address).
 */
export const NETWORKS = {
	mainnet: bitcoin.networks.bitcoin,
	testnet: bitcoin.networks.testnet,
	testnet4: bitcoin.networks.testnet,
	testnet5: bitcoin.networks.testnet,
	regtest: bitcoin.networks.regtest
} as const;

export type NetworkName = keyof typeof NETWORKS;

/** Resolve a network name to bitcoinjs params, or throw on an unknown name. */
export function networkFor(name: string): Network {
	const net = (NETWORKS as Record<string, Network>)[name];
	if (net === undefined) throw new Error(`unknown network: ${name}`);
	return net;
}

/**
 * Address → output script, ECC-free. Segwit (v0 p2wpkh/p2wsh, v1+ taproot and
 * future witness versions) is compiled directly from the bech32/bech32m decode;
 * base58 (p2pkh / p2sh) falls through to bitcoinjs's toOutputScript, which needs
 * no ECC for those. Throws on an address unencodable on this network.
 */
export function addressToOutputScript(address: string, network: Network): Buffer {
	try {
		const dec = bitcoin.address.fromBech32(address);
		if (dec.prefix !== network.bech32)
			throw new Error(`wrong bech32 prefix for network: ${dec.prefix}`);
		if (dec.version === 0 && (dec.data.length === 20 || dec.data.length === 32)) {
			return bitcoin.script.compile([bitcoin.opcodes.OP_0!, dec.data]);
		}
		if (dec.version >= 1 && dec.version <= 16 && dec.data.length >= 2 && dec.data.length <= 40) {
			// BIP341 restricts v1 programs to 32 bytes
			if (dec.version === 1 && dec.data.length !== 32)
				throw new Error('invalid v1 witness program length');
			return bitcoin.script.compile([bitcoin.opcodes.OP_1! + dec.version - 1, dec.data]);
		}
		throw new Error('unsupported witness program');
	} catch (bech32Err) {
		try {
			// base58 (p2pkh / p2sh) — handled fine without ECC
			return bitcoin.address.toOutputScript(address, network);
		} catch {
			throw bech32Err instanceof Error ? bech32Err : new Error(String(bech32Err));
		}
	}
}

/**
 * Authorize-time gate: an address that cannot be encoded into an output script
 * on this network must never be handed a job (its coinbase would be unpayable).
 * Call before accepting a miner's payout address.
 */
export function validateAddressEncodable(address: string, network: Network): boolean {
	try {
		return addressToOutputScript(address, network).length > 0;
	} catch {
		return false;
	}
}
