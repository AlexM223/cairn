// Fresh-for-this-session Ledger multisig registration + signing script.
// Same approach as ../../.hw-emu-test/vault-ledger-node-sign.mjs (real Cairn
// ledger.ts business logic + SpeculosHttpTransport instead of the
// browser-only TransportWebHID that registerMultisigPolicy/
// signMultisigPsbtWithLedger hardcode), but imports from
// ../../.hw-emu-test/compiled-e2e/ledger.js (transpiled directly from the
// CURRENT src/lib/hw/ledger.ts — the old ./compiled/ledger.js snapshot
// predates the vault->multisig rename, its exports are named differently).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SpeculosHttpTransport = require('@ledgerhq/hw-transport-node-speculos-http').default;
const { AppClient } = require('@ledgerhq/hw-app-btc/lib/newops/appClient');
const { ClientCommandInterpreter } = require('@ledgerhq/hw-app-btc/lib/newops/clientCommands');
const { createVarint } = require('@ledgerhq/hw-app-btc/lib/varint');
const { Merkle, hashLeaf } = require('@ledgerhq/hw-app-btc/lib/newops/merkle');
const { PsbtV2 } = require('@ledgerhq/psbtv2');
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { Transaction } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { readFileSync } from 'node:fs';

import {
	buildMultisigPolicy,
	multisigDevicePubkeys,
	mergeMultisigSignatures,
	signMultisigPsbtWithLedger, // called for real, for the policy_unregistered pre-check only
	LedgerError
} from '../../.hw-emu-test/compiled-e2e/ledger.js';

const API_PORT = 25000;
const CLA_BTC = 0xe1;
const CLA_FRAMEWORK = 0xf8;
const INS_REGISTER_WALLET = 0x02;
const INS_CONTINUE_INTERRUPTED = 0x01;
const APDU_PROTOCOL_VERSION = 1;
const SW_INTERRUPTED = 0xe000;

function serializePolicy(policy) {
	const nameBytes = Buffer.from(policy.name, 'ascii');
	const templateBytes = Buffer.from(policy.template, 'ascii');
	const keysRoot = new Merkle(policy.keys.map((k) => hashLeaf(Buffer.from(k, 'ascii')))).getRoot();
	return Buffer.concat([
		Buffer.from([0x02]),
		createVarint(nameBytes.length),
		nameBytes,
		createVarint(templateBytes.length),
		Buffer.from(sha256(templateBytes)),
		createVarint(policy.keys.length),
		keysRoot
	]);
}

function makeDeviceWalletPolicy(policy) {
	const serialized = serializePolicy(policy);
	return {
		descriptorTemplate: policy.template,
		keys: policy.keys,
		serialize: () => serialized,
		getWalletId: () => Buffer.from(sha256(serialized))
	};
}

async function exchangeInterruptible(transport, ins, data, interpreter) {
	let response = await transport.send(CLA_BTC, ins, 0, APDU_PROTOCOL_VERSION, data, [0x9000, SW_INTERRUPTED]);
	while (response.readUInt16BE(response.length - 2) === SW_INTERRUPTED) {
		const hwRequest = response.subarray(0, response.length - 2);
		response = await transport.send(CLA_FRAMEWORK, INS_CONTINUE_INTERRUPTED, 0, APDU_PROTOCOL_VERSION, interpreter.execute(hwRequest), [0x9000, SW_INTERRUPTED]);
	}
	return response.subarray(0, response.length - 2);
}

function primeInterpreterWithPolicy(interpreter, policy, device) {
	interpreter.addKnownPreimage(device.serialize());
	interpreter.addKnownList(policy.keys.map((k) => Buffer.from(k, 'ascii')));
	interpreter.addKnownPreimage(Buffer.from(policy.template, 'ascii'));
}

async function registerPolicyViaSpeculos(params) {
	const policy = buildMultisigPolicy(params);
	const transport = await SpeculosHttpTransport.open({ apiPort: API_PORT });
	try {
		const client = new AppClient(transport);
		const masterFp = await client.getMasterFingerprint();
		const fpHex = Buffer.from(masterFp).toString('hex');
		const device = makeDeviceWalletPolicy(policy);
		const interpreter = new ClientCommandInterpreter(() => {});
		primeInterpreterWithPolicy(interpreter, policy, device);
		const serialized = device.serialize();
		const result = await exchangeInterruptible(
			transport,
			INS_REGISTER_WALLET,
			Buffer.concat([createVarint(serialized.length), serialized]),
			interpreter
		);
		if (result.length !== 64) throw new Error(`unexpected registration response length ${result.length}`);
		return {
			masterFp: fpHex,
			policyId: bytesToHex(Uint8Array.from(result.subarray(0, 32))),
			policyHmac: bytesToHex(Uint8Array.from(result.subarray(32, 64)))
		};
	} finally {
		await transport.close();
	}
}

