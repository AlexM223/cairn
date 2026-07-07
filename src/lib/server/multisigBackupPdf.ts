// The "break glass in a safe" physical backup: a single-sheet PDF that holds
// everything needed to reconstruct a multisig — the quorum, every key
// (fingerprint / path / xpub), the full receive descriptor, and a large QR of the
// exact Caravan config the JSON download emits. It is deliberately paper-first: a
// single copper accent for the Heartwood wordmark, ring mark and rules, but the
// body text and the QR stay black-on-white (prints on any laser/inkjet), monospace
// for anything a human might transcribe, and a big low-density QR that scans off a
// printed page.
//
// Pure given a MultisigRow — no network, no clock reads beyond formatting the
// stored createdAt — so it is fully testable. jsPDF runs in Node via its
// "node" export; the QR is a PNG data URL from the `qrcode` package embedded
// with addImage.

import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';
import { caravanExport } from './multisigExport';
import { multisigToDescriptor } from './bitcoin/multisig';
import { toMultisigConfig, type MultisigRow, type MultisigScriptType } from './wallets/multisig';

/** Human-facing address-type labels, matching the Caravan/ColdCard exports. */
const SCRIPT_LABEL: Record<MultisigScriptType, string> = {
	p2wsh: 'Native SegWit (P2WSH)',
	'p2sh-p2wsh': 'Nested SegWit (P2SH-P2WSH)',
	p2sh: 'Legacy (P2SH)'
};

// US Letter in points (1pt = 1/72"). Letter is the safest default for a
// physical artifact printed at home; the layout also fits A4's smaller width.
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;

// QR: >= 2 inches square (144pt) so it scans reliably from paper. We render the
// source PNG large (600px) and place it at 168pt (~2.33").
const QR_SIZE = 168;
const QR_PX = 600;

// Heartwood copper accent — src/app.css `--accent: #e8935a` as a 0–255 RGB triple
// for jsPDF's colour setters. Chrome only (wordmark, ring mark, section headings,
// header/footer rules); body text, the key table, the descriptor and the QR
// modules stay black-on-white so the sheet prints and scans on any device.
const COPPER: [number, number, number] = [232, 147, 90];

/**
 * Draw a simplified HeartwoodMark — three concentric, slightly-eccentric copper
 * growth rings plus a filled pith dot — as vector primitives, into a `size`-pt box
 * at (x, y). A direct reduction of the "min" detail level in
 * src/lib/components/heartwood/HeartwoodMark.svelte (100-unit viewBox): the pith
 * sits up-left and each ring drifts down-right as it grows.
 */
function drawHeartwoodMark(doc: jsPDF, x: number, y: number, size: number): void {
	const s = size / 100;
	doc.setDrawColor(COPPER[0], COPPER[1], COPPER[2]);
	doc.setLineWidth(0.7);
	for (const r of [43, 28, 15]) {
		const t = r / 45;
		const cx = x + (49 + t * 2) * s;
		const cy = y + (45 + t * 7) * s;
		doc.ellipse(cx, cy, r * s, r * 0.955 * s, 'S');
	}
	// Filled pith dot.
	doc.setFillColor(COPPER[0], COPPER[1], COPPER[2]);
	doc.circle(x + 49.3 * s, y + 46 * s, 5.5 * s, 'F');
	doc.setDrawColor(0);
}

/** Read a value's extended-key string down to first-12…last-12 for the table.
 *  Short strings (< 27 chars) are shown whole. */
