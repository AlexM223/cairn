// Session-scoped persistence for the welcome-aboard tour (cairn-sr5ry),
// mirroring the multisig wizard's snapshot pattern (src/routes/(app)/wallets/
// multisig/new/_components/wizardProgress.ts) at a fraction of the weight:
// the only state worth keeping across a reload is which step the reader was
// on. On Umbrel, app_proxy's auth layer can force a reload mid-tour — losing
// the page a new crew member was reading in their very first minute on the
// instance is exactly the wrong first impression.
//
// Nothing sensitive is ever stored: a step name and a timestamp.

export const WELCOME_PROGRESS_KEY = 'cairn.welcome-aboard.v1';

/** A resume older than this is a forgotten tab, not a reload — start fresh. */
export const WELCOME_PROGRESS_MAX_AGE_MS = 60 * 60 * 1000;

// 'done' is terminal and never saved — finishing the tour clears the snapshot.
export const WELCOME_STEPS = ['aboard', 'view', 'notify', 'begin'] as const;
export type WelcomeStepKey = (typeof WELCOME_STEPS)[number];

export interface WelcomeProgress {
	step: WelcomeStepKey;
	savedAt: number;
}

/**
 * Parse a stored snapshot. Returns null for anything unusable — malformed
 * JSON, a stale save, an unknown step — so a bad snapshot can never wedge
 * the tour; it just starts from the first step.
 */
export function parseSavedWelcomeProgress(raw: string | null, now: number): WelcomeProgress | null {
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
	if (now - o.savedAt > WELCOME_PROGRESS_MAX_AGE_MS || o.savedAt > now) return null;
	if (typeof o.step !== 'string' || !WELCOME_STEPS.includes(o.step as WelcomeStepKey)) return null;
	return { step: o.step as WelcomeStepKey, savedAt: o.savedAt };
}