async function signPsbtViaSpeculos(params, hmacHex) {
	const policy = buildMultisigPolicy(params);
	const sourceTx = Transaction.fromPSBT(base64.decode(params.unsignedPsbt.trim()));
	const transport = await SpeculosHttpTransport.open({ apiPort: API_PORT });
	try {
		const client = new AppClient(transport);
		const masterFp = await client.getMasterFingerprint();
		const fpHex = Buffer.from(masterFp).toString('hex');
		const deviceKeyIndex = params.keys.findIndex((k) => k.fingerprint.toLowerCase() === fpHex);
		if (deviceKeyIndex < 0) throw new Error(`device fingerprint ${fpHex} not a multisig key`);
		const devicePubkeys = multisigDevicePubkeys(params.unsignedPsbt, params.keys[deviceKeyIndex]);

		const psbtV2 = PsbtV2.fromV0(Buffer.from(sourceTx.toPSBT()));
		for (let i = 0; i < sourceTx.inputsLength; i++) {
			const ws = sourceTx.getInput(i).witnessScript;
			if (ws && typeof psbtV2.setInput === 'function') psbtV2.setInput(i, 0x05, Buffer.alloc(0), Buffer.from(ws));
		}

		const device = makeDeviceWalletPolicy(policy);
		const hmac = Buffer.from(hexToBytes(hmacHex));
		const t0 = Date.now();
		const sigs = await client.signPsbt(psbtV2, device, hmac, () => {});
		const elapsedMs = Date.now() - t0;
		mergeMultisigSignatures(sourceTx, sigs, devicePubkeys);
		console.log('SIGN_ELAPSED_MS=' + elapsedMs);
		return base64.encode(sourceTx.toPSBT());
	} finally {
		await transport.close();
	}
}

// ---------------------------------------------------------------- CLI

const [, , command, ...rest] = process.argv;

if (command === 'precheck-unregistered') {
	const [psbtArg, keysJson, threshold, scriptType] = rest;
	const unsignedPsbt = psbtArg.startsWith('@') ? readFileSync(psbtArg.slice(1), 'utf8').trim() : psbtArg;
	try {
		await signMultisigPsbtWithLedger({
			unsignedPsbt,
			threshold: Number(threshold),
			keys: JSON.parse(keysJson),
			scriptType,
			policyName: 'HW E2E 2-of-3 Vault',
			policyHmac: null
		});
		console.log('UNEXPECTED: signMultisigPsbtWithLedger did not throw');
		process.exit(1);
	} catch (err) {
		if (err instanceof LedgerError && err.code === 'policy_unregistered') {
			console.log('PASS: policy_unregistered ->', err.message);
		} else {
			console.log('FAIL: wrong error ->', err);
			process.exit(1);
		}
	}
} else if (command === 'device-reject-unregistered') {
	const [psbtArg, keysJson, threshold, scriptType, policyName] = rest;
	const unsignedPsbt = psbtArg.startsWith('@') ? readFileSync(psbtArg.slice(1), 'utf8').trim() : psbtArg;
	const params = { unsignedPsbt, threshold: Number(threshold), keys: JSON.parse(keysJson), scriptType, policyName: policyName || 'HW E2E 2-of-3 Vault' };
	try {
		await signPsbtViaSpeculos(params, '00'.repeat(32));
		console.log('UNEXPECTED: device accepted a bogus HMAC');
		process.exit(1);
	} catch (err) {
		console.log('PASS: device rejected bogus HMAC ->', err.message || err);
	}
} else if (command === 'register') {
	const [keysJson, threshold, scriptType, policyName] = rest;
	const result = await registerPolicyViaSpeculos({
		policyName,
		threshold: Number(threshold),
		keys: JSON.parse(keysJson),
		scriptType
	});
	console.log('REGISTERED:', JSON.stringify(result));
} else if (command === 'sign') {
	const [psbtArg, keysJson, threshold, scriptType, policyHmac, policyName] = rest;
	const unsignedPsbt = psbtArg.startsWith('@') ? readFileSync(psbtArg.slice(1), 'utf8').trim() : psbtArg;
	const signed = await signPsbtViaSpeculos(
		{ unsignedPsbt, threshold: Number(threshold), keys: JSON.parse(keysJson), scriptType, policyName: policyName || 'HW E2E 2-of-3 Vault' },
		policyHmac
	);
	console.log('SIGNED_PSBT_BASE64=' + signed);
} else {
	console.error('usage: node e2e2-ledger-sign.mjs <precheck-unregistered|device-reject-unregistered|register|sign> ...');
	process.exit(1);
}
