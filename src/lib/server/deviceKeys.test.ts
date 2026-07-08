// Known-device-keys registry tests (cairn-fdlf.2), plus the single-sig-wizard
// BIP-45 prefetch write path (cairn-fdlf.1). The load-bearing assertions are
// the purpose-separation invariants: single-sig ('44'/'49'/'84'/'86'),
// personal-multisig ('48'), and collaborative-vault ('45') rows for the SAME
// device must live as strictly separate entries that no read can cross.

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import {
	rememberDeviceKey,
	rememberPrefetchedSharedKey,
	getDeviceKey,
	listDeviceKeys,
	deleteDeviceKey,
	purposeFromPath,
	singleSigPurposeFor,
	DeviceKeyError,
	SINGLE_SIG_PURPOSES,
	MULTISIG_PURPOSES,
	type DeviceKeyPurpose
} from './deviceKeys';

// Public test vectors — never real wallets. The registry validates only the
// extended-key SHAPE (78-byte base58check), so one key per prefix family is
// enough to stand in for any purpose.
const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const XPUB =
	'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8';

const FP = '73c5da0a';
const FP2 = 'deadbeef';

function wipe(): void {
	db.exec('DELETE FROM device_keys; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;');
}

let userId: number;
let otherUserId: number;

beforeEach(async () => {
	wipe();
	setSetting('registration_mode', 'open');
	userId = (
		await registerUser({
			email: 'keys@example.com',
			password: 'correct horse battery',
			displayName: 'keys'
		})
	).id;
	otherUserId = (
		await registerUser({
			email: 'other@example.com',
			password: 'correct horse battery',
			displayName: 'other'
		})
	).id;
});

// ---------------------------------------------------------------- purposes

describe('purposeFromPath', () => {
	it('maps canonical origin paths to their purpose', () => {
		expect(purposeFromPath("m/45'")).toBe('45');
		expect(purposeFromPath("m/48'/0'/0'/2'")).toBe('48');
		expect(purposeFromPath("m/84'/0'/0'")).toBe('84');
		expect(purposeFromPath("84h/0h/0h")).toBe('84'); // h-markers + no m/ prefix
		expect(purposeFromPath("m/44'/0'/3'")).toBe('44');
	});

	it('returns null for malformed, unhardened, or unknown-purpose paths', () => {
		expect(purposeFromPath('')).toBeNull();
		expect(purposeFromPath('m')).toBeNull();
		expect(purposeFromPath('m/84/0/0')).toBeNull(); // purpose level not hardened
		expect(purposeFromPath("m/99'/0'/0'")).toBeNull(); // not in the closed enum
		expect(purposeFromPath('four score')).toBeNull();
	});
});

describe('singleSigPurposeFor', () => {
	it('mirrors the BIP purpose per script type', () => {
		expect(singleSigPurposeFor('p2pkh')).toBe('44');
		expect(singleSigPurposeFor('p2sh-p2wpkh')).toBe('49');
		expect(singleSigPurposeFor('p2wpkh')).toBe('84');
		expect(singleSigPurposeFor('p2tr')).toBe('86');
	});
});

// -------------------------------------------------------------------- CRUD

