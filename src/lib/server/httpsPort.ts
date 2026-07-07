import { env } from '$env/dynamic/private';

/**
 * The host-visible port of Cairn's self-signed HTTPS listener (cairn-wgr8),
 * or null when it isn't running. CAIRN_HTTPS_EXTERNAL_PORT wins when a Docker
 * port mapping makes the outside port differ from the listen port (Umbrel
 * publishes 3212 → container 3443).
 *
 * Shared by the (app) and (auth) layout loads — every page needs it so the
 * client can offer (or auto-open, cairn-6uff) the secure address when the
 * page arrived over plain HTTP.
 */
export function httpsExternalPort(): number | null {
	const raw = env.CAIRN_HTTPS_EXTERNAL_PORT || env.CAIRN_HTTPS_PORT;
	const port = raw ? Number(raw) : NaN;
	return Number.isInteger(port) && port > 0 ? port : null;
}
