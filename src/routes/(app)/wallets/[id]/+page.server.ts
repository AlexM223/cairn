import { error } from '@sveltejs/kit';
import { getWallet, getLabels } from '$lib/server/wallets';
import { listTransactions } from '$lib/server/transactions';
import { getAddressLabels } from '$lib/server/addressLabels';
import { isBackedUp } from '$lib/server/backups';
import { readWalletSnapshot, EMPTY_WALLET_SNAPSHOT } from '$lib/server/walletSync';
import { listReplacedInbound } from '$lib/server/addressWatcher';
import { db } from '$lib/server/db';
import { parseWalletId, rotateReceiveAction } from '$lib/server/receiveRotate';
import type { Actions, PageServerLoad } from './$types';

/** Coinbase txids of blocks this instance's pool found with this wallet as the
 *  payout target (cairn-i0d0q) — the durable "this was a mining reward" record
 *  that survives the reward being spent. Best-effort: a lookup failure just
 *  means generic "Received" labels, never a broken page. */
function poolCoinbaseTxidsFor(userId: number, walletId: number): string[] {
	try {
		const rows = db
			.prepare(
				'SELECT coinbase_txid FROM mining_blocks WHERE user_id = ? AND wallet_id = ? AND coinbase_txid IS NOT NULL'
			)
			.all(userId, walletId) as { coinbase_txid: string }[];
		return rows.map((r) => r.coinbase_txid);
	} catch {
		return [];
	}
}


export const load: PageServerLoad = ({ params, locals, url, depends }) => {
	const id = parseWalletId(params.id);
	const userId = locals.user!.id;
	const row = getWallet(userId, id);
	if (!row) error(404, 'Wallet not found');

	// Cache-first (cairn-2zxt SWR): load() reads a persisted snapshot SYNCHRONOUSLY
	// — zero Electrum, so navigation never blocks. The +page.svelte fires the
	// /refresh endpoint on mount (and on each new block) and, when it resolves,
	// re-invalidates this tag; load() re-runs (cheap — just this SQLite read) and
	// picks up the fresh snapshot. The old streamed full-scan-per-navigation
	// (cairn-vknb.1) is retired.
	depends(`cairn:wallet:${id}`);
	const cached = readWalletSnapshot(id);

	return {
		wallet: {
			id: row.id,
			name: row.name,
			scriptType: row.script_type,
			deviceType: row.device_type ?? null,
			xpub: row.xpub,
			createdAt: row.created_at
		},
		imported: url.searchParams.get('imported') === '1',
		// Server-tracked backup status (wallet_backups) — the single source of
		// truth the wizard's download step and the persistent banner both use.
		backedUp: isBackedUp('wallet', id),
		// Tx labels are local bookkeeping — one cheap SQLite read, no network.
		labels: getLabels(userId, id) ?? {},
		// Address labels (cairn-nbsx) — annotate why an address exists; local read.
		addressLabels: getAddressLabels(userId, 'wallet', id),
		// Saved transactions in the draft → awaiting-signature → broadcast
		// lifecycle. Cheap local SQLite read, newest first.
		transactions: listTransactions(userId, id) ?? [],
		// The scan-derived fields (balance, addresses, txs, receive peek + QR,
		// coinbase UTXOs, tip, speed-up verdicts) from the persisted snapshot —
		// already resolved (not a promise). Empty-but-shaped until the first
		// background refresh lands.
		chainData: cached?.snapshot ?? EMPTY_WALLET_SNAPSHOT,
		lastSyncedAt: cached?.lastSyncedAt ?? null,
		// Inbound payments that were double-spent / RBF'd away before confirming
		// (cairn-a2p1). The live scan naturally drops them from the balance + tx
		// list, so we surface them here as amber "cancelled" rows to reconcile the
		// vanished amount for the user.
		cancelledTxs: listReplacedInbound('wallet', id),
		// Coinbase txids of pool-found blocks paid to THIS wallet (cairn-i0d0q):
		// lets the tx feed label a reward "Mining reward" even after it's spent
		// (when it no longer appears in coinbaseUtxos). Cheap local read,
		// best-effort.
		poolCoinbaseTxids: poolCoinbaseTxidsFor(userId, id)
	};
};

export const actions: Actions = {
	/** Hand out the next unused receive address (after the one on display).
	 *  Shared with /wallets/[id]/receive — see $lib/server/receiveRotate.ts.
	 *  Remove-wallet moved to the confirmation-gated /wallets/[id]/settings
	 *  subpage (cairn-gt05.2, spec §2.2 — destructive actions never sit in the
	 *  detail page's scroll flow). */
	receive: rotateReceiveAction
};
