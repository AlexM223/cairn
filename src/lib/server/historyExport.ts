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
	'Address',
	'Label'
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

// Characters a spreadsheet (Excel, LibreOffice, Google Sheets) treats as the
// start of a formula when they lead a cell. A user-controlled field (the tx
// Label, and — in multi-user mode — another user's data) starting with one of
// these could smuggle a formula that executes when a victim opens the CSV.
// See OWASP "CSV Injection". Tab (0x09) and CR (0x0D) are included because some
// importers strip leading whitespace before re-reading the first glyph.
const FORMULA_LEAD = new Set(['=', '+', '-', '@', '|', '\t', '\r', '\n']);

/**
 * Neutralize a spreadsheet formula-injection vector (cairn-mf68): a cell whose
 * first character a spreadsheet would treat as a formula lead-in is prefixed
 * with a single quote, so the app renders it as literal text instead of
 * evaluating it. A cell that parses as a plain finite number (e.g. a negative
 * amount "-0.00030200") is left untouched — `Number()` accepts it, so it can't
 * be a formula, and we don't want to corrupt the numeric Amount columns.
 */
function neutralizeFormula(value: string): string {
	if (value === '' || !FORMULA_LEAD.has(value[0])) return value;
	// Genuine numbers (incl. leading '-'/'+') are safe and must stay numeric.
	if (Number.isFinite(Number(value))) return value;
	return `'${value}`;
}

/**
 * Serialize one field: neutralize formula injection first (cairn-mf68), THEN
 * quote per RFC 4180 when the resulting value contains a comma, quote, or
 * newline. Order matters — a prepended `'` must sit inside the RFC quoting.
 */
function csvField(value: string): string {
	const safe = neutralizeFormula(value);
	return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
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
	/** Optional per-txid labels (private, single-sig wallets); absent = blank. */
	labels?: Record<string, string>;
}): Promise<string> {
	const { rows, tipHeight, getTx, labels } = opts;
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
				counterparties[idx],
				labels?.[row.txid] ?? ''
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
