// Year → short historical note for the first-sync screen (Heartwood 1a):
// "Verifying 2017 — SegWit summer". Flavor text keyed off the year of the
// block currently being verified (the tip header's timestamp), not a
// rigorous history — a handful of milestones is the point.
//
// Client-safe (no server imports); consumed by FirstSyncGrowth.svelte.

export const SYNC_YEAR_NOTES: Readonly<Record<number, string>> = {
	2009: 'genesis — the first ring',
	2010: 'ten thousand coins buy two pizzas',
	2011: 'parity with the dollar',
	2012: 'the first halving',
	2013: 'the world starts watching',
	2014: 'hard lessons in custody',
	2015: 'quiet years, steady rings',
	2016: 'the second halving',
	2017: 'SegWit summer',
	2018: 'Lightning strikes',
	2019: 'heads down, stacking blocks',
	2020: 'the third halving',
	2021: 'Taproot takes root',
	2022: 'stress-tested, still standing',
	2023: 'inscriptions fill the blocks',
	2024: 'the fourth halving',
	2025: 'running on every continent',
	2026: 'the growing edge'
};

/** Note for a year, or null when we have nothing to say about it. */
export function yearNoteFor(year: number): string | null {
	return SYNC_YEAR_NOTES[year] ?? null;
}

/**
 * The full "Verifying 2017 — SegWit summer" line for a block timestamp
 * (unix seconds). Years without a note fall back to just the year.
 */
export function verifyingLineFor(blockTime: number): string {
	const year = new Date(blockTime * 1000).getUTCFullYear();
	const note = yearNoteFor(year);
	return note ? `Verifying ${year} — ${note}` : `Verifying ${year}`;
}
