// Transaction-history CSV export, shared by single-sig wallets and multisigs.
//
// Both scanners produce the same row shape ({ txid, height, time, delta, fee })
// and an owned-address list, so one builder serves both. Counterparty
// addresses aren't carried on the scan rows, so we re-fetch each transaction's
// detail here (an explicit, user-triggered export can afford it) and degrade
// gracefully — a failed fetch leaves the counterparty blank but still reports
// everything derivable from the row itself.

import type { TxDetail } from '$lib/types';

/** One history row, as produced by wallet and multisig scans alike. */
export interface HistoryRow {
	txid: string;
	height: number; // <= 0 = unconfirmed
	time: number | null; // unix seconds, null when unconfirmed
	delta: number; // net effect in sats (positive = received)
	fee: number | null; // sats
}

const CSV_HEADER = [
	'Date',
	'Type',
	'Amount (BTC)',
	'Amount (sats)',
	'Fee (sats)',
	'TxID',
	'Confirmations',
	'Counterparty Address'
];

const SATS_PER_BTC = 100_000_000;
const FETCH_CONCURRENCY = 8;

/** Signed BTC with 8 dp and no locale grouping — safe for a CSV numeric cell. */
function btcString(sats: number): string {
	const neg = sats < 0 ? '-' : '';
	const abs = Math.abs(sats);
	return `${neg}${Math.floor(abs / SATS_PER_BTC)}.${String(abs % SATS_PER_BTC).padStart(8, '0')}`;
}

/** UTC "YYYY-MM-DD HH:MM:SS" from unix seconds; "Pending" when unconfirmed. */
function dateString(time: number | null): string {
	if (!time) return 'Pending';
	return new Date(time * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

/** Quote a field per RFC 4180 when it contains a comma, quote, or newline. */
function csvField(value: string): string {
	return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Pick the counterparty address for a row from the full transaction:
 *  - Sent (delta < 0): the first output NOT owned by this wallet (the payee).
 *  - Received (delta >= 0): the first input NOT owned (the payer).
 * Falls back to the first output when a send has only own-outputs (a
 * self-transfer / consolidation), and to '' when nothing usable is found.
 */
function counterpartyOf(tx: TxDetail, owned: Set<string>, delta: number): string {
	if (delta < 0) {
		const external = tx.vout.find((o) => o.address && !owned.has(o.address));
		if (external?.address) return external.address;
		return tx.vout.find((o) => o.address)?.address ?? '';
	}
	const external = tx.vin.find((i) => i.address && !owned.has(i.address));
	return external?.address ?? '';
}

/** Number of confirmations, from the tip and the row's block height. */
function confirmationsOf(height: number, tipHeight: number): number {
	return height > 0 ? Math.max(0, tipHeight - height + 1) : 0;
}

/**
 * Build the CSV text for a set of history rows. `getTx` is called at most once
 * per row (bounded concurrency) to recover the counterparty; supplying a getTx
 * that throws simply yields blank counterparties.
 */
export async function buildHistoryCsv(opts: {
	rows: HistoryRow[];
	ownedAddresses: Iterable<string>;
	tipHeight: number;
	getTx: (txid: string) => Promise<TxDetail>;
}): Promise<string> {
	const { rows, tipHeight, getTx } = opts;
	const owned = new Set(opts.ownedAddresses);

	// Resolve counterparties with bounded concurrency; a failed detail fetch
	// leaves that row's counterparty blank rather than failing the export.
	const counterparties = new Array<string>(rows.length).fill('');
	for (let i = 0; i < rows.length; i += FETCH_CONCURRENCY) {
		const chunk = rows.slice(i, i + FETCH_CONCURRENCY);
		await Promise.all(
			chunk.map(async (row, j) => {
				try {
					const tx = await getTx(row.txid);
					counterparties[i + j] = counterpartyOf(tx, owned, row.delta);
				} catch {
					/* leave blank */
				}
			})
		);
	}

	const lines = [CSV_HEADER.join(',')];
	rows.forEach((row, idx) => {
		lines.push(
			[
				dateString(row.time),
				row.delta >= 0 ? 'Received' : 'Sent',
				btcString(row.delta),
				String(row.delta),
				row.fee != null ? String(row.fee) : '',
				row.txid,
				String(confirmationsOf(row.height, tipHeight)),
				counterparties[idx]
			]
				.map(csvField)
				.join(',')
		);
	});
	return lines.join('\r\n') + '\r\n';
}

/**
 * A download filename like `cairn-cold-storage-history-2026-07-05.csv`.
 * The wallet name is slugified; `today` is an ISO date (YYYY-MM-DD).
 */
export function historyCsvFilename(walletName: string, today: string): string {
	const slug =
		walletName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48) || 'wallet';
	return `cairn-${slug}-history-${today}.csv`;
}
