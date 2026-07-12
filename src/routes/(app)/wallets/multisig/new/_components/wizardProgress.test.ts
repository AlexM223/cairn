import { describe, it, expect } from 'vitest';
import {
	parseSavedMultisigProgress,
	hasMeaningfulMultisigProgress,
	WIZARD_PROGRESS_KEY,
	WIZARD_PROGRESS_MAX_AGE_MS,
	type WizardProgress
} from './wizardProgress';

const NOW = 1_700_000_000_000;

function key(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: 'My Trezor',
		category: 'hardware',
		deviceType: 'trezor',
		xpub: 'Zpub74a…',
		fingerprint: '73c5da0a',
		path: "m/48'/0'/0'/2'",
		...overrides
	};
}

// A snapshot as the wizard writes it mid-flow: on the Keys step, one of two
// keys collected for a 2-of-2 personal vault.
function validSnapshot(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		step: 'keys',
		preset: 'custom',
		customM: 2,
		customN: 2,
		scriptType: 'p2wsh',
		keys: [key()],
		vaultMode: 'personal',
		configImported: false,
		importedStartIndex: 0,
		multisigName: '',
		savedAt: NOW - 5_000,
		...overrides
	});
}

describe('parseSavedMultisigProgress', () => {
	it('uses a v1 storage key, distinct from the single-sig wizard', () => {
		expect(WIZARD_PROGRESS_KEY).toBe('cairn.multisig-wizard.v1');
	});

	it('round-trips a fresh Keys-step snapshot', () => {
		const p = parseSavedMultisigProgress(validSnapshot(), NOW);
		expect(p).not.toBeNull();
		expect(p!.step).toBe('keys');
		expect(p!.vaultMode).toBe('personal');
		expect(p!.keys).toHaveLength(1);
		expect(p!.keys[0].fingerprint).toBe('73c5da0a');
	});

	it('returns null for missing, empty, or malformed input', () => {
		expect(parseSavedMultisigProgress(null, NOW)).toBeNull();
		expect(parseSavedMultisigProgress('', NOW)).toBeNull();
		expect(parseSavedMultisigProgress('not json{', NOW)).toBeNull();
		expect(parseSavedMultisigProgress('"a string"', NOW)).toBeNull();
		expect(parseSavedMultisigProgress('42', NOW)).toBeNull();
		expect(parseSavedMultisigProgress('null', NOW)).toBeNull();
	});

	it('rejects a stale snapshot (older than the max age)', () => {
		const stale = validSnapshot({ savedAt: NOW - WIZARD_PROGRESS_MAX_AGE_MS - 1 });
		expect(parseSavedMultisigProgress(stale, NOW)).toBeNull();
	});

	it('rejects a snapshot from the future (clock weirdness)', () => {
		expect(parseSavedMultisigProgress(validSnapshot({ savedAt: NOW + 60_000 }), NOW)).toBeNull();
	});

	it('rejects a snapshot without a valid savedAt', () => {
		expect(parseSavedMultisigProgress(validSnapshot({ savedAt: 'yesterday' }), NOW)).toBeNull();
		const noStamp = JSON.parse(validSnapshot()) as Record<string, unknown>;
		delete noStamp.savedAt;
		expect(parseSavedMultisigProgress(JSON.stringify(noStamp), NOW)).toBeNull();
	});

	it('rejects an unknown step outright', () => {
		expect(parseSavedMultisigProgress(validSnapshot({ step: 'done' }), NOW)).toBeNull();
		expect(parseSavedMultisigProgress(validSnapshot({ step: 'nonsense' }), NOW)).toBeNull();
		expect(parseSavedMultisigProgress(validSnapshot({ step: 3 }), NOW)).toBeNull();
	});

	it('accepts every resumable step', () => {
		for (const step of ['learn', 'quorum', 'keys', 'review', 'confirm']) {
			// review/confirm need a full quorum to not get clamped in this fixture
			// (customM/customN = 2/2, one key) — use 'keys' data as-is for those
			// two and expect the clamp, tested separately below.
			const p = parseSavedMultisigProgress(validSnapshot({ step }), NOW);
			expect(p).not.toBeNull();
		}
	});

	// MULTISIG-UX-DESIGN M2 split the old single 'why' step (education +
	// quorum picker on one screen) into 'learn' (education) then 'quorum'
	// (the picker). A snapshot saved by the pre-M2 wizard still has
	// `step: "why"` on disk under the same WIZARD_PROGRESS_KEY — it must
	// resume onto 'quorum' (the screen that actually owns the technical
	// choice the rest of the snapshot describes) instead of being discarded,
	// so a paused mid-key-collection session survives the M2 deploy.
	it('maps a legacy "why" step (pre-M2 snapshot) onto "quorum" instead of rejecting it', () => {
		const p = parseSavedMultisigProgress(validSnapshot({ step: 'why' }), NOW);
		expect(p).not.toBeNull();
		expect(p!.step).toBe('quorum');
		expect(p!.keys).toHaveLength(1); // no data lost in the translation
	});

	it('rejects an invalid quorum (preset/customM/customN/scriptType) outright — never clamps it', () => {
		expect(parseSavedMultisigProgress(validSnapshot({ preset: 'bogus' }), NOW)).toBeNull();
		expect(parseSavedMultisigProgress(validSnapshot({ customM: 1.5 }), NOW)).toBeNull();
		expect(parseSavedMultisigProgress(validSnapshot({ customM: 'two' }), NOW)).toBeNull();
		expect(parseSavedMultisigProgress(validSnapshot({ customM: 5, customN: 3 }), NOW)).toBeNull(); // M > N
		expect(parseSavedMultisigProgress(validSnapshot({ customN: 20 }), NOW)).toBeNull(); // > 15 max
		expect(parseSavedMultisigProgress(validSnapshot({ scriptType: 'p2tr' }), NOW)).toBeNull();
	});

	it('rejects the whole snapshot if any cosigner key fails to shape-check (never filters)', () => {
		const badFingerprint = parseSavedMultisigProgress(
			validSnapshot({ keys: [key(), key({ fingerprint: 'NOT-HEX!' })] }),
			NOW
		);
		expect(badFingerprint).toBeNull();

		const badCategory = parseSavedMultisigProgress(
			validSnapshot({ keys: [key({ category: 'telepathy' })] }),
			NOW
		);
		expect(badCategory).toBeNull();

		const badPath = parseSavedMultisigProgress(
			validSnapshot({ keys: [key({ path: 'sideways' })] }),
			NOW
		);
		expect(badPath).toBeNull();

		const emptyXpub = parseSavedMultisigProgress(validSnapshot({ keys: [key({ xpub: '' })] }), NOW);
		expect(emptyXpub).toBeNull();

		const notAnArray = parseSavedMultisigProgress(validSnapshot({ keys: 'nope' }), NOW);
		expect(notAnArray).toBeNull();
	});

	it('accepts a null deviceType on a cosigner key (generic file-signing fallback)', () => {
		const p = parseSavedMultisigProgress(validSnapshot({ keys: [key({ deviceType: null })] }), NOW);
		expect(p).not.toBeNull();
		expect(p!.keys[0].deviceType).toBeNull();
	});

	it('clamps Review/Confirm back to Keys when the key count no longer matches the quorum total', () => {
		// customN: 2 but only one key collected — a normal mid-flow state.
		const review = parseSavedMultisigProgress(validSnapshot({ step: 'review' }), NOW);
		expect(review!.step).toBe('keys');
		expect(review!.keys).toHaveLength(1); // keys are kept, not discarded

		const confirm = parseSavedMultisigProgress(validSnapshot({ step: 'confirm' }), NOW);
		expect(confirm!.step).toBe('keys');
	});

	it('does not clamp Review/Confirm when the key count matches the quorum total', () => {
		const twoKeys = validSnapshot({ step: 'review', keys: [key(), key({ fingerprint: 'aabbccdd' })] });
		const p = parseSavedMultisigProgress(twoKeys, NOW);
		expect(p!.step).toBe('review');
	});

	it('accepts an explicit null vaultMode (question never asked, e.g. an import)', () => {
		const p = parseSavedMultisigProgress(validSnapshot({ vaultMode: null }), NOW);
		expect(p!.vaultMode).toBeNull();
	});

	it('rejects a garbage vaultMode rather than silently nulling it', () => {
		expect(parseSavedMultisigProgress(validSnapshot({ vaultMode: 'both' }), NOW)).toBeNull();
	});

	it('rejects a non-boolean configImported and a malformed importedStartIndex', () => {
		expect(parseSavedMultisigProgress(validSnapshot({ configImported: 'yes' }), NOW)).toBeNull();
		expect(parseSavedMultisigProgress(validSnapshot({ importedStartIndex: -1 }), NOW)).toBeNull();
		expect(parseSavedMultisigProgress(validSnapshot({ importedStartIndex: 1.5 }), NOW)).toBeNull();
		expect(parseSavedMultisigProgress(validSnapshot({ importedStartIndex: 'zero' }), NOW)).toBeNull();
	});

	it('defaults a missing/non-string multisigName to empty rather than rejecting', () => {
		const noName = JSON.parse(validSnapshot()) as Record<string, unknown>;
		delete noName.multisigName;
		const p = parseSavedMultisigProgress(JSON.stringify(noName), NOW);
		expect(p!.multisigName).toBe('');
	});
});