describe('rememberDeviceKey', () => {
	it('stores a row and reads it back exactly', () => {
		const rec = rememberDeviceKey(userId, {
			fingerprint: FP,
			purpose: '45',
			xpub: XPUB,
			path: "m/45'",
			deviceType: 'trezor'
		});
		expect(rec.fingerprint).toBe(FP);
		expect(rec.purpose).toBe('45');
		expect(rec.xpub).toBe(XPUB);
		expect(rec.path).toBe("m/45'");
		expect(rec.deviceType).toBe('trezor');
		expect(rec.shareOptIn).toBe(false); // default OFF (cairn-fdlf.3)

		expect(getDeviceKey(userId, FP, '45')).toEqual(rec);
	});

	it('normalizes fingerprint case and path markers', () => {
		const rec = rememberDeviceKey(userId, {
			fingerprint: 'DEADBEEF',
			purpose: '84',
			xpub: ZPUB,
			path: '84h/0h/0h'
		});
		expect(rec.fingerprint).toBe('deadbeef');
		expect(rec.path).toBe("m/84'/0'/0'");
	});

	it('upserts in place on (user, fingerprint, purpose) — never duplicates', () => {
		rememberDeviceKey(userId, { fingerprint: FP, purpose: '84', xpub: ZPUB, path: "m/84'/0'/0'" });
		const updated = rememberDeviceKey(userId, {
			fingerprint: FP,
			purpose: '84',
			xpub: ZPUB,
			path: "m/84'/0'/1'", // a later account read refreshes the row
			deviceType: 'ledger'
		});
		expect(updated.path).toBe("m/84'/0'/1'");
		expect(updated.deviceType).toBe('ledger');
		expect(listDeviceKeys(userId, ['84'])).toHaveLength(1);
	});

	it('ratchets shareOptIn on and never silently off', () => {
		rememberDeviceKey(userId, {
			fingerprint: FP,
			purpose: '84',
			xpub: ZPUB,
			path: "m/84'/0'/0'",
			shareOptIn: true
		});
		// A later write that omits the flag must not revoke the explicit opt-in.
		const rec = rememberDeviceKey(userId, {
			fingerprint: FP,
			purpose: '84',
			xpub: ZPUB,
			path: "m/84'/0'/0'"
		});
		expect(rec.shareOptIn).toBe(true);
	});

	it('rejects bad fingerprints, unknown purposes, bad paths, and bad xpubs', () => {
		const good = { fingerprint: FP, purpose: '45', xpub: XPUB, path: "m/45'" } as const;
		expect(() => rememberDeviceKey(userId, { ...good, fingerprint: '00000000' })).toThrow(
			DeviceKeyError
		);
		expect(() => rememberDeviceKey(userId, { ...good, fingerprint: 'xyz' })).toThrow(DeviceKeyError);
		expect(() => rememberDeviceKey(userId, { ...good, purpose: '99' })).toThrow(DeviceKeyError);
		expect(() => rememberDeviceKey(userId, { ...good, purpose: 'multisig' })).toThrow(
			DeviceKeyError
		);
		expect(() => rememberDeviceKey(userId, { ...good, path: 'not a path' })).toThrow(DeviceKeyError);
		expect(() => rememberDeviceKey(userId, { ...good, xpub: 'zpub-not-a-key' })).toThrow(
			DeviceKeyError
		);
		expect(listDeviceKeys(userId, [...SINGLE_SIG_PURPOSES, ...MULTISIG_PURPOSES])).toEqual([]);
	});
});

// -------------------------------------------------- purpose-separation invariant

describe('purpose separation (the never-conflate invariant)', () => {
	it("refuses to store a key whose path doesn't live under its declared purpose", () => {
		// A single-sig path labeled as the collaborative purpose (or vice versa)
		// is exactly the mislabeling that would poison later lookups.
		expect(() =>
			rememberDeviceKey(userId, { fingerprint: FP, purpose: '45', xpub: ZPUB, path: "m/84'/0'/0'" })
		).toThrow(DeviceKeyError);
		expect(() =>
			rememberDeviceKey(userId, { fingerprint: FP, purpose: '84', xpub: XPUB, path: "m/45'" })
		).toThrow(DeviceKeyError);
		expect(() =>
			rememberDeviceKey(userId, { fingerprint: FP, purpose: '48', xpub: XPUB, path: "m/45'" })
		).toThrow(DeviceKeyError);
	});

	it('keeps single-sig, BIP-48, and BIP-45 rows for the SAME device separate', () => {
		rememberDeviceKey(userId, { fingerprint: FP, purpose: '84', xpub: ZPUB, path: "m/84'/0'/0'" });
		rememberDeviceKey(userId, {
			fingerprint: FP,
			purpose: '48',
			xpub: XPUB,
			path: "m/48'/0'/0'/2'"
		});
		rememberDeviceKey(userId, { fingerprint: FP, purpose: '45', xpub: XPUB, path: "m/45'" });

		// Three independent rows…
		expect(listDeviceKeys(userId, ['84', '48', '45'])).toHaveLength(3);
		// …and every purpose-scoped read returns ONLY its own family.
		expect(getDeviceKey(userId, FP, '84')?.path).toBe("m/84'/0'/0'");
		expect(getDeviceKey(userId, FP, '48')?.path).toBe("m/48'/0'/0'/2'");
		expect(getDeviceKey(userId, FP, '45')?.path).toBe("m/45'");
		expect(listDeviceKeys(userId, ['45']).map((r) => r.purpose)).toEqual(['45']);
		expect(
			listDeviceKeys(userId, [...SINGLE_SIG_PURPOSES]).every((r) =>
				(SINGLE_SIG_PURPOSES as readonly string[]).includes(r.purpose)
			)
		).toBe(true);
	});

	it('refuses vague reads — callers must name the purpose(s)', () => {
		rememberDeviceKey(userId, { fingerprint: FP, purpose: '45', xpub: XPUB, path: "m/45'" });
		expect(() => listDeviceKeys(userId, [])).toThrow(DeviceKeyError);
		expect(() => listDeviceKeys(userId, ['bogus' as DeviceKeyPurpose])).toThrow(DeviceKeyError);
		expect(getDeviceKey(userId, FP, 'bogus' as DeviceKeyPurpose)).toBeNull();
	});
});

