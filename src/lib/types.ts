// Shared types used across client and server.

export interface SessionUser {
	id: number;
	email: string;
	displayName: string;
	isAdmin: boolean;
}

/** Metadata about one registered passkey (WebAuthn credential), safe for the client. */
export interface CredentialInfo {
	id: number;
	name: string | null;
	/** 'singleDevice' | 'multiDevice' — a multiDevice passkey syncs (iCloud/Google). */
	deviceType: string | null;
	backedUp: boolean;
	transports: string[];
	createdAt: string;
	lastUsedAt: string | null;
}

export type ScriptType = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh' | 'p2tr';

/**
 * Which signing device holds a single-sig wallet's key. Drives the send
 * flow's Sign step and how the wallet is labelled in the UI. `null` = the
 * user hasn't told us yet; treated as file-based signing (the universal
 * fallback), so a wallet is never a dead-end "watch-only" viewer.
 */
export type WalletDeviceType =
	| 'trezor'
	| 'ledger'
	| 'coldcard'
	| 'bitbox02'
	| 'jade'
	| 'jade-qr'
	| 'qr'
	| 'file';

export interface WalletSummary {
	id: number;
	name: string;
	type: 'xpub';
	scriptType: ScriptType;
	xpub: string;
	/** Signing device on record, or null when unspecified (file-based fallback). */
	deviceType: WalletDeviceType | null;
	createdAt: string;
	/** Confirmed balance in sats */
	balance: number;
	/** Unconfirmed delta in sats */
	unconfirmed: number;
	lastActivity: number | null; // unix seconds of most recent tx, null if none
}

export interface WalletAddress {
	address: string;
	derivationPath: string;
	index: number;
	change: boolean;
	used: boolean;
	balance: number; // sats
	txCount: number;
}

export interface WalletTx {
	txid: string;
	height: number; // 0 or -1 = unconfirmed
	time: number | null; // unix seconds, null if unconfirmed
	/** Net effect on the wallet in sats (positive = received) */
	delta: number;
	fee: number | null;
}

export interface BlockSummary {
	height: number;
	hash: string;
	time: number;
	/** Transactions in the block, or null when unknown (Electrum-only baseline,
	 *  no Core RPC). Cardinal rule: unknown reads as unknown, never a false 0. */
	txCount: number | null;
	/** Serialized size in bytes, or null when unknown (Electrum-only baseline). */
	size: number | null; // bytes
	/** Block weight in weight units, or null when unknown. */
	weight: number | null;
	medianFee: number | null; // sat/vB
	feeRange: [number, number] | null; // sat/vB
	/** Sum of all output values in sats, or null when unknown. Filled from
	 *  getblockstats `total_out` when Core RPC is configured. */
	total_out: number | null;
	/** Block fullness 0..1 (weight ÷ 4,000,000 WU), or null when weight unknown. */
	fullness: number | null;
	miner?: string;
	/** Mining pool identified from the coinbase (T-C, cairn-6efi.4), or null when
	 *  the coinbase matches no known pool. Only ever a POSITIVE identification —
	 *  an unknown coinbase stays null so the UI never shows a wrong pool. */
	pool?: BlockPool | null;
}

/** A mining pool identified from a block's coinbase transaction. */
export interface BlockPool {
	/** Display name, e.g. "Foundry USA". Rendered as "Likely {name}". */
	name: string;
	/** Pool homepage, when the vendored DB carries one. */
	link?: string;
}

export interface BlockDetail extends BlockSummary {
	prevHash: string | null;
	merkleRoot: string;
	nonce: number;
	bits: string;
	difficulty: number;
	version: number;
	totalFees: number | null; // sats
	reward: number | null; // sats, subsidy + fees
}

export interface TxVin {
	txid: string | null; // null for coinbase
	vout: number | null;
	address: string | null;
	value: number | null; // sats
	/** scriptPubKey of the spent output, hex; null for coinbase or when unknown. */
	prevScriptPubKey: string | null;
	coinbase: boolean;
	scriptSig: string | null; // hex, null when empty/absent
	witness: string[] | null; // hex items, null when non-segwit input
}

export interface TxVout {
	address: string | null;
	value: number; // sats
	scriptType: string;
	scriptPubKey: string; // hex
	spent: boolean | null;
}

/** One step of a replace-by-fee timeline, oldest first. */
export interface RbfStep {
	txid: string;
	time: number | null; // unix seconds when this version was seen
}

export interface RbfInfo {
	/** Replacement sequence oldest → newest (the newest is the live version). */
	chain: RbfStep[];
	fullRbf: boolean;
}