describe('hasMeaningfulMultisigProgress', () => {
	function progress(overrides: Partial<WizardProgress>): WizardProgress {
		return {
			step: 'learn',
			preset: '2of3',
			customM: 2,
			customN: 3,
			scriptType: 'p2wsh',
			keys: [],
			vaultMode: null,
			configImported: false,
			importedStartIndex: 0,
			multisigName: '',
			savedAt: NOW,
			...overrides
		};
	}

	it('is false on the Learn step with untouched defaults', () => {
		expect(hasMeaningfulMultisigProgress(progress({}))).toBe(false);
	});

	it('is true once past the Learn step', () => {
		expect(hasMeaningfulMultisigProgress(progress({ step: 'quorum' }))).toBe(true);
		expect(hasMeaningfulMultisigProgress(progress({ step: 'keys' }))).toBe(true);
		expect(hasMeaningfulMultisigProgress(progress({ step: 'review' }))).toBe(true);
		expect(hasMeaningfulMultisigProgress(progress({ step: 'confirm' }))).toBe(true);
	});

	it('is true once the quorum choice deviates from the default preset', () => {
		expect(hasMeaningfulMultisigProgress(progress({ preset: '3of5' }))).toBe(true);
		expect(hasMeaningfulMultisigProgress(progress({ preset: 'custom', customM: 4, customN: 7 }))).toBe(
			true
		);
		expect(hasMeaningfulMultisigProgress(progress({ scriptType: 'p2sh' }))).toBe(true);
	});

	it('is true once a key is added or a vault mode is chosen, even while still on Learn', () => {
		expect(
			hasMeaningfulMultisigProgress(
				progress({
					keys: [
						{
							name: 'x',
							category: 'hardware',
							deviceType: 'trezor',
							xpub: 'z',
							fingerprint: '73c5da0a',
							path: "m/48'/0'/0'/2'"
						}
					]
				})
			)
		).toBe(true);
		expect(hasMeaningfulMultisigProgress(progress({ vaultMode: 'personal' }))).toBe(true);
	});

	it('is true once a name has been typed', () => {
		expect(hasMeaningfulMultisigProgress(progress({ multisigName: 'Family Vault' }))).toBe(true);
		expect(hasMeaningfulMultisigProgress(progress({ multisigName: '   ' }))).toBe(false);
	});
});
