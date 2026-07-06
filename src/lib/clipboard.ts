/**
 * Copy text to the clipboard, working in both secure and insecure contexts.
 *
 * navigator.clipboard only exists in secure contexts (HTTPS or localhost).
 * Umbrel and similar self-hosted deployments serve over plain HTTP on the
 * LAN, so we fall back to the legacy execCommand('copy') path there.
 *
 * Returns true if the copy succeeded.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
	if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Permission denied or transient failure — try the legacy path.
		}
	}
	return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
	const textarea = document.createElement('textarea');
	textarea.value = text;
	textarea.setAttribute('readonly', '');
	// Off-screen but not display:none — hidden elements can't be selected.
	textarea.style.position = 'fixed';
	textarea.style.top = '0';
	textarea.style.left = '-9999px';
	document.body.appendChild(textarea);

	const selection = document.getSelection();
	const prevRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

	textarea.select();
	textarea.setSelectionRange(0, text.length);

	let ok = false;
	try {
		ok = document.execCommand('copy');
	} catch {
		ok = false;
	}

	textarea.remove();

	// Restore whatever the user had selected before we hijacked the selection.
	if (prevRange && selection) {
		selection.removeAllRanges();
		selection.addRange(prevRange);
	}

	return ok;
}
