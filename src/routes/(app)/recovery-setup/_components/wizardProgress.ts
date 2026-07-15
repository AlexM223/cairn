// Session-scoped RESUME POSITION for the account-recovery-setup wizard (R4,
// docs/UX-PSYCHOLOGY-RESEARCH-2026-07-15.md). Mirrors the pattern in
// src/routes/(app)/wallets/new/_components/wizardProgress.ts and
// src/routes/(app)/wallets/multisig/new/_components/wizardProgress.ts: a
// full-page reload (Umbrel's app_proxy auth layer can force one mid-wizard)
// used to silently drop the user back to the very first screen with no
// explanation.
//
// SECURITY: unlike those two wizards, the sensitive payload here (the 12-word
// phrase, the 8 recovery codes) is a **secret**, not a public key — it must
// NEVER be written to sessionStorage/localStorage. This module persists only
// which SCREEN the user was on, nothing they typed or were shown. A resume
// into the phrase step always lands back on the calm "stakes" explainer, not
// mid-reveal or mid-verify — the actual words can't survive a reload by
// design, so re-earning them via the explain screen is the only honest
// resume, not a gap in this feature.
export const WIZARD_PROGRESS_KEY = 'cairn.recovery-setup-wizard.v1';

/** A resume older than this is stale — likely a forgotten tab, not a reload. */
export const WIZARD_PROGRESS_MAX_AGE_MS = 60 * 60 * 1000;

const STEPS = ['phrase', 'codes'] as const;
export type WizardResumeStep = (typeof STEPS)[number];

export interface WizardProgress {
	/** 'done' is intentionally never saved — a finished wizard clears the
	 *  snapshot outright, same as the other two wizards. */
	step: WizardResumeStep;
	savedAt: number;
}

/**
 * Parse a stored snapshot back into a resume position. Returns null for
 * anything unusable — malformed JSON, a stale save, an unknown step — so a
 * bad snapshot can never wedge the wizard; it just starts fresh at 'phrase'.
 */
export function parseSavedProgress(raw: string | null, now: number): WizardProgress | null {
	if (!raw) return null;

	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof v !== 'object' || v === null) return null;
	const o = v as Record<string, unknown>;

	if (typeof o.savedAt !== 'number' || !Number.isFinite(o.savedAt)) return null;
	if (now - o.savedAt > WIZARD_PROGRESS_MAX_AGE_MS || o.savedAt > now) return null;

	if (typeof o.step !== 'string' || !STEPS.includes(o.step as WizardResumeStep)) return null;

	return { step: o.step as WizardResumeStep, savedAt: o.savedAt };
}

/** True when a snapshot is worth telling the user about — i.e. it isn't just
 *  the default first screen. */
export function hasMeaningfulProgress(p: WizardProgress): boolean {
	return p.step === 'codes';
}