/** Child-pays-for-parent context for an unconfirmed transaction. */
export interface CpfpInfo {
	/** Package fee rate miners actually evaluate, sat/vB. */
	effectiveFeeRate: number;
	ancestors: string[]; // txids
	descendants: string[]; // txids
}

export interface TxDetail {
	txid: string;
	confirmed: boolean;
	blockHeight: number | null;
	blockHash: string | null;
	blockTime: number | null;
	confirmations: number;
	size: number;
	vsize: number;
	weight: number;
	fee: number | null; // sats
	feeRate: number | null; // sat/vB
	locktime: number;
	version: number;
	/** Uses Segregated Witness (weight savings vs legacy format) */
	segwit: boolean;
	/** Signals BIP125 replace-by-fee (any input sequence < 0xfffffffe) */
	rbf: boolean;
	vin: TxVin[];
	vout: TxVout[];
}

export interface AddressInfo {
	address: string;
	scriptType: string | null;
	confirmedBalance: number; // sats
	unconfirmedBalance: number; // sats
	txCount: number;
	totalReceived: number | null; // sats
	totalSent: number | null; // sats
	used: boolean;
}

export interface AddressTx {
	txid: string;
	height: number; // 0 = mempool
	time: number | null;
	fee: number | null;
	delta: number | null; // net effect on this address in sats, null if unknown
}

export interface MempoolSummary {
	txCount: number;
	vsize: number; // total vbytes
	totalFees: number; // sats
}

/** [feeRate sat/vB, vsize] pairs, highest rate first. */
export type FeeHistogram = [number, number][];

/** A projected block assembled from the mempool by fee rate. */
export interface MempoolBlockProjection {
	nTx: number;
	vsize: number;
	totalFees: number; // sats
	medianFee: number; // sat/vB
	feeRange: [number, number]; // sat/vB
}

/** One point of mempool history (for the trend sparkline). */
export interface MempoolTrendPoint {
	time: number; // unix seconds
	vsize: number; // virtual bytes waiting
	txCount: number;
}

/** State of the current 2,016-block difficulty epoch. */
export interface DifficultyInfo {
	currentDifficulty: number;
	tipHeight: number;
	epochStartHeight: number;
	nextRetargetHeight: number;
	blocksIntoEpoch: number; // 0..2015
	blocksRemaining: number;
	progressPercent: number;
	/** Projected retarget, e.g. +3.2 means difficulty rises ~3.2%. Null when unknown. */
	projectedChangePercent: number | null;
	/** The change applied at the previous retarget. Null when unknown. */
	previousChangePercent: number | null;
	/** Average block interval this epoch, seconds. Null when unknown. */
	avgBlockTimeSeconds: number | null;
	/** Unix seconds. Null when unknown. */
	estimatedRetargetDate: number | null;
}

/** One historical difficulty retarget. */
export interface DifficultyAdjustment {
	time: number; // unix seconds
	height: number;
	difficulty: number;
	/** Percent change vs the previous difficulty; null for the oldest sample. */
	changePercent: number | null;
}

export interface FeeEstimates {
	fastest: number; // next block, sat/vB
	halfHour: number;
	hour: number;
	economy: number;
}

export interface NodeInfo {
	connected: boolean;
	mode: 'public' | 'custom';
	server: string; // host:port of electrum server
	serverBanner?: string;
	tipHeight: number | null;
	tipHash: string | null;
	network: 'mainnet' | 'testnet';
	error?: string;
}

// ------------------------------------------------------------------ NodeTrust
//
// The "Verified by your node" provenance indicator for the Explorer heroes
// (cairn-6efi.3, Wave 2 track T-B). The trust CLAIM the UI is allowed to make
// is derived exclusively from server config + a cached (never freshly probed)
// connection signal, and it lives in exactly ONE constant lookup table
// (nodeTrust.ts's TRUST_SPECS) so the honesty matrix (Explorer-redesign
// Cardinal rule 2) is structurally impossible to violate: no code path
// interpolates a trust string, and only the `core-verified` cell — reachable
// only when Core RPC is genuinely configured AND connected — may say
// "Verified by your Bitcoin Core node".

/** The coarse, honestly-observable phase of the chain connection (mirrors
 *  syncStatus.ts's SyncPhase; redeclared here so this client-safe type file
 *  never imports a $lib/server module). */
export type NodeSyncPhase = 'connecting' | 'history' | 'scanning' | 'synced' | 'unreachable';

