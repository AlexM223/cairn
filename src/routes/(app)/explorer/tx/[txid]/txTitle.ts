import { truncateMiddle } from '$lib/format';

export interface TxTitleState {
	tx: { txid: string } | null;
	loading: boolean;
	coreRpcConfigured: boolean;
}

/** Page <title> for the tx detail page. Mirrors the body's own state machine
 *  (see +page.svelte) so the tab title never claims "Transaction not found"
 *  when the real reason is an unconfigured Bitcoin Core node, or while the
 *  "looking this up" shell is still polling (cairn QA finding: title said
 *  "not found" while the body correctly showed the CoreRpcRequiredNotice). */
export function txPageTitle({ tx, loading, coreRpcConfigured }: TxTitleState): string {
	if (tx) return `Tx ${truncateMiddle(tx.txid, 8, 8)}`;
	if (loading) return 'Looking up transaction';
	if (!coreRpcConfigured) return 'Transaction — needs Bitcoin Core';
	return 'Transaction not found';
}
