/**
 * Self-signed TLS certificate for Cairn's optional HTTPS listener (cairn-wgr8).
 *
 * Umbrel (Cairn's primary deployment target) serves apps over plain HTTP on
 * the LAN, which is not a browser "secure context" — so WebHID / Web Serial /
 * WebUSB (hardware-wallet signing) and camera QR scanning are unavailable.
 * Cairn therefore terminates TLS itself on a second port with a certificate
 * it generates at first boot and persists in the data volume, rotating it
 * shortly before expiry. The browser shows a "connection is not private"
 * warning for it (the user proceeds via Advanced → Continue); after that the
 * origin is a genuine secure context and the device APIs work. Users who want
 * to silence the warning permanently can instead import cert.pem into their
 * OS trust store — the certificate carries the extensions and validity Apple
 * and Windows require for that to actually take.
 *
 * Deliberately standalone (imported by server.mjs, which runs OUTSIDE the
 * SvelteKit build): node builtins + the `selfsigned` package only, no imports
 * from src/. selfsigned v5 generates keys with native WebCrypto
 * (crypto.subtle), so generation is sub-second even on ARM.
 */
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Regenerate rather than serve a certificate with less than this left. */
const MIN_REMAINING_DAYS = 30;
/**
 * Lifetime of a freshly generated certificate. Apple platforms refuse to
 * *trust* (import into the OS store) TLS server certs valid for more than
 * 825 days, so stay under that; rotation is automatic and the only cost of
 * the shorter life is one fresh browser warning every ~2 years.
 */
const VALIDITY_DAYS = 825;

/**
 * The DNS names the certificate claims. Browsers warn on a self-signed cert
 * regardless of name matching, so this list is best-effort completeness (the
 * bypass works identically for a LAN-IP access), with Umbrel's hostname first.
 */
export const DEFAULT_HOSTS = ['umbrel.local', 'localhost', '*.local'];

/**
 * DER-encoded OIDs of signature algorithms browsers and OS trust stores
 * reject outright. `selfsigned` < our sha256 fix defaulted to
 * sha1WithRSAEncryption, so certificates persisted by Cairn ≤ 0.1.6 carry it
 * and must be regenerated (node's X509Certificate does not expose the
 * signature algorithm, hence the raw-DER scan; an 11-byte match occurring by
 * chance inside key material is astronomically unlikely, and the worst case
 * is one needless regeneration).
 */
const WEAK_SIG_OIDS = [
	Buffer.from('06092a864886f70d010105', 'hex'), // sha1WithRSAEncryption
	Buffer.from('06092a864886f70d010104', 'hex') // md5WithRSAEncryption
];

/**
 * True when the PEM parses as X.509, is not signed with a browser-rejected
 * algorithm (SHA-1/MD5 — certs persisted by Cairn ≤ 0.1.6 were SHA-1), and
 * keeps at least MIN_REMAINING_DAYS of validity — the "don't regenerate on
 * every boot, but never serve a cert browsers will refuse" test. Exported
 * for unit tests.
 * @param {string} certPem
 * @param {Date} [now]
 */
export function certUsable(certPem, now = new Date()) {
	try {
		const cert = new X509Certificate(certPem);
		if (WEAK_SIG_OIDS.some((oid) => cert.raw.includes(oid))) return false;
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
	// Lazy import: cert assembly is only ever needed on the rare boot that
	// actually generates — not on every start.
	const selfsigned = (await import('selfsigned')).default;
	const notAfterDate = new Date(Date.now() + VALIDITY_DAYS * 24 * 60 * 60 * 1000);
	const pems = await selfsigned.generate([{ name: 'commonName', value: hosts[0] }], {
		notAfterDate,
		keySize: 2048,
		// selfsigned still defaults to SHA-1, which browsers and OS trust
		// stores reject — never omit this.
		algorithm: 'sha256',
		// Passing `extensions` REPLACES selfsigned's defaults, so spell out the
		// full leaf-certificate set: without keyUsage/extKeyUsage/basicConstraints
		// the "import into the OS trust store" path fails on Apple platforms.
		extensions: [
			{ name: 'basicConstraints', cA: false, critical: true },
			{ name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
			{ name: 'extKeyUsage', serverAuth: true },
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
 * Load the persisted certificate from `dir`, generating a fresh one when
 * missing, unparsable, weakly signed, or within MIN_REMAINING_DAYS of expiry.
 * Persisting the fresh pair is best-effort: a read-only or wrongly-owned
 * data dir must degrade to "new warning every boot", never to a dead HTTPS
 * port (cairn-qv6h was exactly that failure mode).
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
	try {
		mkdirSync(dir, { recursive: true });
		// The key never leaves the server; 0o600 is best-effort (no-op on Windows).
		writeFileSync(keyPath, fresh.key, { mode: 0o600 });
		writeFileSync(certPath, fresh.cert, { mode: 0o644 });
	} catch (err) {
		console.error(
			`cairn: could not persist TLS certificate to ${dir} (serving it from memory; ` +
				`expect a fresh browser warning on every restart) —`,
			err?.message ?? err
		);
	}
	return fresh;
}