/** The exhaustive set of trust states — one cell of the honesty matrix each.
 *  Every kind maps to exactly one row of TRUST_SPECS. */
export type NodeTrustKind =
	| 'core-verified'
	| 'core-unreachable'
	| 'electrum-custom'
	| 'electrum-custom-unreachable'
	| 'public'
	| 'public-unreachable'
	| 'unconfigured';

/** Which backend the shown data provably came from. `none` = never configured. */
export type NodeTrustSource = 'core' | 'electrum' | 'public' | 'none';

/** Visual/semantic tone — drives the chip colour, not the claim. */
export type NodeTrustTone = 'verified' | 'own' | 'public' | 'warning' | 'idle';

export interface NodeTrust {
	kind: NodeTrustKind;
	source: NodeTrustSource;
	/** The single canonical trust claim on the chip. From TRUST_SPECS — NEVER interpolated. */
	label: string;
	/** The one-sentence popover headline. Also from TRUST_SPECS. */
	headline: string;
	tone: NodeTrustTone;
	/** True only when the shown data provably came from the operator's own
	 *  infrastructure (Core or a custom Electrum server) — gates the popover's
	 *  "Nothing here came from a third party" line. */
	ownInfrastructure: boolean;
	/** True ONLY for `core-verified`. Gates the literal word "Verified". */
	verified: boolean;
	/** Whether the chain transport is reachable right now, from a cached
	 *  in-memory signal (chainHealth) — never a fresh blocking probe. */
	connected: boolean;
	/** host:port / URL host of the active source, credentials stripped. null when unconfigured. */
	server: string | null;
	/** Latest known chain tip height from the persisted snapshot; null if none. */
	tipHeight: number | null;
	/** Coarse sync phase from cached signals; null when unknown/unconfigured. */
	syncPhase: NodeSyncPhase | null;
	/** How the chain connection was provisioned (umbrel-env, umbrel-probe, …) — display context only, never affects the claim. */
	provisionedBy: string | null;
	/** Epoch ms of the last successful background sync, for "last block seen …". null if never. */
	lastSyncedAt: number | null;
}

export interface SearchResult {
	type: 'block-height' | 'block-hash' | 'tx' | 'address' | 'unknown';
	redirect: string | null;
	query: string;
}

export interface InviteInfo {
	id: number;
	code: string;
	label: string | null;
	createdBy: number;
	createdByName?: string;
	maxUses: number;
	usedCount: number;
	expiresAt: string | null;
	createdAt: string;
	status: 'active' | 'exhausted' | 'expired' | 'revoked';
}

export interface AdminUserInfo {
	id: number;
	email: string;
	displayName: string;
	isAdmin: boolean;
	disabled: boolean;
	createdAt: string;
	/**
	 * Coarse activity signal instead of the exact last_login timestamp
	 * (cairn-o1dp.6): every admin sees this list, and "who has an account" does
	 * not need minute-level behavioral tracking of other users.
	 */
	lastActivity: 'recent' | 'inactive' | 'never';
	walletCount: number;
	/**
	 * True when this account has neither a passkey nor a password — the shape a
	 * backup restore produces (cairn-j1q9). Such an account cannot sign in at
	 * all until an admin mints it a recovery code (POST /api/admin/users
	 * { mintRecoveryCode: true }); the users list badges these so they don't go
	 * unnoticed.
	 */
	needsRecoveryCode: boolean;
}

export type RegistrationMode = 'open' | 'invite' | 'closed';

/**
 * 'solo' hides every multi-user management surface (admin users/invites,
 * contacts, multisig wallet sharing) — a fresh instance is a single-user
 * appliance until an admin explicitly unlocks 'team'. See
 * docs/SOLO-MODE-UMBREL-AUTOADMIN-PLAN.md Part 2.
 */
export type InstanceMode = 'solo' | 'team';

/** Aggregate balance across a user's wallets (dashboard portfolio card). */
export interface PortfolioSummary {
	walletCount: number;
	scannedCount: number;
	confirmed: number; // sats
	unconfirmed: number; // sats
}

/** Which kind of wallet a portfolio row refers to (ids don't share a space). */
export type WalletKind = 'wallet' | 'multisig';

/** One wallet's slice of the portfolio, for the allocation breakdown + cards. */
export interface AllocationSlice {
	/** Stable key for coloring/keying: `${kind}-${id}`. */
	key: string;
	kind: WalletKind;
	id: number;
	name: string;
	/** Link to this wallet's detail page. */
	href: string;
	balance: number; // confirmed sats
	/** Newest activity, unix seconds (null if none) — for the wallet cards. */
	lastActivity: number | null;
}

