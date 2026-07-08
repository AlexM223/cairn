// A tiny in-process async mutex keyed by string (cairn-2qa4). Cairn runs as a
// single Node process against one shared SQLite handle, so serializing a
// critical section per key is enough to make a read-scan-derive-write flow
// atomic across concurrent callers — no cross-process locking is needed.
//
// Motivating bug: nextReceiveAddress (wallets.ts) and nextMultisigReceiveAddress
// (multisigScan.ts) each read a cursor, await a possibly-30s Electrum gap scan,
// derive an index, then write the cursor back. Two concurrent callers used to
// both read the same stale cursor before either wrote, derive the same index,
// and hand out the same address — worst for multisig, where collaborators
// genuinely call concurrently. withLock() below forces callers for the same
// key to run the critical section one at a time, in call order.
//
// Implementation: a tail-chain per key. Each call appends itself after the
// previous caller for that key and only starts once the previous one has
// settled — success or failure, so a failed holder never wedges the lock. The
// map entry is deleted once a key's chain drains, so it never grows unbounded.
const tails = new Map<string, Promise<void>>();

/** Run `fn` exclusively for `key`: at most one caller per key runs at a time,
 *  in call order. Returns (or rethrows) `fn`'s own outcome to its caller —
 *  an earlier caller's failure never propagates to a later one. */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = tails.get(key) ?? Promise.resolve();
	const result = previous.then(fn, fn);
	// Track this turn as the key's new tail. Swallow its rejection here (the
	// real error still reaches the caller via `result`) so an unawaited chain
	// entry never surfaces as an unhandled rejection.
	const tail = result.then(
		() => undefined,
		() => undefined
	);
	tails.set(key, tail);
	tail.finally(() => {
		if (tails.get(key) === tail) tails.delete(key);
	});
	return result;
}
