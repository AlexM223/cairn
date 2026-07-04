import type { ScriptType } from '$lib/types';

/** Human names for address script types, shown as badges across wallet pages. */
export const SCRIPT_TYPE_LABELS: Record<ScriptType, string> = {
	p2wpkh: 'Native SegWit',
	'p2sh-p2wpkh': 'Nested SegWit',
	p2pkh: 'Legacy',
	p2tr: 'Taproot'
};
