import { describe, it, expect } from 'vitest';
import { HDKey } from '@scure/bip32';
import { walletDescriptors, walletDescriptorBackup } from './walletExport';
import { descriptorChecksum } from './bitcoin/multisig';

// Deterministic account xpub from a fixed seed at the BIP-84 native-segwit path.
// Test-only key, never a real wallet.
function accountXpub(): string {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(0x2a));
	return master.derive("m/84'/0'/0'").publicExtendedKey;
}

describe('walletDescriptors', () => {
	const xpub = accountXpub();

	it('emits wpkh receive/change with a checksum for native segwit', () => {
		const { receive, change } = walletDescriptors({
			name: 'Test',
			xpub,
			scriptType: 'p2wpkh',
			masterFingerprint: 'd34db33f',
			derivationPath: "m/84'/0'/0'"
		});
		// Origin is h-hardened and lowercased; branch is /0/* (receive), /1/* (change).
		expect(receive).toBe(`wpkh([d34db33f/84h/0h/0h]${xpub}/0/*)#${descriptorChecksum(`wpkh([d34db33f/84h/0h/0h]${xpub}/0/*)`)}`);
		expect(receive).toContain('/0/*)#');
		expect(change).toContain('/1/*)#');
		expect(change.startsWith('wpkh([d34db33f/84h/0h/0h]')).toBe(true);
	});

	it('wraps each script type correctly', () => {
		const base = { name: 'w', xpub, masterFingerprint: null, derivationPath: null } as const;
		expect(walletDescriptors({ ...base, scriptType: 'p2pkh' }).receive.startsWith('pkh(')).toBe(true);
		expect(
			walletDescriptors({ ...base, scriptType: 'p2sh-p2wpkh' }).receive.startsWith('sh(wpkh(')
		).toBe(true);
		expect(walletDescriptors({ ...base, scriptType: 'p2wpkh' }).receive.startsWith('wpkh(')).toBe(true);
		expect(walletDescriptors({ ...base, scriptType: 'p2tr' }).receive.startsWith('tr(')).toBe(true);
	});

	it('omits the [origin] bracket when the fingerprint is unknown', () => {
		const { receive } = walletDescriptors({
			name: 'w',
			xpub,
			scriptType: 'p2wpkh',
			masterFingerprint: null,
			derivationPath: null
		});
		expect(receive.startsWith(`wpkh(${xpub}/0/*)`)).toBe(true);
		expect(receive).not.toContain('[');
	});

	it('falls back to the script-type default path when none is stored', () => {
		const { receive } = walletDescriptors({
			name: 'w',
			xpub,
			scriptType: 'p2wpkh',
			masterFingerprint: 'abcd1234',
			derivationPath: null
		});
		// p2wpkh default origin is m/84'/0'/0' → 84h/0h/0h.
		expect(receive).toContain('[abcd1234/84h/0h/0h]');
	});

	it('validates each emitted descriptor against its own checksum', () => {
		const { receive, change } = walletDescriptors({
			name: 'w',
			xpub,
			scriptType: 'p2wpkh',
			masterFingerprint: 'd34db33f',
			derivationPath: "m/84'/0'/0'"
		});
		for (const d of [receive, change]) {
			const [body, sum] = d.split('#');
			expect(sum).toBe(descriptorChecksum(body));
		}
	});
});

describe('walletDescriptorBackup', () => {
	it('includes both branches and the friendly can-not-spend note', () => {
		const txt = walletDescriptorBackup({
			name: 'My wallet',
			xpub: accountXpub(),
			scriptType: 'p2wpkh',
			masterFingerprint: 'd34db33f',
			derivationPath: "m/84'/0'/0'"
		});
		expect(txt).toContain('Cairn wallet backup — "My wallet"');
		expect(txt).toContain('Receive (external) descriptor:');
		expect(txt).toContain('Change (internal) descriptor:');
		expect(txt).toContain('cannot spend');
	});
});
