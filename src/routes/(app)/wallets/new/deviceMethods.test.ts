import { describe, it, expect } from 'vitest';
import { METHOD_CARDS, visibleMethodCards } from './deviceMethods';

describe('wizard key-step device gating (cairn-cl13)', () => {
	it('shows every card when no flags are disabled', () => {
		const keys = visibleMethodCards({}).map((m) => m.key);
		expect(keys).toEqual(METHOD_CARDS.map((m) => m.key));
	});

	it('shows every card when the flags object is absent (fail-open)', () => {
		expect(visibleMethodCards(undefined).map((m) => m.key)).toEqual(
			METHOD_CARDS.map((m) => m.key)
		);
	});

	it('drops a hardware card when its hw_* flag is disabled', () => {
		const keys = visibleMethodCards({ hw_trezor: false }).map((m) => m.key);
		expect(keys).not.toContain('trezor');
		// Only Trezor is removed; the other devices stay.
		expect(keys).toContain('ledger');
		expect(keys).toContain('bitbox02');
	});

	it('gates each hardware method on its own flag independently', () => {
		const cases: Record<string, string> = {
			hw_trezor: 'trezor',
			hw_ledger: 'ledger',
			hw_coldcard: 'coldcard',
			hw_bitbox02: 'bitbox02',
			hw_jade: 'jade',
			qr_scan: 'qr'
		};
		for (const [flag, method] of Object.entries(cases)) {
			const keys = visibleMethodCards({ [flag]: false }).map((m) => m.key);
			expect(keys, `${flag} off should hide ${method}`).not.toContain(method);
		}
	});

	it('never gates the paste fallback, even with every flag off', () => {
		const allOff = Object.fromEntries(
			METHOD_CARDS.flatMap((m) => (m.flag ? [[m.flag, false]] : []))
		);
		const keys = visibleMethodCards(allOff).map((m) => m.key);
		expect(keys).toEqual(['paste']);
	});

	it('keeps a card visible when its flag is explicitly enabled', () => {
		expect(visibleMethodCards({ hw_trezor: true }).map((m) => m.key)).toContain('trezor');
	});
});
