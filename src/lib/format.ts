// Formatting helpers shared across the UI.

const SATS_PER_BTC = 100_000_000;

/** 123456789 sats -> "1.23456789" (BTC string, trailing zeros trimmed to min 2 dp) */
export function formatBtc(sats: number, { trim = true }: { trim?: boolean } = {}): string {
	const negative = sats < 0;
	const abs = Math.abs(sats);
	const btc = abs / SATS_PER_BTC;
	let s = btc.toFixed(8);
	if (trim) {
		s = s.replace(/0+$/, '');
		if (s.endsWith('.')) s += '00';
		const dp = s.split('.')[1]?.length ?? 0;
		if (dp === 1) s += '0';
	}
	return (negative ? '-' : '') + s;
}

export function formatSats(sats: number): string {
	return new Intl.NumberFormat('en-US').format(sats);
}

export function formatNumber(n: number, maxFrac = 0): string {
	return new Intl.NumberFormat('en-US', { maximumFractionDigits: maxFrac }).format(n);
}

/** "3m ago", "2h ago", "5d ago" from unix seconds */
export function timeAgo(unixSeconds: number | null | undefined): string {
	if (!unixSeconds) return '—';
	const diff = Math.floor(Date.now() / 1000) - unixSeconds;
	if (diff < 5) return 'just now';
	if (diff < 60) return `${diff}s ago`;
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
	return new Date(unixSeconds * 1000).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});
}

/** "in 3m", "in 2h", "in 5d" from a FUTURE unix-seconds timestamp — the
 *  forward-looking mirror of timeAgo (e.g. session expiry). A timestamp that's
 *  already past reads as "now". */
export function expiresIn(unixSeconds: number | null | undefined): string {
	if (!unixSeconds) return '—';
	const diff = unixSeconds - Math.floor(Date.now() / 1000);
	if (diff < 5) return 'now';
	if (diff < 60) return `in ${diff}s`;
	if (diff < 3600) return `in ${Math.floor(diff / 60)}m`;
	if (diff < 86400) return `in ${Math.floor(diff / 3600)}h`;
	if (diff < 86400 * 30) return `in ${Math.floor(diff / 86400)}d`;
	return new Date(unixSeconds * 1000).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});
}

export function formatDateTime(unixSeconds: number | null | undefined): string {
	if (!unixSeconds) return '—';
	return new Date(unixSeconds * 1000).toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
}

export function formatBytes(bytes: number): string {
	if (bytes < 1000) return `${bytes} B`;
	if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
	if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
	if (bytes < 1_000_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
	return `${(bytes / 1_000_000_000_000).toFixed(2)} TB`;
}

/** Format a hashrate given in H/s */
export function formatHashrate(hs: number): string {
	const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s', 'ZH/s'];
	let i = 0;
	while (hs >= 1000 && i < units.length - 1) {
		hs /= 1000;
		i++;
	}
	return `${hs.toFixed(hs >= 100 ? 0 : 1)} ${units[i]}`;
}

/** BTC amount * spot price -> USD amount (bead cairn-vnfs fiat foundation). */
export function btcToFiat(btcAmount: number, usdPrice: number): number {
	return btcAmount * usdPrice;
}

/**
 * DESIGN-MANIFESTO.md §3 money-typesetting rule 3 (MUST): BTC/sats is the
 * hero line, fiat is a muted secondary line, BY DEFAULT — a saver's BTC
 * balance only grows, so fiat-first framing makes roughly half of all
 * balance check-ins feel like losses (myopic loss aversion). Amount.svelte
 * consults this to decide which value fills its `.line.primary` slot.
 *
 * Fiat only takes the primary slot when BOTH a fiat value actually rendered
 * (fiatText non-null — no price loaded yet always collapses to the BTC-only
 * layout, independent of preference) AND the user explicitly opted into
 * fiat-primary display (Settings -> Display, default OFF). That explicit
 * choice is a durable per-user preference, not a one-off override — once set
 * it keeps winning over the sats-first default (cairn-6ppq).
 */
export function isFiatPrimary(fiatPrimaryPref: boolean, fiatText: string | null): boolean {
	return fiatPrimaryPref && fiatText != null;
}

/**
 * Single source of truth for "what price should a Home-page Amount show" given
 * the hero's privacy-gated fiat toggle (cairn-r7si). The hero's `showFiat` flag
 * is opt-in and OFF by default; every Amount on Home — the hero balance *and*
 * the recent-activity feed directly below it — must resolve through this so the
 * privacy gate the hero establishes actually covers the whole page instead of
 * stopping at the hero component. Returns `null` (BTC-only) when fiat is off or
 * the price hasn't loaded yet, otherwise the loaded USD price.
 */
export function gatedFiatPrice(showFiat: boolean, usdPrice: number | null): number | null {
	return showFiat ? usdPrice : null;
}

/**
 * Central enforcement point for the Settings -> Display "Fiat display:
 * Hidden / USD shown" toggle (cairn-r494). Amount.svelte is the only place a
 * fiat figure ever reaches the screen, so this is where the setting is
 * enforced — not at each of Amount's ~20 call sites. Before this, only the
 * three page heroes (Home, wallet-detail, multisig-detail) remembered to
 * compute their own gated `price` via `gatedFiatPrice()`; every other call
 * site (tx rows, fee lines, address balances, …) passed no `price` at all and
 * fell through to Amount's default live `$btcUsd` subscription, which had no
 * idea the setting existed — a dollar figure could always leak through simply
 * by a call site forgetting to gate itself.
 *
 * `fiatVisible` wins unconditionally: when false this returns `null` (forcing
 * the BTC-only look) even if a call site explicitly passed a non-null
 * `price` — "Hidden" must mean hidden regardless of what any one call site
 * thinks it knows, not just when a call site remembers to ask nicely. Only
 * when `fiatVisible` is true does the normal price resolution apply: an
 * explicit `price` prop (including an explicit `null`, e.g. a hero's own
 * not-yet-loaded snapshot) wins over the live store; omitting `price`
 * entirely (`undefined`) falls back to the shared live-ticking store.
 */
export function resolveAmountPrice(
	fiatVisible: boolean,
	explicitPrice: number | null | undefined,
	liveStorePrice: number | null
): number | null {
	if (!fiatVisible) return null;
	return explicitPrice === undefined ? liveStorePrice : explicitPrice;
}

/** 1234.5 -> "$1,234.50"; large amounts compact to "$1.2M" etc. */
export function formatFiat(usd: number): string {
	const abs = Math.abs(usd);
	if (abs >= 1_000_000) {
		return new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency: 'USD',
			notation: 'compact',
			maximumFractionDigits: 1
		}).format(usd);
	}
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	}).format(usd);
}

