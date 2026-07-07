// GET /api/chain-health — cheap, last-known health of the chain transport
// (Electrum pool / SOCKS5 proxy), polled by the (app)-layout ChainHealthBanner
// (cairn-hy8z). Everything behind it is an in-memory read derived from the
// Electrum client's connection outcomes — NO fresh probe — so polling is cheap
// and adds no chain traffic. Read-only.

import { json, requireUser } from '$lib/server/api';
import { getChainHealth } from '$lib/server/chainHealth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => {
	requireUser(event);
	return json(getChainHealth());
};
