// cairn-0tvez: creating a wallet/multisig must (re)subscribe its addresses to
// the address watcher immediately — not wait for the watcher's 5-minute
// periodic pass — so a wallet funded soon after creation already has a live
// scripthash subscription in place. Without it, nothing marks the wallet
// dirty when it's funded, and the wallet/multisig detail page can serve an
// empty snapshot forever (the QA repro: fund within ~1 minute of creation,
// balance stays "0.00 BTC" indefinitely).
//
// The call is skipped when the watcher hasn't started (state.started false —
// true of every OTHER unit test in this repo, since startAddressWatcher() is
// only ever invoked from hooks.server.ts at real app boot, plus the narrow
// pre-boot window in production) so it never opens a real Electrum socket
// outside a running app. See the getWatcherScanProgress().started guard in
// wallets.ts's createWallet and wallets/multisig.ts's createMultisig.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HDKey } from '@scure/bip32';

const { refreshWatchesMock, startedMock } = vi.hoisted(() => ({
	refreshWatchesMock: vi.fn(async () => {}),
	startedMock: vi.fn(() => false)
}));

// Full mock replacement — NOT a partial spread of the real module. wallets.ts
// and wallets/multisig.ts are the only two importers of './addressWatcher' in
// this file's module graph, and addressWatcher.ts itself imports back from
// wallets/multisig.ts (toMultisigConfig/MultisigRow) — a real circular import.
// Spreading `await orig()` here would pull the REAL addressWatcher.ts into the
// graph to get the rest of its exports, which re-triggers that cycle and lets
// wallets/multisig.ts's `import { refreshWatches, getWatcherScanProgress }`
// bind to the real (unmocked) functions instead of these mocks. A full
// replacement with only the handful of exports these two modules actually use
// sidesteps the cycle entirely.
vi.mock('./addressWatcher', () => ({
	unwatchWallet: vi.fn(),
	unwatchMultisig: vi.fn(),
	refreshWatches: refreshWatchesMock,
	getWatcherScanProgress: () => ({
		started: startedMock(),
		baselined: false,
		totalAddresses: 0,
		scannedAddresses: 0
	})
}));

import { db } from './db';
import { registerUser } from './auth';
import { setSetting } from './settings';
import { createWallet } from './wallets';
import { createMultisig, type NewMultisigKey } from './wallets/multisig';

const XPUB =
	'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';

function wipe(): void {
	db.exec(
		'DELETE FROM multisig_keys; DELETE FROM multisigs; DELETE FROM wallets; DELETE FROM sessions; DELETE FROM users; DELETE FROM settings;'
	);
}

beforeEach(() => {
	wipe();
	setSetting('registration_mode', 'open');
	refreshWatchesMock.mockClear();
	startedMock.mockReset();
});

function makeUser(email: string) {
	return registerUser({ email, password: 'correct horse battery', displayName: email.split('@')[0] });
}

const BIP48_PATH = "m/48'/0'/0'/2'";
function fixtureKey(seedByte: number): { xpub: string; fingerprint: string; path: string } {
	const master = HDKey.fromMasterSeed(new Uint8Array(32).fill(seedByte));
	const account = master.derive(BIP48_PATH);
	return {
		xpub: account.publicExtendedKey,
		fingerprint: (master.fingerprint >>> 0).toString(16).padStart(8, '0'),
		path: BIP48_PATH
	};
}
function newMultisigKey(seedByte: number, name: string): NewMultisigKey {
	return { name, category: 'hardware', deviceType: 'trezor', ...fixtureKey(seedByte) };
}

describe('createWallet triggers an immediate watch subscription (cairn-0tvez)', () => {
	it('calls refreshWatches when the watcher has already started', async () => {
		startedMock.mockReturnValue(true);
		const user = await makeUser('watch-a@example.com');

		createWallet(user.id, { name: 'W', xpub: XPUB });

		expect(refreshWatchesMock).toHaveBeenCalled();
	});

	it('does NOT call refreshWatches when the watcher has not started yet', async () => {
		startedMock.mockReturnValue(false);
		const user = await makeUser('watch-b@example.com');

		createWallet(user.id, { name: 'W', xpub: XPUB });

		expect(refreshWatchesMock).not.toHaveBeenCalled();
	});
});

describe('createMultisig triggers an immediate watch subscription (cairn-0tvez)', () => {
	it('calls refreshWatches when the watcher has already started', async () => {
		startedMock.mockReturnValue(true);
		const user = await makeUser('watch-c@example.com');

		createMultisig(user.id, {
			name: 'MS',
			threshold: 2,
			keys: [newMultisigKey(1, 'Key A'), newMultisigKey(2, 'Key B'), newMultisigKey(3, 'Key C')]
		});

		expect(refreshWatchesMock).toHaveBeenCalled();
	});

	it('does NOT call refreshWatches when the watcher has not started yet', async () => {
		startedMock.mockReturnValue(false);
		const user = await makeUser('watch-d@example.com');

		createMultisig(user.id, {
			name: 'MS2',
			threshold: 2,
			keys: [newMultisigKey(4, 'Key A'), newMultisigKey(5, 'Key B'), newMultisigKey(6, 'Key C')]
		});

		expect(refreshWatchesMock).not.toHaveBeenCalled();
	});
});