/** One transaction in the cross-wallet recent-activity feed. */
export interface PortfolioActivity {
	key: string; // `${kind}-${id}-${txid}`
	walletName: string;
	walletHref: string;
	txid: string;
	direction: 'in' | 'out';
	sats: number; // absolute value of the net delta
	time: number | null; // unix seconds, null if unconfirmed
	confirmations: number;
}

/** One point on the portfolio balance-over-time chart. */
export interface BalancePoint {
	t: number; // unix seconds
	sats: number; // total confirmed sats at that time
}

/** The full dashboard portfolio payload (served by /api/portfolio). */
export interface PortfolioDetail {
	walletCount: number;
	scannedCount: number;
	confirmed: number; // sats
	unconfirmed: number; // sats
	allocation: AllocationSlice[];
	recentActivity: PortfolioActivity[];
	/** Total value over time, oldest first (from accumulated snapshots). */
	balanceSeries: BalancePoint[];
	/** Per-wallet balance history, keyed by AllocationSlice.key; oldest first. */
	sparklines: Record<string, number[]>;
	/** Net sats change vs the snapshot nearest 1d / 7d / 30d ago; null if none. */
	change: { d1: number | null; d7: number | null; d30: number | null };
}

export interface InstanceSettings {
	registrationMode: RegistrationMode;
	instanceMode: InstanceMode;
	connectionMode: 'public' | 'custom';
	electrumHost: string;
	electrumPort: number;
	electrumTls: boolean;
	/** Skip TLS certificate validation for the Electrum connection. Off by
	 *  default: a valid, trusted certificate is required. Only turn this on for a
	 *  custom self-hosted Electrum server that presents a self-signed certificate
	 *  AND that you reach over a trusted network path — it disables the protection
	 *  against a man-in-the-middle feeding forged chain data (cairn-azei). */
	electrumTlsInsecure: boolean;
	/** Number of parallel Electrum connections (1–4). More connections let
	 *  address/balance lookups run concurrently instead of queuing on one socket;
	 *  1 disables pooling. Default 2 (cairn-ynfp). */
	electrumPoolSize: number;
	esploraUrl: string;
	/** SOCKS5 proxy for ALL chain traffic (Electrum + Esplora), e.g. Tor at
	 *  127.0.0.1:9050. Null = connect directly. Applies in both public and custom
	 *  connection modes so the operator's IP is never exposed to the chain backend
	 *  — including third-party public servers (cairn-oh7a). */
	socks5Host: string | null;
	socks5Port: number | null;
	coreRpcUrl: string | null;
	coreRpcUser: string | null;
	coreRpcPass: string | null;
	/** Provenance marker for a zero-config chain-backend connection (Umbrel
	 *  auto-connect, docs/UMBREL-AUTOCONNECT-DESIGN.md): 'umbrel-env' when the
	 *  Umbrel store compose's CAIRN_ELECTRUM and CAIRN_CORE_RPC env vars seeded
	 *  it (chainEnvSeed.ts), 'umbrel-probe' when the credential-free Electrum
	 *  probe found it (umbrelProbe.ts), or null for a manually-entered custom
	 *  connection / the public-server default. Purely informational — it only
	 *  changes what the settings UI renders, never which connection is active. */
	chainProvisionedBy: string | null;
	/** Pre-connect Umbrel Core RPC signal (Wave B, docs/UMBREL-AUTOCONNECT-WAVE-B-DESIGN.md
	 *  §6): 'umbrel' once umbrelCoreProbe.ts's credential-free probe finds a
	 *  bitcoind listener at the well-known Umbrel address, 'dismissed' once the
	 *  admin dismisses the resulting assisted-connect banner, or null before any
	 *  probe fires / on non-Umbrel deployments. Purely advisory — never consulted
	 *  by getChainConfig() and never implies a live connection. */
	coreRpcDetected: string | null;
	/** Post-connect Core RPC provenance (Wave B §6), deliberately separate from
	 *  the Electrum-scoped `chainProvisionedBy`: 'umbrel-env' when
	 *  chainEnvSeed.ts seeded core_rpc_url from CAIRN_CORE_RPC_* env vars,
	 *  'umbrel-detect' when the admin completed the assisted-connect flow that
	 *  started from `coreRpcDetected==='umbrel'`, or null when Core is
	 *  unconfigured or was entered by hand with no Umbrel involvement. */
	coreRpcProvisionedBy: string | null;
}
