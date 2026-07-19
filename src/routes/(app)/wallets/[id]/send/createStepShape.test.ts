// cairn-gt05.2 — structural pins for the reduced-decision create step (spec
// §2.3). The create step asks exactly two things (amount, recipient); the fee
// picker must not exist before the review branch of the step machine, the
// "at tip" chain pill must not exist on Send at all, and the create-step PSBT
// explainer is gone (the gloss lives on the Sign step). Source-shape tests:
// they pin the ORDER of the wizard's markup, which no runtime unit can see.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./+page.svelte', import.meta.url)), 'utf8');

// The markup half only — decisions about what renders per step live there.
const markup = source.slice(source.indexOf('</script>'));

describe('send create step shape (gt05.2, spec §2.3)', () => {
	it('the fee picker renders only at review — never on the create step', () => {
		const reviewBranch = markup.indexOf("step === 'review'");
		expect(reviewBranch).toBeGreaterThan(-1);
		const firstPicker = markup.indexOf('<FeeSpeedPicker');
		expect(firstPicker).toBeGreaterThan(-1);
		// Every picker usage sits after the review branch begins.
		expect(firstPicker).toBeGreaterThan(reviewBranch);
	});

	it('AtTipPill is gone from the Send surface', () => {
		// No import, no usage (a comment may still name it to say it's gone).
		expect(source).not.toContain('<AtTipPill');
		expect(source).not.toMatch(/import\s+AtTipPill/);
	});

	it('the create-step PSBT explainer is gone; the sign step carries the gloss', () => {
		expect(markup).not.toContain('id="send-psbt"');
		expect(markup).toContain('Why do I sign on my device?');
		expect(markup).toContain('unsigned transaction (a proposal)');
	});

	it('the zero-balance empty state exists with a Receive CTA', () => {
		expect(markup).toContain('This wallet is empty.');
		expect(markup).toContain('Add bitcoin before you can send.');
		expect(markup).toMatch(/\/receive[`"']/);
	});

	it('the Max toggle is a quiet "Send everything ›" link now', () => {
		expect(markup).toContain('Send everything');
		expect(markup).not.toContain('>Max<');
	});
});
