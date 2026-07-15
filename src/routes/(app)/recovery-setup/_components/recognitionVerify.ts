// Recognition-based backup verification (R4, docs/UX-PSYCHOLOGY-RESEARCH-2026-07-15.md
// F7 — CHI 2021, Voskobojnikov et al., "The U in Crypto Stands for Usable"). The
// recovery-phrase moment is the self-custody anxiety peak, and a RECALL quiz
// ("type word #7 from memory") punishes and stalls exactly the users who most
// need confidence, not more friction. A RECOGNITION quiz — pick the word you
// just wrote down, among a few decoys — checks the same thing (did you actually
// capture this word, in order) with far less friction, and it's what the
// research recommends in place of recall.
//
// Pure and side-effect free so the distractor logic is unit-testable without
// mounting the wizard component (mirrors wizardProgress.ts's pattern of keeping
// resumable state logic out of the .svelte file).

/** A small, fixed pool of genuine BIP39 words, used only as multiple-choice
 *  decoys. Deliberately NOT the full 2048-word list (that lives server-side
 *  only, in $lib/server/recovery.ts) — the client bundle has no other use for
 *  a wordlist, so a ~80-word sample keeps this module tiny while still reading
 *  as "a real word", not an obviously-fake option. */
const DECOY_POOL: readonly string[] = [
	'about', 'adjust', 'allow', 'antenna', 'artefact', 'avoid', 'basket', 'bind',
	'bonus', 'broken', 'cabbage', 'carpet', 'chalk', 'cinnamon', 'club', 'consider',
	'crash', 'culture', 'december', 'design', 'discover', 'dragon', 'early', 'embark',
	'enter', 'excess', 'faculty', 'feel', 'fitness', 'force', 'funny', 'genuine',
	'good', 'guide', 'height', 'horse', 'ill', 'inject', 'jaguar', 'kid',
	'latin', 'letter', 'lonely', 'man', 'measure', 'minimum', 'mother', 'nation',
	'nose', 'office', 'original', 'panther', 'pepper', 'plastic', 'powder', 'proof',
	'quarter', 'raw', 'remember', 'rhythm', 'room', 'sample', 'season', 'shed',
	'silent', 'slide', 'solid', 'spike', 'stay', 'submit', 'swamp', 'tattoo',
	'thumb', 'tonight', 'tray', 'turn', 'unknown', 'valve', 'vintage', 'warrior',
	'whip', 'work'
];

export interface VerifyQuestion {
	/** 1-indexed position in the phrase (matches the word-number chips already
	 *  shown during reveal, so "Word #4" points at the same thing the user saw). */
	position: number;
	correctWord: string;
	/** correctWord plus decoys, already shuffled — render in this order. */
	options: string[];
}

/** Fisher-Yates using an injected RNG so callers (tests) get determinism. */
function shuffled<T>(items: readonly T[], rng: () => number): T[] {
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/**
 * Build `count` recognition questions from a revealed phrase.
 *
 * - Positions are chosen without repeats, order randomized via `rng`.
 * - `count` is clamped to `words.length` (can't ask about a position twice).
 * - Each question's options are the real word plus `optionsPerQuestion - 1`
 *   decoys drawn from DECOY_POOL, case-insensitively filtered so a decoy can
 *   never equal the correct word — the one invariant that must hold for every
 *   question regardless of which real BIP39 word landed in the phrase (some
 *   phrase words may themselves be in DECOY_POOL; the filter runs per-question
 *   against that question's own correct word, not against the whole phrase).
 * - `rng` defaults to Math.random but accepts a seeded generator so tests are
 *   deterministic; the same (words, count, rng) always produces the same
 *   positions, decoys and shuffle order.
 */
export function buildVerifyQuestions(
	words: readonly string[],
	count = 3,
	rng: () => number = Math.random,
	optionsPerQuestion = 4
): VerifyQuestion[] {
	const n = Math.max(0, Math.min(count, words.length));
	if (n === 0) return [];

	const positions = shuffled(
		Array.from({ length: words.length }, (_, i) => i),
		rng
	).slice(0, n);
	// Ask about earlier words first — reads as a natural pass over the phrase
	// rather than a scrambled order, even though which positions were picked
	// is randomized.
	positions.sort((a, b) => a - b);

	return positions.map((pos) => {
		const correctWord = words[pos];
		const decoyCandidates = DECOY_POOL.filter(
			(w) => w.toLowerCase() !== correctWord.toLowerCase()
		);
		const decoys = shuffled(decoyCandidates, rng).slice(0, Math.max(0, optionsPerQuestion - 1));
		const options = shuffled([correctWord, ...decoys], rng);
		return { position: pos + 1, correctWord, options };
	});
}