/**
 * Sub-1 sat/vB rates are honest data now that some nodes relay below the historical
 * 1 sat/vB floor (cairn-eacw). One decimal place is fine down to ~0.05 sat/vB, but
 * below that `toFixed(1)` rounds to "0.0" — collapsing a real nonzero rate to a
 * dishonest "0" (Cardinal rule: a missing/unknown value renders as nothing, never
 * as a fake zero; here the value is real and simply small). Widen precision only
 * as far as needed to keep the first significant digit visible.
 */
export function formatFeeRate(satPerVb: number | null | undefined): string {
	if (satPerVb == null) return '—';
	if (satPerVb <= 0) return '0 sat/vB';
	if (satPerVb >= 10) return `${Math.round(satPerVb)} sat/vB`;
	for (const decimals of [1, 2, 3, 4]) {
		const fixed = satPerVb.toFixed(decimals);
		if (Number(fixed) > 0) {
			const trimmed = fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
			return `${trimmed} sat/vB`;
		}
	}
	// Astronomically small but still >0 — show the smallest precision tried above
	// rather than ever rendering a real positive rate as "0".
	return `${satPerVb.toFixed(4)} sat/vB`;
}

/** "~N BTC moved" from a block's total_out (sats): compact whole numbers for
 *  big blocks, a little more precision for small ones. Renders nothing for
 *  null/non-finite/<=0 (Cardinal rule: a missing snapshot key or a 0 placeholder
 *  means "unknown", never a real answer -- a real block always moves >0 value,
 *  so 0 here can only be a bug, not a fact). Hardened against `undefined`
 *  (missing key on an imperfect snapshot) and non-finite values, not just a
 *  strict `=== null` check (cairn-6efi.11). */
export function formatMovedBtc(totalOut: number | null | undefined): string | null {
	if (totalOut == null || !Number.isFinite(totalOut) || totalOut <= 0) return null;
	const btc = totalOut / SATS_PER_BTC;
	if (btc >= 100) return `~${formatNumber(Math.round(btc))} BTC`;
	if (btc >= 1) return `~${btc.toFixed(1)} BTC`;
	return `~${btc.toFixed(3)} BTC`;
}

/** "a1b2c3…d4e5f6" */
export function truncateMiddle(s: string, head = 8, tail = 8): string {
	if (s.length <= head + tail + 1) return s;
	return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/**
 * Splits a string into fixed-size chunks left-to-right ("bc1qx8k2…9f4d" ->
 * ["bc1q", "x8k2", …, "9f4d"]), the last chunk shorter if the length doesn't
 * divide evenly. Used to render a full address in scannable groups (R2,
 * docs/UX-PSYCHOLOGY-RESEARCH-2026-07-15.md) — the full string stays on
 * screen (unlike truncateMiddle), just visually segmented so the first/last
 * groups (what wrong-send forensics shows people actually compare) can be
 * emphasized while the middle is muted.
 */
export function chunkString(s: string, size = 4): string[] {
	if (size <= 0) return [s];
	const chunks: string[] = [];
	for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size));
	return chunks;
}

export function formatDuration(seconds: number): string {
	if (seconds < 90) return `${Math.round(seconds)}s`;
	if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
	return `${(seconds / 3600).toFixed(1)} h`;
}
