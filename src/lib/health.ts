// The Health object (UX redesign Phase 3, cairn-gt05.3,
// docs/UX-REDESIGN-SPEC.md §2.6a/§2.6b): ONE derived aggregation over signals
// the app already computes elsewhere — chain-transport reachability
// (getNetworkHealth / /api/chain-health), the unbacked-wallet list
// (listUnbackedWallets, threaded through the (app) layout load), instance
// config-backup recency, and disk fullness. Nothing here polls or plumbs new
// data; it only unifies scattered signals into one verdict surfaced at three
// altitudes:
//
//   1. Home's one calm line        — homeLabel   ("Health · All good")
//   2. the layout banners          — per-duty status gates the amber grammar
//   3. the admin Health page       — headline + the four duty rows
//
// Every altitude calls THIS function, so the three can never tell three
// different stories about the same signal. Inputs an altitude can't see
// (storage and config-backup recency only exist on the admin load) are passed
// as null/omitted and count as 'unknown' — an unknown duty contributes zero
// issues rather than guessing, so Home's line only ever counts what Home can
// actually observe. Phase 1's deriveHomeHealth (src/lib/homeView.ts) is now a
// thin wrapper over this derivation.

/** 'unknown' = this altitude has no data for the duty (never an alarm). */
export type DutyStatus = 'ok' | 'attention' | 'unknown';

export interface HealthDuty {
	status: DutyStatus;
	/** How many attention items this duty contributes to the headline count. */
	issues: number;
}

export interface HealthInput {
	/**
	 * Chain transport reachability (the same boolean ChainHealthBanner and
	 * /api/chain-health serve). null = not yet determined (e.g. the admin page's
	 * transient just-booted "checking" window) — treated as unknown, not broken.
	 */
	chainHealthy: boolean | null;
	/** Wallets whose config has never been backed up (funds-risk if lost). */
	unbackedCount: number;
	/**
	 * Instance config backup is missing or older than the staleness window
	 * (admin altitude only — null/omitted elsewhere).
	 */
	configBackupStale?: boolean | null;
	/** How full the disk the database lives on is, 0–100 (admin only). */
	storagePctFull?: number | null;
	/** User counts (admin only). Informational — never an "issue". */
	users?: { total: number; admins: number } | null;
}

export interface HealthObject {
	/** False when at least one duty needs attention. */
	ok: boolean;
	/** Total attention items across all duties. */
	issueCount: number;
	/** Health-page headline (spec §2.6a): "All systems healthy" / "N things…". */
	headline: string;
	/** Home's one calm line (spec §2.6b) — exact Phase 1 copy, unchanged. */
	homeLabel: string;
	node: HealthDuty;
	backups: HealthDuty;
	storage: HealthDuty;
	users: HealthDuty;
}

/** Disk-fullness threshold past which the Storage duty turns amber. */
export const STORAGE_ATTENTION_PCT = 90;

function duty(issues: number): HealthDuty {
	return { status: issues > 0 ? 'attention' : 'ok', issues };
}

const UNKNOWN: HealthDuty = { status: 'unknown', issues: 0 };

export function deriveHealth(input: HealthInput): HealthObject {
	// Node: unreachable transport is one issue; an undetermined transport
	// (null — first boot, no attempt recorded yet) is unknown, never an alarm.
	const node: HealthDuty =
		input.chainHealthy === null ? UNKNOWN : duty(input.chainHealthy ? 0 : 1);

	// Backups: each unbacked wallet is its own issue (matches Phase 1's Home
	// line), plus one more when the instance config backup itself is stale —
	// the admin page's long-standing amber "Back up" nudge, now counted in the
	// same ledger instead of living beside it.
	const unbacked = Math.max(0, input.unbackedCount);
	const configStale = input.configBackupStale === true ? 1 : 0;
	const backups = duty(unbacked + configStale);

	// Storage: only the admin load can see the disk; anything else is unknown.
	const storage: HealthDuty =
		input.storagePctFull === null || input.storagePctFull === undefined
			? UNKNOWN
			: duty(input.storagePctFull >= STORAGE_ATTENTION_PCT ? 1 : 0);

	// Users: posture is informational (count + registration mode are links on
	// the Health page) — a user count is never something to be alarmed about.
	const users: HealthDuty = input.users ? duty(0) : UNKNOWN;

	const issueCount = node.issues + backups.issues + storage.issues + users.issues;
	return {
		ok: issueCount === 0,
		issueCount,
		headline:
			issueCount === 0
				? 'All systems healthy'
				: issueCount === 1
					? '1 thing needs your attention'
					: `${issueCount} things need your attention`,
		// Kept byte-identical to Phase 1's shipped copy (homeView.test.ts pins it).
		homeLabel: issueCount === 0 ? 'Health · All good' : `Health · ${issueCount} needs attention`,
		node,
		backups,
		storage,
		users
	};
}
