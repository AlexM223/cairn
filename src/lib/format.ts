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
	return `${(bytes / 1_000_000).toFixed(2)} MB`;
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

export function formatFeeRate(satPerVb: number | null | undefined): string {
	if (satPerVb == null) return '—';
	return `${satPerVb < 10 ? satPerVb.toFixed(1).replace(/\.0$/, '') : Math.round(satPerVb)} sat/vB`;
}

/** "a1b2c3…d4e5f6" */
export function truncateMiddle(s: string, head = 8, tail = 8): string {
	if (s.length <= head + tail + 1) return s;
	return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function formatDuration(seconds: number): string {
	if (seconds < 90) return `${Math.round(seconds)}s`;
	if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
	return `${(seconds / 3600).toFixed(1)} h`;
}
