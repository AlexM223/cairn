import type { Handle, HandleServerError } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { getSessionUser, SESSION_COOKIE } from '$lib/server/auth';
import { childLogger } from '$lib/server/logger';

const httpLog = childLogger('http');
const errLog = childLogger('error');

// Static assets and build output aren't worth a log line each (and the SPA
// fetches a lot of them). Everything else — pages, API, form actions — is.
function isAsset(pathname: string): boolean {
	if (pathname.startsWith('/_app/')) return true;
	if (pathname === '/favicon.ico' || pathname === '/favicon.png' || pathname === '/robots.txt')
		return true;
	return /\.(?:js|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot)$/i.test(pathname);
}

// Bitcoin lookups are sensitive: a request path can carry a txid, block hash, or
// address that ties a user to on-chain activity. Truncate those before they
// reach the logs (which an operator may ship elsewhere). Non-sensitive segments
// pass through untouched.
function redactSegment(seg: string): string {
	if (/^[0-9a-fA-F]{64}$/.test(seg)) return `${seg.slice(0, 8)}…`; // txid / block hash
	if (/^(bc1|tb1|bcrt1)[a-z0-9]{6,}$/i.test(seg)) return `${seg.slice(0, 10)}…`; // bech32
	if (/^[13mn2][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(seg)) return `${seg.slice(0, 8)}…`; // base58
	return seg;
}

function redactPath(pathname: string): string {
	return pathname.split('/').map(redactSegment).join('/');
}

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = getSessionUser(event.cookies.get(SESSION_COOKIE));

	const { pathname } = event.url;
	if (isAsset(pathname)) return resolve(event);

	const method = event.request.method;
	const path = redactPath(pathname);
	const start = performance.now();

	const response = await resolve(event);

	const ms = Math.round(performance.now() - start);
	const status = response.status;
	const userId = event.locals.user?.id;
	const line = `${method} ${path} ${status} ${ms}ms${userId ? ` user=${userId}` : ''}`;
	const fields = { method, path, status, ms, userId };

	// Level scales with the outcome so an operator can filter to just the trouble.
	if (status >= 500) httpLog.error(fields, line);
	else if (status >= 400) httpLog.warn(fields, line);
	else httpLog.info(fields, line);

	return response;
};

/**
 * Runs for errors thrown while handling a request. Only 5xx failures are true
 * server errors: those get a full stack logged under a short error ID, and the
 * client sees only "Something went wrong" + that ID so an operator can grep the
 * logs for the exact failure without leaking internals. 404s and other <500s
 * reach here in this SvelteKit version but are expected — the request-logging
 * above already recorded them, so we leave SvelteKit's default error shape
 * untouched (no stack, no error ID on a plain "not found" page).
 */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	if (status < 500) return;

	const errorId = randomBytes(4).toString('hex');
	errLog.error(
		{
			err: error,
			errorId,
			status,
			method: event.request.method,
			path: redactPath(event.url.pathname),
			userId: event.locals.user?.id
		},
		message || 'Unhandled server error'
	);

	return { message: 'Something went wrong', errorId };
};
