import { describe, it, expect } from 'vitest';
import { moneyOrBtc, sendCtaLabel } from './sendMoney';

// The two send-flow spots that need money as a *string* rather than a rendered
// Amount component: the review summary's amount slot and the CTA button label
// (cairn-krwp). Both must lead with fiat when a price is known and degrade to a
// clean BTC readout — never an empty/fake fiat value — when it isn't.

describe('moneyOrBtc', () => {
	it('formats a sats amount as fiat when a price is known', () => {
		// 100_000 sats = 0.001 BTC; at $64,700/BTC that is $64.70.
		expect(moneyOrBtc(100_000, 64_700)).toBe('$64.70');
	});

	// Fiat-hidden mode: no price → a clean BTC string, never "$0.00" or "".
	it('degrades to a BTC string when the price is null', () => {
		expect(moneyOrBtc(100_000, null)).toBe('0.001 BTC');
	});

	it('handles a zero amount in both modes', () => {
		expect(moneyOrBtc(0, 64_700)).toBe('$0.00');
		expect(moneyOrBtc(0, null)).toBe('0.00 BTC');
	});
});

describe('sendCtaLabel', () => {
	it('labels the review CTA with the total leaving the wallet', () => {
		expect(sendCtaLabel(100_000, 64_700, 'review')).toBe('Send $64.70');
	});

	it('labels the confirm CTA with a broadcast verb', () => {
		expect(sendCtaLabel(100_000, 64_700, 'confirm')).toBe('Broadcast — $64.70');
	});

	// Fiat-hidden mode carries through to the button copy too.
	it('falls back to BTC in the label when no price is available', () => {
		expect(sendCtaLabel(100_000, null, 'review')).toBe('Send 0.001 BTC');
		expect(sendCtaLabel(100_000, null, 'confirm')).toBe('Broadcast — 0.001 BTC');
	});
});
