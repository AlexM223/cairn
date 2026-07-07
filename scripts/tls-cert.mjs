/**
 * Self-signed TLS certificate for Cairn's optional HTTPS listener (cairn-wgr8).
 *
 * Umbrel (Cairn's primary deployment target) serves apps over plain HTTP on
 * the LAN, which is not a browser "secure context" — so WebHID / Web Serial /
 * WebUSB (hardware-wallet signing) and camera QR scanning are unavailable.
 * Cairn therefore terminates TLS itself on a second port with a certificate
 * it generates ONCE at first boot and persists in the data volume. The
 * browser shows a one-time "connection is not private" warning for it (the
 * user proceeds via Advanced → Continue); after that the origin is a genuine
 * secure context and the device APIs work.
 *
 * Deliberately standalone (imported by server.mjs, which runs OUTSIDE the
 * SvelteKit build): node builtins + the `selfsigned` package only, no imports
 * from src/.
 */
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Regenerate rather than serve a certificate with less than this left. */
const MIN_REMAINING_DAYS = 30;
/** Lifetime of a freshly generated certificate. */
const VALIDITY_DAYS = 3650;

/**
 * The DNS names the certificate claims. Browsers warn on a self-signed cert
 * regardless of name matching, so this list is best-effort completeness (the
 * bypass works identically for a LAN-IP access), with Umbrel's hostname first.
 */
export const DEFAULT_HOSTS = ['umbrel.local', 'localhost', '*.local'];

/**
 * True when the PEM parses as X.509 and keeps at least MIN_REMAINING_DAYS of
 * validity — the "don't regenerate on every boot, but never serve an expiring
 * cert" test. Exported for unit tests.
 * @param {string} certPem
 * @param {Date} [now]
 */
export function certUsable(certPem, now = new Date()) {
	try {
		const cert = new X509Certificate(certPem);
		const expires = new Date(cert.validTo);
		const remainingMs = expires.getTime() - now.getTime();
		return remainingMs > MIN_REMAINING_DAYS * 24 * 60 * 60 * 1000;
	} catch {
		return false;
	}
}

/**
 * Generate a fresh self-signed key + certificate pair (PEM strings).
 * @param {string[]} [hosts]
 * @returns {Promise<{ key: string, cert: string }>}
 */
export async function generateCert(hosts = DEFAULT_HOSTS) {
	// Lazy import: `selfsigned` (node-forge under the hood) is only ever needed
	// on the rare boot that actually generates — not on every start.
	const selfsigned = (await import('selfsigned')).default;
	const notAfterDate = new Date(Date.now() + VALIDITY_DAYS * 24 * 60 * 60 * 1000);
	const pems = await selfsigned.generate([{ name: 'commonName', value: hosts[0] }], {
		notAfterDate,
		keySize: 2048,
		extensions: [
			{
				name: 'subjectAltName',
				altNames: [
					...hosts.map((h) => ({ type: /** @type {2} */ (2), value: h })), // DNS
					{ type: /** @type {7} */ (7), ip: '127.0.0.1' } // IP
				]
			}
		]
	});
	return { key: pems.private, cert: pems.cert };
}

/**
 * Load the persisted certificate from `dir`, generating (and persisting) a
 * fresh one when missing, unparsable, or within MIN_REMAINING_DAYS of expiry.
 * Returns { key, cert } PEM strings ready for node:https.
 * @param {string} dir
 * @param {string[]} [hosts]
 * @returns {Promise<{ key: string, cert: string }>}
 */
export async function ensureCert(dir, hosts = DEFAULT_HOSTS) {
	const keyPath = path.join(dir, 'key.pem');
	const certPath = path.join(dir, 'cert.pem');

	if (existsSync(keyPath) && existsSync(certPath)) {
		try {
			const key = readFileSync(keyPath, 'utf8');
			const cert = readFileSync(certPath, 'utf8');
			if (certUsable(cert)) return { key, cert };
		} catch {
			// unreadable → fall through and regenerate
		}
	}

	const fresh = await generateCert(hosts);
	mkdirSync(dir, { recursive: true });
	// The key never leaves the server; 0o600 is best-effort (no-op on Windows).
	writeFileSync(keyPath, fresh.key, { mode: 0o600 });
	writeFileSync(certPath, fresh.cert, { mode: 0o644 });
	return fresh;
}
