import { error, fail, redirect } from '@sveltejs/kit';
import QRCode from 'qrcode';
import {
	getWallet,
	getWalletDetail,
	deleteWallet,
	getLabels,
	nextReceiveAddress,
	peekReceiveAddress
} from '$lib/server/wallets';
import {
	listTransactions,
	getWalletUtxos,
	detectWalletUnconfirmedInflows
} from '$lib/server/transactions';
import { getChain } from '$lib/server/chain';
import { getAddressLabels } from '$lib/server/addressLabels';
import { isBackedUp } from '$lib/server/backups';
import type { Actions, PageServerLoad } from './$types';

const QR_OPTS = {
	margin: 1,
	width: 220,
	color: { dark: '#E4D8CC', light: '#00000000' }
};

function walletId(param: string): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Wallet not found');
	return id;
}

type WalletRow = NonNullable<ReturnType<typeof getWallet>>;
type WalletScan = NonNullable<Awaited<ReturnType<typeof getWalletDetail>>>['scan'];

/** The Electrum/esplora-dependent slice of the wallet-detail page. Everything
 *  here rides on network round-trips (full gap-limit scan, receive-address peek,
 *  UTXO fetch, tip) so it is STREAMED, not awaited (see load below). */
export interface WalletChainData {
	scan: Pick<WalletScan, 'addresses' | 'txs' | 'confirmed' | 'unconfirmed'> | null;
	receive: (Awaited<ReturnType<typeof peekReceiveAddress>> & { qr: string }) | null;
	coinbaseUtxos: { txid: string; vout: number; value: number; height: number }[];
	tipHeight: number;
	speedUp: Awaited<ReturnType<typeof detectWalletUnconfirmedInflows>>;
	scanError: string | null;
}

/**
 * Do all the network-bound work off the critical render path. Mirrors
 * `loadChainSnapshot` on the dashboard (`(app)/+page.server.ts`): it NEVER
 * rejects — every failure resolves to an error-shaped value the page renders as
 * a degraded/empty state, so a streamed rejection can never surface as a 500.
 */
async function loadWalletChainData(
	userId: number,
	id: number,
	row: WalletRow
): Promise<WalletChainData> {
	try {
		const detail = await getWalletDetail(userId, id);
		if (!detail) {
			// The wallet row exists (checked synchronously in load), so a missing
			// detail here means the scan couldn't be built — degrade to an empty
			// scan rather than 404ing a page whose shell has already painted.
			return {
				scan: null,
				receive: null,
				coinbaseUtxos: [],
				tipHeight: 0,
				speedUp: [],
				scanError: null
			};
		}
		const receive = await peekReceiveAddress(row);
		const qr = await QRCode.toDataURL(receive.address, QR_OPTS);

		// Mining rewards (coinbase UTXOs) get their own "cooling off" section. A
		// normal wallet has none, so this is empty for almost everyone. Tolerate a
		// scanner/chain hiccup here without failing the whole page — the balance
		// and receive cards above are what matter most.
		let coinbaseUtxos: { txid: string; vout: number; value: number; height: number }[] = [];
		let tipHeight = 0;
		try {
			const [utxos, tip] = await Promise.all([getWalletUtxos(row.xpub), getChain().getTip()]);
			tipHeight = tip.height;
			coinbaseUtxos = utxos
				.filter((u) => u.coinbase)
				.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, height: u.height }));
		} catch {
			coinbaseUtxos = [];
			tipHeight = 0;
		}

		// Which unconfirmed transactions can be sped up, and how (RBF vs CPFP) —
		// feeds the "Speed up" button (cairn-u9ob.4). Tolerate a chain hiccup: the
		// button simply doesn't appear rather than failing the page.
		let speedUp: Awaited<ReturnType<typeof detectWalletUnconfirmedInflows>> = [];
		try {
			speedUp = (await detectWalletUnconfirmedInflows(userId, id)) ?? [];
		} catch {
			speedUp = [];
		}

		return {
			scan: {
				addresses: detail.scan.addresses,
				txs: detail.scan.txs,
				confirmed: detail.scan.confirmed,
				unconfirmed: detail.scan.unconfirmed
			},
			receive: { ...receive, qr },
			coinbaseUtxos,
			tipHeight,
			speedUp,
			scanError: null
		};
	} catch (e) {
		// Scan/chain unreachable → degrade to zero/empty, never 500. This is the
		// same "scan unreachable" branch the awaited version had, now caught inside
		// the streamed function so the shell still paints.
		return {
			scan: null,
			receive: null,
			coinbaseUtxos: [],
			tipHeight: 0,
			speedUp: [],
			scanError: e instanceof Error ? e.message : 'Could not reach the wallet scanner'
		};
	}
}

export const load: PageServerLoad = ({ params, locals, url, depends }) => {
	const id = walletId(params.id);
	const userId = locals.user!.id;
	const row = getWallet(userId, id);
	if (!row) error(404, 'Wallet not found');

	// New-block SSE events invalidate this tag only, refreshing the wallet's
	// chain-derived fields (tip, coinbase maturity, speed-up eligibility) live —
	// see the +page.svelte onMount wiring. Mirrors depends('cairn:chain') on the
	// dashboard.
	depends(`cairn:wallet:${id}`);

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
		// Streamed, not awaited (SvelteKit 2 leaves top-level promises alone): the
		// shell above paints immediately while the full gap-limit scan, receive
		// peek, UTXO/tip fetch and speed-up detection resolve in the background
		// (cairn-vknb.1). loadWalletChainData never rejects — failures resolve to
		// an error-shaped value rendered as a degraded state.
		chainData: loadWalletChainData(userId, id, row)
	};
};

export const actions: Actions = {
	/** Hand out the next unused receive address (after the one on display). */
	receive: async ({ params, locals, request }) => {
		const id = walletId(params.id);
		const form = await request.formData();
		const currentRaw = form.get('current');
		const current = currentRaw == null ? NaN : Number(currentRaw);

		let next: { address: string; path: string; index: number } | null;
		try {
			next = await nextReceiveAddress(
				locals.user!.id,
				id,
				Number.isInteger(current) ? current : undefined
			);
		} catch (e) {
			return fail(502, {
				receiveError:
					e instanceof Error ? e.message : 'Could not reach the Electrum server.'
			});
		}
		if (!next) error(404, 'Wallet not found');

		const qr = await QRCode.toDataURL(next.address, QR_OPTS);
		return { receive: { ...next, qr } };
	},

	delete: async ({ params, locals }) => {
		const id = walletId(params.id);
		if (!deleteWallet(locals.user!.id, id)) error(404, 'Wallet not found');
		redirect(303, '/wallets');
	}
};
