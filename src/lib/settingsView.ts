// Pure Settings-page rendering-rule helpers (UX redesign Phase 3,
// cairn-gt05.3, docs/UX-REDESIGN-SPEC.md §2.6c). Kept out of the Svelte
// component so the conditional-render rules are unit-testable without
// mounting a component — same pattern as homeView.ts.

/**
 * The Contacts row (Settings → Advanced) renders ONLY when team mode is on
 * (spec §2.6c: "Contacts (team features) — only shown if team mode is on").
 * Solo instances don't advertise a feature that's off — the old
 * "Contacts · team features off" explainer row was exactly the disabled-dev-
 * feature noise the redesign removes.
 */
export function showContactsRow(instanceMode: string | null | undefined): boolean {
	return instanceMode === 'team';
}
