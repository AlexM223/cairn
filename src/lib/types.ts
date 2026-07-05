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
export type WalletDeviceType = 'trezor' | 'ledger' | 'coldcard' | 'qr' | 'file';

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
	txCount: number;
	size: number; // bytes
	weight: number;
	medianFee: number | null; // sat/vB
	feeRange: [number, number] | null; // sat/vB
	miner?: string;
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
	lastLogin: string | null;
	walletCount: number;
}

export type RegistrationMode = 'open' | 'invite' | 'closed';

/** Aggregate balance across a user's wallets (dashboard portfolio card). */
export interface PortfolioSummary {
	walletCount: number;
	scannedCount: number;
	confirmed: number; // sats
	unconfirmed: number; // sats
}

/** Which kind of wallet a portfolio row refers to (ids don't share a space). */
export type WalletKind = 'wallet' | 'multisig';

/** One wallet's slice of the portfolio, for the allocation breakdown. */
export interface AllocationSlice {
	/** Stable key for coloring/keying: `${kind}-${id}`. */
	key: string;
	kind: WalletKind;
	id: number;
	name: string;
	/** Link to this wallet's detail page. */
	href: string;
	balance: number; // confirmed sats
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
	connectionMode: 'public' | 'custom';
	electrumHost: string;
	electrumPort: number;
	electrumTls: boolean;
	esploraUrl: string;
	coreRpcUrl: string | null;
	coreRpcUser: string | null;
	coreRpcPass: string | null;
}
