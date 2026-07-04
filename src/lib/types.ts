// Shared types used across client and server.

export interface SessionUser {
	id: number;
	email: string;
	displayName: string;
	isAdmin: boolean;
}

export type ScriptType = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh' | 'p2tr';

export interface WalletSummary {
	id: number;
	name: string;
	type: 'xpub';
	scriptType: ScriptType;
	xpub: string;
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
}

export interface TxVout {
	address: string | null;
	value: number; // sats
	scriptType: string;
	spent: boolean | null;
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