function truncateMiddle(s: string, head = 12, tail = 12): string {
	if (s.length <= head + tail + 3) return s;
	return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** Format the stored ISO createdAt as a readable, locale-independent date
 *  ("5 July 2026"). Falls back to the raw string if it can't be parsed. */
function formatDate(iso: string): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return iso;
	const d = new Date(t);
	const months = [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'
	];
	return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Build the printable backup PDF for a multisig.
 *
 * The QR encodes the COMPLETE `caravanExport(multisig)` JSON — byte-identical to
 * the "Download backup (JSON)" file — so scanning it restores the wallet in
 * Heartwood, Sparrow, or any Caravan-format consumer. We fix error-correction at 'L'
 * (lowest) and let the `qrcode` library auto-pick the QR version: a multisig
 * config is a few hundred to ~2 000 bytes, well within a version that still has
 * chunky, printer-friendly modules at 'L'. Higher correction would force a
 * denser (harder-to-scan-on-paper) symbol for no real benefit — this is a cold
 * backup, not a lossy transport.
 */
export async function buildMultisigBackupPdf(multisig: MultisigRow): Promise<Uint8Array> {
	const doc = new jsPDF({ unit: 'pt', format: 'letter' });

	const n = multisig.keys.length;
	const m = multisig.threshold;
	const receiveDescriptor = multisigToDescriptor(toMultisigConfig(multisig));
	const configJson = caravanExport(multisig);

	// Vertical cursor; helpers advance it and page-break when needed.
	let y = MARGIN;

	/** Ensure `need` points of vertical room remain, else start a fresh page. */
	function ensure(need: number): void {
		if (y + need > PAGE_H - MARGIN) {
			doc.addPage();
			y = MARGIN;
		}
	}

	// ---------------------------------------------------------------- header
	// Copper Heartwood ring mark + wordmark; "Wallet Backup" stays black at right.
	drawHeartwoodMark(doc, MARGIN, y, 18);
	doc.setFont('helvetica', 'bold');
	doc.setFontSize(22);
	doc.setTextColor(COPPER[0], COPPER[1], COPPER[2]);
	doc.text('Heartwood', MARGIN + 26, y + 16);
	doc.setTextColor(0, 0, 0);
	doc.setFont('helvetica', 'normal');
	doc.setFontSize(12);
	doc.text('Wallet Backup', PAGE_W - MARGIN, y + 16, { align: 'right' });
	y += 30;

	// Copper rule under the wordmark.
	doc.setDrawColor(COPPER[0], COPPER[1], COPPER[2]);
	doc.setLineWidth(1.2);
	doc.line(MARGIN, y, PAGE_W - MARGIN, y);
	doc.setDrawColor(0);
	y += 22;

	// Wallet name (may wrap for long names).
	doc.setFont('helvetica', 'bold');
	doc.setFontSize(16);
	for (const line of doc.splitTextToSize(multisig.name, CONTENT_W) as string[]) {
		ensure(20);
		doc.text(line, MARGIN, y);
		y += 20;
	}
	y += 2;

	// Quorum + script type + creation date.
	doc.setFont('helvetica', 'normal');
	doc.setFontSize(11);
	const meta = [
		`${m} of ${n} signatures required`,
		SCRIPT_LABEL[multisig.scriptType],
		`Created ${formatDate(multisig.createdAt)}`
	];
	for (const line of meta) {
		ensure(15);
		doc.text(line, MARGIN, y);
		y += 15;
	}
	y += 12;

	// ----------------------------------------------------------- keys table
	doc.setFont('helvetica', 'bold');
	doc.setFontSize(12);
	ensure(18);
	doc.setTextColor(COPPER[0], COPPER[1], COPPER[2]);
	doc.text('Signing keys', MARGIN, y);
	doc.setTextColor(0, 0, 0);
	y += 16;

	// One block per key rather than a fixed-width grid: xpubs/paths vary in
	// length, and a block layout stays legible for 2-of-3 up to large quorums
	// without columns colliding.
	multisig.keys.forEach((key, i) => {
		ensure(56);
		doc.setDrawColor(180);
		doc.setLineWidth(0.5);
		doc.line(MARGIN, y, PAGE_W - MARGIN, y);
		y += 14;

		// Key label (bold, may wrap).
		doc.setFont('helvetica', 'bold');
		doc.setFontSize(11);
		const label = `${i + 1}. ${key.name}`;
		for (const line of doc.splitTextToSize(label, CONTENT_W) as string[]) {
			ensure(14);
			doc.text(line, MARGIN, y);
			y += 14;
		}

		// Fingerprint / path / xpub in monospace, label + value per line.
		doc.setFontSize(9);
		const rows: [string, string][] = [
			['Fingerprint', (key.fingerprint || '00000000').toLowerCase()],
			['Path', key.path && key.path.trim() ? key.path : 'm'],
			['Key (xpub)', truncateMiddle(key.xpub)]
		];
		for (const [rowLabel, value] of rows) {
			ensure(13);
			doc.setFont('helvetica', 'normal');
			doc.text(`${rowLabel}:`, MARGIN + 8, y);
			doc.setFont('courier', 'normal');
			doc.text(value, MARGIN + 78, y);
			y += 13;
		}
		y += 6;
	});
	y += 10;

	// ------------------------------------------------- receive descriptor
	doc.setFont('helvetica', 'bold');
	doc.setFontSize(12);
	ensure(18);
	doc.setTextColor(COPPER[0], COPPER[1], COPPER[2]);
	doc.text('Output descriptor (receive)', MARGIN, y);
	doc.setTextColor(0, 0, 0);
	y += 16;

	doc.setFont('courier', 'normal');
	doc.setFontSize(8);
	// splitTextToSize with a monospace font wraps at word boundaries; descriptors
	// have none, so it breaks mid-string at the width — exactly what we want.
	for (const line of doc.splitTextToSize(receiveDescriptor, CONTENT_W) as string[]) {
		ensure(11);
		doc.text(line, MARGIN, y);
		y += 11;
	}
	y += 16;

	// -------------------------------------------------------------- QR code
	// Keep the QR + its caption + the label together on one page.
	ensure(QR_SIZE + 40);

	// A very large quorum's Caravan JSON can exceed a single QR's byte capacity
	// (~2.9 KB even at the lowest error correction). Rather than fail the whole
	// PDF, fall back to a printed note — the per-key table and full descriptor
	// above already reconstruct the wallet on their own.
	let qrDataUrl: string | null = null;
	try {
		qrDataUrl = await QRCode.toDataURL(configJson, {
			errorCorrectionLevel: 'L',
			margin: 2,
			width: QR_PX,
			color: { dark: '#000000', light: '#ffffff' }
		});
	} catch {
		qrDataUrl = null;
	}

	if (qrDataUrl) {
		doc.setFont('helvetica', 'bold');
		doc.setFontSize(12);
		doc.setTextColor(COPPER[0], COPPER[1], COPPER[2]);
		doc.text('Scan to restore', MARGIN, y);
		doc.setTextColor(0, 0, 0);
		y += 14;
		// Centre the QR horizontally.
		const qrX = MARGIN + (CONTENT_W - QR_SIZE) / 2;
		doc.addImage(qrDataUrl, 'PNG', qrX, y, QR_SIZE, QR_SIZE);
		y += QR_SIZE + 12;

		doc.setFont('helvetica', 'normal');
		doc.setFontSize(9);
		doc.text('Full wallet configuration (Caravan format)', PAGE_W / 2, y, { align: 'center' });
		y += 20;
	} else {
		doc.setFont('helvetica', 'normal');
		doc.setFontSize(9);
		const note = doc.splitTextToSize(
			"This wallet's configuration is too large to fit in a single scannable QR code. " +
				'Restore it from the descriptor above, or from the JSON backup file you can ' +
				'download alongside this document.',
			CONTENT_W
		) as string[];
		doc.text(note, MARGIN, y);
		y += note.length * 12 + 12;
	}

	// -------------------------------------------------------------- footers
	// Anchor the storage/restore notes to the bottom of the final page so they
	// read as a footer regardless of how much content preceded them.
	const footer1 =
		'STORE SECURELY — This document contains all information needed to reconstruct ' +
		'this wallet. Anyone with this document can see your transaction history and ' +
		'balances (but cannot spend funds without the signing keys).';
	const footer2 =
		'To restore: scan the QR code above in Heartwood, Sparrow, or any wallet that supports ' +
		'Caravan-format configs — or re-import the descriptor listed above.';

	doc.setFont('helvetica', 'normal');
	doc.setFontSize(8);
	const f1 = doc.splitTextToSize(footer1, CONTENT_W) as string[];
	const f2 = doc.splitTextToSize(footer2, CONTENT_W) as string[];
	const footerBlock = (f1.length + f2.length) * 11 + 14;

	// Prefer the bottom of the page; if the content cursor is already past that,
	// just flow below it (ensure adds a page if truly out of room).
	const bottomAnchor = PAGE_H - MARGIN - footerBlock;
	if (bottomAnchor > y) {
		y = bottomAnchor;
	} else {
		ensure(footerBlock);
	}

	doc.setDrawColor(COPPER[0], COPPER[1], COPPER[2]);
	doc.setLineWidth(1);
	doc.line(MARGIN, y, PAGE_W - MARGIN, y);
	doc.setDrawColor(0);
	doc.setLineWidth(0.5);
	y += 12;

	for (const line of f1) {
		doc.text(line, MARGIN, y);
		y += 11;
	}
	y += 3;
	for (const line of f2) {
		doc.text(line, MARGIN, y);
		y += 11;
	}

	// jsPDF's arraybuffer output is the canonical byte stream; wrap as Uint8Array.
	return new Uint8Array(doc.output('arraybuffer'));
}
