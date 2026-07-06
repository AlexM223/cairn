// Contract every device signer component in the guided send flow implements.
//
// A signer receives the unsigned PSBT plus human-readable context (so it can
// tell the user what to verify on their device), drives its device-specific
// protocol, and returns a signed PSBT via `onsigned`. It never sees private
// keys — the device holds those. The parent Sign step takes the returned PSBT
// through the same server-side substitution guard and broadcast path as the
// generic file method, so a signer that returns the wrong transaction is still
// caught centrally.

export interface SignerContext {
	walletId: number;
	draftId: number;
	/** 'p2wpkh' | 'p2sh-p2wpkh' | 'p2pkh' | 'p2tr' */
	scriptType: string;
	/** Where the money is going — the signer MUST prompt the user to verify this on-device. */
	destinationAddress: string;
	amountSats: number;
	feeSats: number;
	changeSats: number;
}

export interface SignerProps {
	/** Unsigned transaction, base64 PSBT. */
	unsignedPsbt: string;
	context: SignerContext;
	/** Called with the signed PSBT (base64) once the device returns it. */
	onsigned: (signedPsbtBase64: string) => void;
	/** Optional: surfaced when the user backs out of a device flow. */
	oncancel?: () => void;
}

export interface DeviceMethod {
	key: string;
	name: string;
	/** One-line description shown on the method card. */
	blurb: string;
	/**
	 * Whether the method can run in this browser (e.g. WebHID/WebUSB support,
	 * BarcodeDetector for camera). Unsupported methods render disabled with a
	 * reason. Evaluated client-side only.
	 */
	available: () => boolean;
}
