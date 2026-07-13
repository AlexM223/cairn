// Key-source methods offered on the wizard's Key step, and the feature-flag
// gating that decides which are shown. Extracted from +page.svelte so the
// gating is unit-testable without a component renderer (cairn-cl13), mirroring
// the same predicate DevicePicker.svelte applies to its OPTIONS list.

export type WizardKeyMethod =
	| 'trezor'
	| 'ledger'
	| 'coldcard'
	| 'bitbox02'
	| 'jade'
	| 'qr'
	| 'paste';

export type MethodCard = {
	key: WizardKeyMethod;
	title: string;
	desc: string;
	/**
	 * Feature flag that must not be disabled for this card to appear. Each
	 * hardware method maps to its driver's hw_* flag and QR to qr_scan;
	 * "Paste public key" has none — it is the universal fallback and is never
	 * gated, so a wallet is never a dead-end (matches DevicePicker's 'file').
	 */
	flag?: string;
};

export const METHOD_CARDS: MethodCard[] = [
	{ key: 'trezor', title: 'Trezor', desc: 'Plug it in and connect with one click.', flag: 'hw_trezor' },
	{ key: 'ledger', title: 'Ledger', desc: 'Plug it in and connect with one click.', flag: 'hw_ledger' },
	{ key: 'coldcard', title: 'ColdCard', desc: 'Import the file from its microSD card.', flag: 'hw_coldcard' },
	{ key: 'bitbox02', title: 'BitBox02', desc: 'Plug it in and confirm on the device.', flag: 'hw_bitbox02' },
	{ key: 'jade', title: 'Jade', desc: 'Plug it in and unlock it (Chrome/Edge).', flag: 'hw_jade' },
	{ key: 'qr', title: 'Air-gapped QR', desc: "Scan the key's QR code off the device screen.", flag: 'qr_scan' },
	{ key: 'paste', title: 'Paste public key', desc: 'From any wallet app, or a key someone sent you.' }
];

/**
 * The cards actually offered for a given resolved-flags object. A flag counts
 * as disabled only when it is explicitly `false`; an absent flags object or a
 * missing key leaves the card visible (fail-open to shown, so a flags-loading
 * race never blanks the picker).
 */
export function visibleMethodCards(flags?: Record<string, boolean>): MethodCard[] {
	return METHOD_CARDS.filter((m) => !m.flag || flags?.[m.flag] !== false);
}