// ------------------------------------------------------------ scoping + delete

describe('scoping and deletion', () => {
	it("never returns another user's rows", () => {
		rememberDeviceKey(userId, { fingerprint: FP, purpose: '45', xpub: XPUB, path: "m/45'" });
		expect(getDeviceKey(otherUserId, FP, '45')).toBeNull();
		expect(listDeviceKeys(otherUserId, ['45'])).toEqual([]);
		expect(deleteDeviceKey(otherUserId, FP, '45')).toBe(false);
		expect(getDeviceKey(userId, FP, '45')).not.toBeNull();
	});

	it('deleteDeviceKey removes exactly one (fingerprint, purpose) row', () => {
		rememberDeviceKey(userId, { fingerprint: FP, purpose: '45', xpub: XPUB, path: "m/45'" });
		rememberDeviceKey(userId, { fingerprint: FP, purpose: '84', xpub: ZPUB, path: "m/84'/0'/0'" });
		rememberDeviceKey(userId, { fingerprint: FP2, purpose: '45', xpub: XPUB, path: "m/45'" });

		expect(deleteDeviceKey(userId, FP, '45')).toBe(true);
		expect(getDeviceKey(userId, FP, '45')).toBeNull();
		expect(getDeviceKey(userId, FP, '84')).not.toBeNull(); // other purpose survives
		expect(getDeviceKey(userId, FP2, '45')).not.toBeNull(); // other device survives
		expect(deleteDeviceKey(userId, FP, '45')).toBe(false); // already gone
	});

	it('cascades away with the user', () => {
		rememberDeviceKey(userId, { fingerprint: FP, purpose: '45', xpub: XPUB, path: "m/45'" });
		db.prepare('DELETE FROM users WHERE id = ?').run(userId);
		const { n } = db
			.prepare('SELECT COUNT(*) AS n FROM device_keys WHERE user_id = ?')
			.get(userId) as { n: number };
		expect(n).toBe(0);
	});
});

// ---------------------------------------- cairn-fdlf.1: wizard prefetch write path

describe('rememberPrefetchedSharedKey (single-sig wizard BIP-45 prefetch)', () => {
	const shared = { fingerprint: FP, xpub: XPUB, path: "m/45'" };
	const primary = { fingerprint: FP, xpub: ZPUB, path: "m/84'/0'/0'" };

	it('stores the m/45\' key as a "45" row with the sharing opt-in recorded', () => {
		const res = rememberPrefetchedSharedKey(userId, { shared, deviceType: 'trezor' });
		expect(res.shared.purpose).toBe('45');
		expect(res.shared.shareOptIn).toBe(true);
		expect(res.shared.deviceType).toBe('trezor');
		expect(getDeviceKey(userId, FP, '45')?.xpub).toBe(XPUB);
	});

	it('also records the primary single-sig key from the same read, under ITS purpose', () => {
		const res = rememberPrefetchedSharedKey(userId, { shared, primary, deviceType: 'ledger' });
		expect(res.primary?.purpose).toBe('84');
		expect(res.primary?.shareOptIn).toBe(true); // the user explicitly opted in
		// Two rows, two purposes — the single-sig wallet's own records are untouched
		// (this registry has no link to the wallets table at all).
		expect(listDeviceKeys(userId, ['84', '45'])).toHaveLength(2);
	});

	it("rejects a 'shared' key that is not actually BIP-45", () => {
		expect(() =>
			rememberPrefetchedSharedKey(userId, {
				shared: { fingerprint: FP, xpub: ZPUB, path: "m/84'/0'/0'" }
			})
		).toThrow(DeviceKeyError);
		expect(listDeviceKeys(userId, [...SINGLE_SIG_PURPOSES, ...MULTISIG_PURPOSES])).toEqual([]);
	});

	it('skips an unusable primary without losing the sharing key (fail-soft)', () => {
		const res = rememberPrefetchedSharedKey(userId, {
			shared,
			primary: { fingerprint: FP, xpub: ZPUB, path: "m/45'" } // not a single-sig path
		});
		expect(res.primary).toBeNull();
		expect(res.shared.purpose).toBe('45');
		const res2 = rememberPrefetchedSharedKey(userId, {
			shared,
			primary: { fingerprint: 'garbage!', xpub: ZPUB, path: "m/84'/0'/0'" }
		});
		expect(res2.primary).toBeNull();
		expect(getDeviceKey(userId, FP, '45')).not.toBeNull();
	});

	it('re-running the prefetch upserts rather than duplicating', () => {
		rememberPrefetchedSharedKey(userId, { shared, primary });
		rememberPrefetchedSharedKey(userId, { shared, primary });
		expect(listDeviceKeys(userId, ['84', '45'])).toHaveLength(2);
	});
});
