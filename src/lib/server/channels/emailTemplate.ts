// Shared HTML + plain-text builder for notification emails (cairn-5gpv.2).
//
// Email is the one channel that should be the MOST full-featured: it's
// asynchronous, so the recipient isn't already in the app the way they are for an
// in-app alert. A raw-text subject+body reads like a system cron mail; a lightly
// branded HTML message with a "View in Heartwood" button reads like a product.
//
// One template function serves all event types (title + body + optional link),
// so every event gets the same treatment with zero per-event work. The plain-text
// part is always produced too — for accessibility, text-only clients, and as the
// body we reuse verbatim on the PGP-encrypted path (encrypting HTML buys nothing
// and complicates the armored payload).

/** The inputs a rendered email needs — a subset of NotificationPayload plus the
 *  already-absolute deep link (email links must be absolute; see notifyLinks). */
export interface EmailTemplateInput {
	title: string;
	body: string;
	/** Absolute URL back into the app, or null when CAIRN_ORIGIN is unset. */
	link: string | null;
	/** Drives the accent stripe + a small urgency cue for warn/error events. */
	level: 'info' | 'success' | 'warn' | 'error';
}

export interface RenderedEmail {
	/** HTML alternative part. */
	html: string;
	/** Plain-text alternative part (also reused as the PGP-encrypted body). */
	text: string;
}

/** Heartwood's dark theme, hard-coded here because email clients can't read the
 *  app's CSS custom properties (Gmail et al. strip <style> blocks with var()).
 *  Resolved hex values mirror src/app.css — kept in sync by eye, not by import. */
const COLORS = {
	bg: '#100d0b', // --bg (deep wood charcoal)
	surface: '#17120f', // --surface
	border: '#3a2f27', // --border
	text: '#ede4db', // --text
	textMuted: '#a99c90', // --text-secondary (body/footer copy; legible on --surface)
	accent: '#e8935a', // --accent (Heartwood copper)
	onAccent: '#1a1210', // --on-accent (text placed ON the copper accent)
	warn: '#d8b27a', // --attention (warm tan — Heartwood has no orange nudge)
	error: '#e0604c' // --error
};

/** Accent colour for the header stripe by level. */
function accentFor(level: EmailTemplateInput['level']): string {
	if (level === 'error') return COLORS.error;
	if (level === 'warn') return COLORS.warn;
	return COLORS.accent;
}

/** Minimal HTML-escape for interpolating title/body into markup. */
function esc(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** The plain-text alternative: title, body, and the raw link on its own line.
 *  Deliberately identical to the pre-cairn-5gpv.2 body so the PGP path (which
 *  reuses this) is unchanged. */
export function renderText(input: EmailTemplateInput): string {
	let text = input.title ? `${input.title}\n\n${input.body}` : input.body;
	if (input.link) text += `\n\n${input.link}`;
	return text;
}

/** The branded HTML alternative. Table-based layout with inline styles — the only
 *  thing that renders consistently across mail clients (Gmail strips <style>). */
export function renderHtml(input: EmailTemplateInput): string {
	const accent = accentFor(input.level);
	const bodyHtml = esc(input.body).replace(/\n/g, '<br />');
	const button = input.link
		? `<tr><td style="padding:8px 0 4px;">
				<a href="${esc(input.link)}"
				   style="display:inline-block;background:${accent};color:${COLORS.onAccent};text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px;">
					View in Heartwood
				</a>
			</td></tr>`
		: '';

	return `<!doctype html>
<html>
	<body style="margin:0;padding:0;background:${COLORS.bg};">
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bg};padding:24px 0;">
			<tr>
				<td align="center">
					<table role="presentation" width="480" cellpadding="0" cellspacing="0"
						style="max-width:480px;width:100%;background:${COLORS.surface};border:1px solid ${COLORS.border};border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
						<tr><td style="height:4px;background:${accent};"></td></tr>
						<tr>
							<td style="padding:20px 24px 4px;">
								<span style="color:${accent};font-weight:700;font-size:15px;letter-spacing:0.3px;">Heartwood</span>
							</td>
						</tr>
						<tr>
							<td style="padding:8px 24px 4px;">
								<h1 style="margin:0;color:${COLORS.text};font-size:18px;font-weight:600;line-height:1.35;">${esc(input.title)}</h1>
							</td>
						</tr>
						<tr>
							<td style="padding:8px 24px 16px;">
								<p style="margin:0;color:${COLORS.textMuted};font-size:14px;line-height:1.6;">${bodyHtml}</p>
							</td>
						</tr>
						<tr>
							<td style="padding:0 24px 20px;">
								<table role="presentation" cellpadding="0" cellspacing="0">${button}</table>
							</td>
						</tr>
						<tr>
							<td style="padding:14px 24px;border-top:1px solid ${COLORS.border};">
								<p style="margin:0;color:${COLORS.textMuted};font-size:11px;line-height:1.5;">
									You're receiving this because you enabled email notifications in Heartwood. Manage them in Settings › Notifications.
								</p>
							</td>
						</tr>
					</table>
				</td>
			</tr>
		</table>
	</body>
</html>`;
}

/** Render both alternative parts for a notification email. */
export function renderEmail(input: EmailTemplateInput): RenderedEmail {
	return { html: renderHtml(input), text: renderText(input) };
}
