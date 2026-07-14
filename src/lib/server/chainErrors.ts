// House pattern for scan/chain-connection failures that must never leak a raw
// Node socket error (e.g. "connect ECONNREFUSED 127.0.0.1:50001") to a
// user-facing surface (cairn-sgtr). A wallet/multisig scan failure's
// `e.message` is almost always the Electrum client's own error text, which in
// turn is very often just Node's transport error passed straight through
// (ECONNREFUSED, ETIMEDOUT, ENOTFOUND, a DNS EAI_AGAIN, …) — exactly the kind
// of internals the UX philosophy (plain language, no exposed Bitcoin/network
// internals) says a user should never see verbatim, whether it lands in a
// streamed page's scanError, a form action's fail(), or a JSON API error
// field.
//
// This is deliberately narrower than a blanket "never show e.message" rule:
// only the low-level *connectivity* class collapses to fixed copy. Any other
// error (a real validation/state problem the scan surfaced) passes through
// unchanged, since it's usually the one piece of text that lets the user (or
// an operator reading the same string) actually act on it — same philosophy
// as broadcastRejection.ts's friendlyBroadcastRejection, just for the
// "can't reach the chain backend at all" class instead of node rejections.
//
// The raw error is ALWAYS logged server-side first (via the caller's own
// childLogger, so /admin/logs tagging/attribution is unchanged) — sanitizing
// only ever narrows what the CLIENT sees, never what's on disk.

/**
 * Matches ElectrumClient's own connection wording (walletSync.ts's
 * isConnectClassError uses the identical set to decide whether a coalesced
 * refresh pass should abort rather than retry a dead server) plus the common
 * OS-level socket/DNS errno codes Node attaches to a failed dial.
 */
const CONNECTIVITY_PATTERN =
	/timed out|not connected|connection (?:error|closed|lost)|client (?:is )?closed|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i;

/** True for a connect/DNS/timeout-class failure — the transport itself is
 *  unreachable, as opposed to an application-level error the scan raised. */
export function isConnectivityError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return CONNECTIVITY_PATTERN.test(msg);
}

export const DEFAULT_CHAIN_ERROR_MESSAGE =
	"Can't reach the Electrum server. Check your node's connection and try again in a moment.";

/**
 * Pure classification, no logging — lets tests exercise the mapping directly.
 * A connectivity-class error always collapses to `connectivityMessage`;
 * anything else's own message passes through untouched, falling back to
 * `otherFallback` only for a non-Error throw (or an Error with an empty
 * message) — `otherFallback` defaults to `connectivityMessage` when omitted.
 */
export function classifyChainError(
	err: unknown,
	connectivityMessage: string = DEFAULT_CHAIN_ERROR_MESSAGE,
	otherFallback: string = connectivityMessage
): string {
	if (isConnectivityError(err)) return connectivityMessage;
	return err instanceof Error && err.message ? err.message : otherFallback;
}

/** Minimal logger shape this module needs — matches pino.Logger's `warn`
 *  without importing pino here, so this stays a plain, dependency-light
 *  string-mapping helper. */
interface WarnLogger {
	warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Log the raw error server-side first (via the caller's existing
 * `childLogger(...)` instance, so the warn line carries its usual `tag` plus
 * whatever `logContext` the call site already attached — mirrors every
 * existing `log.error({ err: e, ... })` this replaces; only the returned
 * STRING is narrowed, nothing is dropped from the logs), then return
 * {@link classifyChainError}'s UI-safe text.
 */
export function sanitizeChainError(
	err: unknown,
	log: WarnLogger,
	logContext: Record<string, unknown>,
	logMsg: string,
	connectivityMessage: string = DEFAULT_CHAIN_ERROR_MESSAGE,
	otherFallback: string = connectivityMessage
): string {
	log.warn({ err, ...logContext }, logMsg);
	return classifyChainError(err, connectivityMessage, otherFallback);
}
