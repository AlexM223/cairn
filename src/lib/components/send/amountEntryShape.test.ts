// cairn-86x5f — the amount hero overflowed a 375px viewport (measured 410px,
// 17px page-level horizontal scroll) because AmountEntry sets an explicit
// ch-width on the input at an 86px serif with no mobile scale, and the send
// page's own mobile CSS cannot reach into this component's style scope.
// Source-shape pins: the component must carry its own mobile media block and
// the shrink guards that keep the explicit width from forcing overflow.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
	fileURLToPath(new URL('./AmountEntry.svelte', import.meta.url)),
	'utf8'
);
const styles = source.slice(source.indexOf('<style'));

describe('AmountEntry mobile overflow guards (cairn-86x5f)', () => {
	it('carries its own mobile media block (page-scope CSS cannot reach in)', () => {
		expect(styles).toMatch(/@media\s*\(max-width:\s*600px\)/);
	});

	it('scales the hero down inside the media block', () => {
		const mobile = styles.slice(styles.search(/@media\s*\(max-width:\s*600px\)/));
		expect(mobile).toMatch(/\.hero-input\s*\{[^}]*font-size:\s*52px/);
		expect(mobile).toMatch(/\.hero-unit\s*\{[^}]*font-size:\s*20px/);
	});

	it('keeps the explicit ch-width shrinkable so no digit count can overflow', () => {
		// min-width: 0 + flex-shrink allowed on the input; hero-line capped.
		expect(styles).toMatch(/\.hero-input\s*\{[^}]*flex:\s*0\s+1\s+auto[^}]*min-width:\s*0/s);
		expect(styles).toMatch(/\.hero-line\s*\{[^}]*max-width:\s*100%/s);
	});
});
