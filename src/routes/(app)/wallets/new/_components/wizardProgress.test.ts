import { describe, it, expect } from 'vitest';
import {
	parseSavedProgress,
	hasMeaningfulProgress,
	WIZARD_PROGRESS_KEY,
	WIZARD_PROGRESS_MAX_AGE_MS,
	type WizardProgress
} from './wizardProgress';

const NOW = 1_700_000_000_000;

// A snapshot as the wizard writes it after a successful key validation: the
// user is on the Verify step with a server-validated zpub in hand.
function validSnapshot(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		step: 1,
		method: 'paste',
		readMethod: 'paste',
		deviceType: null,
		xpubInput: 'zpub6rFR7y4Q2AijBEqTUquhVz…',
		validatedXpub: 'zpub6rFR7y4Q2AijBEqTUquhVz…',
		preview: [
			{ address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', path: '0/0' },
			{ address: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g', path: '0/1' }
		],
		scriptType: 'p2wpkh',
		name: '',
		keyFingerprint: '73c5da0a',
		keyPath: "m/84'/0'/0'",
		savedAt: NOW - 5_000,
		...overrides
	});
}

describe('parseSavedProgress', () => {
	it('uses a v2 storage key — v1 snapshots (6-step numbering) never load', () => {
		// The v2 bump (cairn-l2pn) is the migration: old snapshots stay under
		// the old key and age out of sessionStorage on their own.
		expect(WIZARD_PROGRESS_KEY).toBe('cairn.add-wallet-wizard.v2');
	});

	it('round-trips a fresh Verify-step snapshot', () => {
		const p = parseSavedProgress(validSnapshot(), NOW);
		expect(p).not.toBeNull();
		expect(p!.step).toBe(1);
		expect(p!.method).toBe('paste');
		expect(p!.scriptType).toBe('p2wpkh');
		expect(p!.preview).toHaveLength(2);
	});

	it('returns null for missing, empty, or malformed input', () => {
		expect(parseSavedProgress(null, NOW)).toBeNull();
		expect(parseSavedProgress('', NOW)).toBeNull();
		expect(parseSavedProgress('not json{', NOW)).toBeNull();
		expect(parseSavedProgress('"a string"', NOW)).toBeNull();
		expect(parseSavedProgress('42', NOW)).toBeNull();
		expect(parseSavedProgress('null', NOW)).toBeNull();
	});

	it('rejects a stale snapshot (older than the max age)', () => {
		const stale = validSnapshot({ savedAt: NOW - WIZARD_PROGRESS_MAX_AGE_MS - 1 });
		expect(parseSavedProgress(stale, NOW)).toBeNull();
	});

	it('rejects a snapshot from the future (clock weirdness)', () => {
		expect(parseSavedProgress(validSnapshot({ savedAt: NOW + 60_000 }), NOW)).toBeNull();
	});

	it('rejects a snapshot without a valid savedAt', () => {
		expect(parseSavedProgress(validSnapshot({ savedAt: 'yesterday' }), NOW)).toBeNull();
		const noStamp = JSON.parse(validSnapshot()) as Record<string, unknown>;
		delete noStamp.savedAt;
		expect(parseSavedProgress(JSON.stringify(noStamp), NOW)).toBeNull();
	});

	it('rejects an unknown step outright', () => {
		// 2 (Finish) is the last saveable step; the Done view is never saved,
		// and v1's steps 3–5 don't exist in the 3-step wizard (cairn-l2pn).
		expect(parseSavedProgress(validSnapshot({ step: 3 }), NOW)).toBeNull();
		expect(parseSavedProgress(validSnapshot({ step: 5 }), NOW)).toBeNull();
		expect(parseSavedProgress(validSnapshot({ step: -1 }), NOW)).toBeNull();
		expect(parseSavedProgress(validSnapshot({ step: 'preview' }), NOW)).toBeNull();
	});

	it('accepts the Finish step', () => {
		const p = parseSavedProgress(validSnapshot({ step: 2 }), NOW);
		expect(p!.step).toBe(2);
	});

	it('clamps Verify/Finish steps back to the Key step when the validated key is missing', () => {
		const noKey = parseSavedProgress(validSnapshot({ validatedXpub: '' }), NOW);
		expect(noKey!.step).toBe(0);

		const noPreview = parseSavedProgress(validSnapshot({ step: 2, preview: [] }), NOW);
		expect(noPreview!.step).toBe(0);

		const noScript = parseSavedProgress(validSnapshot({ scriptType: null }), NOW);
		expect(noScript!.step).toBe(0);
	});

	it('normalizes unknown enum values to null instead of failing', () => {
		const p = parseSavedProgress(
			validSnapshot({ method: 'telepathy', deviceType: 'abacus', scriptType: 'p2wpkh' }),
			NOW
		);
		expect(p!.method).toBeNull();
		expect(p!.deviceType).toBeNull();
		expect(p!.step).toBe(1); // key + preview + scriptType still valid
	});

	it('round-trips the key origin and nulls anything shape-invalid (cairn-alw8)', () => {
		// A well-formed origin survives the reload — losing it would silently
		// produce a wallet that can't hardware-sign.
		const p = parseSavedProgress(validSnapshot(), NOW);
		expect(p!.keyFingerprint).toBe('73c5da0a');
		expect(p!.keyPath).toBe("m/84'/0'/0'");

		// Snapshots from before the field existed, and tampered/garbage values,
		// come back null without invalidating the rest of the snapshot.
		const missing = parseSavedProgress(
			validSnapshot({ keyFingerprint: undefined, keyPath: undefined }),
			NOW
		);
		expect(missing!.keyFingerprint).toBeNull();
		expect(missing!.keyPath).toBeNull();
		expect(missing!.step).toBe(1);

		const garbage = parseSavedProgress(
			validSnapshot({ keyFingerprint: 'NOT-HEX!', keyPath: 'sideways' }),
			NOW
		);
		expect(garbage!.keyFingerprint).toBeNull();
		expect(garbage!.keyPath).toBeNull();
	});

	it('drops malformed preview rows but keeps the good ones', () => {
		const p = parseSavedProgress(
			validSnapshot({
				preview: [
					{ address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', path: '0/0' },
					{ address: 42, path: '0/1' },
					'garbage',
					null
				]
			}),
			NOW
		);
		expect(p!.preview).toHaveLength(1);
		expect(p!.step).toBe(1);
	});
});

describe('hasMeaningfulProgress', () => {
	function progress(overrides: Partial<WizardProgress>): WizardProgress {
		return {
			step: 0,
			method: null,
			readMethod: null,
			deviceType: null,
			xpubInput: '',
			validatedXpub: '',
			preview: [],
			scriptType: null,
			name: '',
			keyFingerprint: null,
			keyPath: null,
			savedAt: NOW,
			...overrides
		};
	}

	it('is false on the Key step with nothing entered', () => {
		expect(hasMeaningfulProgress(progress({ step: 0 }))).toBe(false);
		expect(hasMeaningfulProgress(progress({ step: 0, xpubInput: '   ' }))).toBe(false);
	});

	it('is true once a method is chosen or a key is typed', () => {
		expect(hasMeaningfulProgress(progress({ step: 0, method: 'paste' }))).toBe(true);
		expect(hasMeaningfulProgress(progress({ step: 0, xpubInput: 'zpub…' }))).toBe(true);
	});

	it('is true on the Verify and Finish steps', () => {
		expect(hasMeaningfulProgress(progress({ step: 1 }))).toBe(true);
		expect(hasMeaningfulProgress(progress({ step: 2 }))).toBe(true);
	});
});
