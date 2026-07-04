// Client-safe Bitcoin domain helpers shared across explorer and wallet pages.

const SATS_PER_BTC = 100_000_000;
const HALVING_INTERVAL = 210_000;

/**
 * Block subsidy at a given height, in sats: 50 BTC at genesis, halved every
 * 210,000 blocks (roughly four years).
 */
export function blockSubsidy(height: number): number {
	const halvings = Math.floor(height / HALVING_INTERVAL);
	if (halvings >= 64) return 0;
	return Math.floor((50 * SATS_PER_BTC) / 2 ** halvings);
}

export interface AddressTypeInfo {
	/** Short label, e.g. "Native SegWit" */
	label: string;
	/** The visible prefix pattern, e.g. "bc1q…" */
	prefix: string;
	/** One-sentence plain-language explanation */
	explanation: string;
}

/** Human framing for each address/script type the explorer can encounter. */
export const ADDRESS_TYPES: Record<string, AddressTypeInfo> = {
	p2pkh: {
		label: 'Legacy',
		prefix: '1…',
		explanation:
			'The original address format from 2009. Works everywhere, but transactions spending from it take the most block space and pay the highest fees.'
	},
	p2sh: {
		label: 'Script (P2SH)',
		prefix: '3…',
		explanation:
			'Pays to a script rather than a single key — used for multisig and for wrapping SegWit before native support was widespread. What the script is stays hidden until the coins are spent.'
	},
	'p2sh-p2wpkh': {
		label: 'Nested SegWit',
		prefix: '3…',
		explanation:
			'A SegWit key wrapped in a script address for compatibility with older wallets. Cheaper to spend from than Legacy, but not as efficient as Native SegWit.'
	},
	p2wpkh: {
		label: 'Native SegWit',
		prefix: 'bc1q…',
		explanation:
			'The bech32 format introduced by Segregated Witness. Most efficient single-key format — spending from it uses the least block space and the lowest fees of the pre-Taproot types.'
	},
	p2wsh: {
		label: 'SegWit Script',
		prefix: 'bc1q…',
		explanation:
			'A SegWit address that pays to a script (commonly multisig). Longer than a key address because it commits to a 32-byte script hash.'
	},
	p2tr: {
		label: 'Taproot',
		prefix: 'bc1p…',
		explanation:
			'The newest format (2021). Single-key and complex multi-party spends look identical on-chain, improving both privacy and efficiency.'
	},
	op_return: {
		label: 'OP_RETURN',
		prefix: '—',
		explanation:
			'Not a payable address: this output embeds a small piece of data in the blockchain and can never be spent.'
	}
};

export function addressTypeInfo(scriptType: string | null | undefined): AddressTypeInfo | null {
	if (!scriptType) return null;
	return ADDRESS_TYPES[scriptType] ?? null;
}

/**
 * Rough confirmation outlook for an unconfirmed transaction given its fee
 * rate and the current recommended tiers. Returns a human phrase.
 */
export function feeOutlook(
	feeRate: number,
	fees: { fastest: number; halfHour: number; hour: number; economy: number }
): string {
	if (feeRate >= fees.fastest) return 'likely in the next block (~10 min)';
	if (feeRate >= fees.halfHour) return 'likely within ~30 minutes';
	if (feeRate >= fees.hour) return 'likely within ~1 hour';
	if (feeRate >= fees.economy) return 'may take several hours';
	return 'below the economy rate — could wait a long time or be dropped';
}
