// src/lib/server/featureFlags/registry.ts
//
// The canonical list of feature flags lives HERE, in code — not in the
// database. The DB only stores deviations from each flag's default (see
// docs/FEATURE-FLAGS-PLAN.md §1.1). Adding a flag is a one-line append below
// plus wiring its enforcement call site(s); no migration, no admin-UI change
// (the toggle grid and per-user override grid are both generated from this
// array).

export type FeatureFlagCategory =
	| 'wallet'
	| 'hardware'
	| 'notifications'
	| 'marketing'
	| 'upcoming';

export interface FeatureFlagDef {
	/** Stable id, referenced in code and DB — never rename, only deprecate. */
	key: string;
	/** Admin toggle-grid label. */
	label: string;
	/** Admin-facing helper text (what turning this off actually does). */
	description: string;
	category: FeatureFlagCategory;
	/** Shown to the end user when the resolved value is false. */
	userMessage: string;
	/**
	 * Literal `true` — a flag can NEVER ship pre-disabled. Typed as the literal
	 * `true` (not `boolean`) so a flag that defaults off fails to type-check,
	 * making the migration-safety contract (§6) a compiler guarantee.
	 */
	defaultEnabled: true;
}

export const FEATURE_FLAGS: FeatureFlagDef[] = [
	// wallet
	{
		key: 'send',
		category: 'wallet',
		label: 'Send / spend',
		description: 'Build and broadcast outgoing transactions. Off = read-only wallet.',
		userMessage: 'Sending has been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'multisig_create',
		category: 'wallet',
		label: 'Create multisig wallets',
		description:
			'Off = user can still use/sign existing multisig wallets shared with them, but cannot create new ones (single-sig only).',
		userMessage: 'Creating multisig wallets has been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'coin_control',
		category: 'wallet',
		label: 'Coin control',
		description: 'Manual UTXO selection in the send flow.',
		userMessage: 'Coin control has been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'csv_export',
		category: 'wallet',
		label: 'CSV export',
		description: 'Transaction history export.',
		userMessage: 'CSV export has been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'address_book',
		category: 'wallet',
		label: 'Address book',
		description: 'Saved recipient contacts.',
		userMessage: 'The address book has been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'qr_scan',
		category: 'wallet',
		label: 'Camera / QR scanning',
		description: 'Scanning addresses, PSBTs, and descriptors with the device camera.',
		userMessage: 'Camera scanning has been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'stateless_signer',
		category: 'wallet',
		label: 'Stateless / airgapped signer',
		description:
			'QR- and file-based PSBT signing (device_type "qr"/"file") for users without a supported USB device.',
		userMessage: 'Airgapped signing has been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'wallet_config_export',
		category: 'wallet',
		label: 'Export wallet config',
		description: 'Download Caravan-format wallet config / backup file.',
		userMessage: 'Exporting wallet configs has been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'wallet_config_import',
		category: 'wallet',
		label: 'Import wallet config',
		description: 'Import an existing Caravan-format wallet config.',
		userMessage: 'Importing wallet configs has been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'explorer',
		category: 'wallet',
		label: 'Block explorer',
		description: 'In-app address/tx explorer view.',
		userMessage: 'The explorer has been disabled by your administrator.',
		defaultEnabled: true
	},

	// hardware — one per driver in src/lib/hw/
	{
		key: 'hw_trezor',
		category: 'hardware',
		label: 'Trezor',
		description: '',
		userMessage: 'Trezor support has been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'hw_ledger',
		category: 'hardware',
		label: 'Ledger',
		description: '',
		userMessage: 'Ledger support has been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'hw_coldcard',
		category: 'hardware',
		label: 'Coldcard',
		description: '',
		userMessage: 'Coldcard support has been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'hw_bitbox02',
		category: 'hardware',
		label: 'BitBox02',
		description: '',
		userMessage: 'BitBox02 support has been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'hw_jade',
		category: 'hardware',
		label: 'Jade',
		description: '',
		userMessage: 'Jade support has been disabled by your administrator.',
		defaultEnabled: true
	},

	// notifications — one per NOTIFICATION_CHANNELS entry (in-app is baseline, never flagged)
	{
		key: 'notify_email',
		category: 'notifications',
		label: 'Email channel',
		description: '',
		userMessage: 'Email notifications have been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'notify_telegram',
		category: 'notifications',
		label: 'Telegram channel',
		description: '',
		userMessage: 'Telegram notifications have been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'notify_ntfy',
		category: 'notifications',
		label: 'ntfy channel',
		description: '',
		userMessage: 'ntfy notifications have been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'notify_nostr',
		category: 'notifications',
		label: 'Nostr channel',
		description: '',
		userMessage: 'Nostr notifications have been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'notify_webhook',
		category: 'notifications',
		label: 'Webhook channel',
		description: '',
		userMessage: 'Webhook notifications have been disabled by your administrator.',
		defaultEnabled: true
	},

	// marketing — instance-to-user messaging surfaces (never wallet functionality)
	{
		key: 'announcement_banners',
		category: 'marketing',
		label: 'Announcement banners',
		description:
			'Instance-wide banners (maintenance notices, warnings, promotions) shown to all users. Off = no banners render and the admin announcements page is disabled.',
		userMessage: 'Announcements have been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'referral_links',
		category: 'marketing',
		label: 'Referral links',
		description:
			'Buy-a-device links in the wallet wizards/signing flows and managed multisig service suggestions. Official troubleshooting links are not affected. Off = all referral UI hidden.',
		userMessage: 'Referral links have been disabled by your administrator.',
		defaultEnabled: true
	},

	// upcoming — features not built yet; the flag ships with the epic, not after
	{
		key: 'batch_transactions',
		category: 'upcoming',
		label: 'Batch transactions',
		description: '',
		userMessage: 'Batch transactions have been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'fee_bumping',
		category: 'upcoming',
		label: 'RBF / CPFP fee bumping',
		description: 'Tracks docs/CPFP-UNCONFIRMED-PLAN.md (cairn-u9ob).',
		userMessage: 'Fee bumping has been disabled by your administrator.',
		defaultEnabled: true
	},
	{
		key: 'tx_review',
		category: 'upcoming',
		label: 'Private mempool / tx review',
		description: '',
		userMessage: 'This feature has been disabled by your administrator.',
		defaultEnabled: true
	}
];

/** O(1) lookup by key, used by the resolution engine and requireFeature(). */
export const FEATURE_FLAGS_BY_KEY: Map<string, FeatureFlagDef> = new Map(
	FEATURE_FLAGS.map((f) => [f.key, f])
);

/** Registry keys in a stable Set — handy for validating incoming admin form input. */
export const FEATURE_FLAG_KEYS: ReadonlySet<string> = new Set(FEATURE_FLAGS.map((f) => f.key));
