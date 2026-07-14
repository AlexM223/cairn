// cairn-fgbx: the admin log viewer used to show dozens of identical
// consecutive INFO lines (classically "gate: (app) redirect" on a busy
// instance) back to back, drowning out anything actually worth reading.
// Pulled out of +page.svelte as a plain function so the grouping logic (which
// has no Svelte dependency at all) is unit-testable on its own.

export interface CollapsibleLine {
	levelName: string;
	tag?: string;
	msg: string;
	fields?: Record<string, unknown>;
	time: number | null;
}

export interface CollapsedRun<T extends CollapsibleLine> {
	/** The newest (first-seen) line in the run — what the row displays. */
	e: T;
	/** Caller-supplied identity for the newest line (e.g. its index), carried
	 *  through unchanged so a keyed {#each} stays stable. */
	id: number;
	/** How many consecutive identical lines this run collapsed. */
	count: number;
	/** The oldest line's timestamp in the run (equals e.time when count === 1). */
	oldestTime: number | null;
}

/** Same line in every way that matters to an operator (ignores time itself). */
export function sameLine(a: CollapsibleLine, b: CollapsibleLine): boolean {
	return (
		a.levelName === b.levelName &&
		a.tag === b.tag &&
		a.msg === b.msg &&
		JSON.stringify(a.fields ?? null) === JSON.stringify(b.fields ?? null)
	);
}

/**
 * Collapse RUNS of consecutive identical lines into one entry with a repeat
 * count. Input is assumed newest-first (as logStore.ts returns it), so within
 * a run the first item is the newest occurrence and the last is the oldest —
 * `oldestTime` is set from the last-consumed item in each run. Non-consecutive
 * duplicates (a genuinely repeated event separated by something else in
 * between) are intentionally NOT merged — only an unbroken run collapses.
 */
export function collapseRepeats<T extends CollapsibleLine>(
	items: { e: T; id: number }[]
): CollapsedRun<T>[] {
	const out: CollapsedRun<T>[] = [];
	for (const item of items) {
		const last = out[out.length - 1];
		if (last && sameLine(last.e, item.e)) {
			last.count++;
			last.oldestTime = item.e.time;
		} else {
			out.push({ e: item.e, id: item.id, count: 1, oldestTime: item.e.time });
		}
	}
	return out;
}
