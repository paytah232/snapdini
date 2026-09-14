import nodemailer from 'nodemailer';

// Two interchangeable transports: SMTP (any provider) or Mailgun's HTTP API. Mailgun is
// preferred when configured; otherwise SMTP; otherwise email is disabled (dev logs links).
const smtpConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const mailgunConfigured = !!(process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN);
export const enabled = smtpConfigured || mailgunConfigured;

/** Which transport is actually in use, or null when email is off.
 *
 *  Recorded against every invite that is sent, because it is what a 'sent' status MEANS. Mailgun
 *  can tell us later what became of a message; plain SMTP never can. Without this column the same
 *  word on the screen would stand for "waiting to hear" on one deployment and "we will never know"
 *  on another, and the host has no way to tell which they are looking at. */
export const provider: 'mailgun' | 'smtp' | null =
  mailgunConfigured ? 'mailgun' : smtpConfigured ? 'smtp' : null;

const transporter = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

const FROM = process.env.SMTP_FROM
  || process.env.SMTP_USER
  || (mailgunConfigured ? `Snapdini <postmaster@${process.env.MAILGUN_DOMAIN}>` : 'Snapdini <noreply@snapdini.com>');

interface Mail {
  to: string; subject: string; html: string; replyTo?: string;
  /** Metadata to attach to the message. Mailgun carries these through to its webhooks as
   *  `user-variables`, which is the ONLY thing that lets a delivery event arriving hours later be
   *  tied back to the row that sent it. Ignored by the SMTP transport, which has no such channel —
   *  and that absence is exactly why SMTP sends never gain a delivery state. */
  variables?: Record<string, string>;
  /** A Mailgun tag, so one kind of mail can be told from another in Mailgun's own dashboard. */
  tag?: string;
}

/** What a send tells us about itself.
 *
 *  `messageId` is the provider's id for the message, already stripped of the angle brackets that
 *  the Mailgun send API wraps it in — Mailgun's webhooks report the same id WITHOUT them, so
 *  normalising here is what lets the two be compared at all. Compared as sent, they never match.
 *
 *  `provider` is recorded against every invite, because it is what decides whether 'sent' means
 *  "we are waiting to hear" or "we will never hear". */
export interface SendResult { provider: 'mailgun' | 'smtp'; messageId: string | null }

const unbracket = (id: string | null | undefined): string | null =>
  (id ? id.replace(/^</, '').replace(/>$/, '') || null : null);

async function sendViaMailgun({ to, subject, html, replyTo, variables, tag }: Mail): Promise<SendResult> {
  const base = process.env.MAILGUN_BASE || 'https://api.mailgun.net'; // EU: https://api.eu.mailgun.net
  const domain = process.env.MAILGUN_DOMAIN as string;
  const form = new URLSearchParams({ from: FROM, to, subject, html });
  if (replyTo) form.set('h:Reply-To', replyTo);
  // `v:` = custom variable, `o:` = send option. Mailgun caps all o:/h:/v:/t: parameters at 16KB
  // combined, which the short token and tag used here are nowhere near.
  for (const [k, v] of Object.entries(variables || {})) form.set(`v:${k}`, v);
  if (tag) form.set('o:tag', tag);
  // Open/click tracking is explicitly OFF. Leaving it to the account default risks it being on,
  // which rewrites every link in the email through a Mailgun redirector and embeds a tracking
  // pixel — surveillance of the host's guests that this product does not do, and which would also
  // make the join link unreadable to anyone who looks at where it actually points.
  form.set('o:tracking', 'no');
  const auth = Buffer.from(`api:${process.env.MAILGUN_API_KEY}`).toString('base64');
  const res = await fetch(`${base}/v3/${domain}/messages`, {
    method: 'POST',
    // NOTE: Mailgun documents multipart/form-data for this endpoint; urlencoded is undocumented
    // but works for sends without attachments, and is what this deployment has been sending with
    // all along. Left alone deliberately — changing the transport of every outbound email in the
    // product is not a change to make as a side effect of adding a guest list.
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!res.ok) throw new Error(`Mailgun send failed (${res.status}): ${await res.text().catch(() => '')}`);
  // { id: "<2026...@mg.example.com>", message: "Queued. Thank you." }. A response body we cannot
  // parse is NOT a failed send — the message is already queued — so this degrades to a null id
  // rather than throwing and making the caller record a failure that did not happen.
  const body = await res.json().catch(() => null) as { id?: string } | null;
  return { provider: 'mailgun', messageId: unbracket(body?.id) };
}

export async function sendMail({ to, subject, html, replyTo, variables, tag }: Mail): Promise<SendResult> {
  if (mailgunConfigured) return sendViaMailgun({ to, subject, html, replyTo, variables, tag });
  if (transporter) {
    const info = await transporter.sendMail({ from: FROM, to, subject, html, replyTo });
    return { provider: 'smtp', messageId: unbracket(info?.messageId) };
  }
  throw new Error('Email not configured — set MAILGUN_API_KEY+MAILGUN_DOMAIN, or SMTP_HOST/USER/PASS');
}

// ── Auth emails ────────────────────────────────────────────────────────────────
// When SMTP is unconfigured (dev), we log the link to the console so the flow stays
// testable without a mail server. Returns { delivered, devLink? }.
export async function sendAuthLink(
  { to, kind, link }: { to: string; kind: 'verify' | 'magic'; link: string }
): Promise<{ delivered: boolean; devLink?: string }> {
  const copy = kind === 'verify'
    ? { subject: 'Verify your Snapdini email', heading: 'Confirm your email',
        body: 'Tap below to verify your email and finish setting up your account.', cta: 'Verify email' }
    : { subject: 'Your Snapdini sign-in link', heading: 'Sign in to Snapdini',
        body: 'Tap below to sign in. This link expires in 30 minutes and can be used once.', cta: 'Sign in' };

  const devFallback = process.env.NODE_ENV !== 'production' ? link : undefined;

  // No transport at all (local dev with neither Mailgun nor SMTP): log the link.
  if (!enabled) {
    console.log(`\n[auth:${kind}] email to ${to} (email disabled) → ${link}\n`);
    return { delivered: false, devLink: link };
  }

  try {
    await sendMail({ to, subject: copy.subject, html: authHtml(copy, link) });
    return { delivered: true, devLink: devFallback };
  } catch (err) {
    // Common in dev: the Mailgun sandbox only delivers to *authorised* recipients,
    // so an unverified address 4xx's. Don't block the flow — surface the link in dev.
    console.error(`[auth:${kind}] send to ${to} failed: ${(err as Error).message}`);
    return { delivered: false, devLink: devFallback };
  }
}

function authHtml({ heading, body, cta }: { heading: string; body: string; cta: string }, link: string): string {
  return `<!DOCTYPE html><html><body style="margin:0;background:#0f0f0f;color:#f0ece6;font-family:sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:40px 24px">
    <div style="margin-bottom:24px">
      <span style="background:#f5c518;color:#111;padding:6px 12px;border-radius:6px;font-weight:bold;font-size:1.1rem">🎩 Snapdini</span>
    </div>
    <h2 style="margin-bottom:16px">${heading}</h2>
    <p>${body}</p>
    <p style="margin:24px 0"><a href="${link}" style="display:inline-block;background:#f5c518;color:#111;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold">${cta} →</a></p>
    <p style="color:#666;font-size:0.8rem">If you didn't request this, you can ignore this email.</p>
    <!-- Sender identification (Spam Act 2003 s17): the name AND a contact address that is
         reasonably likely to be valid for 30 days. Both of these layouts carried the logo and
         nothing to reach us by. Contact details are expressly permitted alongside factual
         information (Sch 1 cl 3(2)), so adding this cannot cost any message its designated status. -->
    <p style="color:#666;font-size:0.8rem">Snapdini · <a href="mailto:support@snapdini.com" style="color:#888">support@snapdini.com</a></p>
  </div>
</body></html>`;
}

// Shared Snapdini email layout for transactional mails (gallery links, "your photos").
export function htmlEmail(title: string, body: string): string {
  return `<!DOCTYPE html><html><body style="margin:0;background:#0f0f0f;color:#f0ece6;font-family:sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:40px 24px">
    <div style="margin-bottom:24px">
      <span style="background:#f5c518;color:#111;padding:6px 12px;border-radius:6px;font-weight:bold;font-size:1.1rem">🎩 Snapdini</span>
    </div>
    <h2 style="margin-bottom:16px">${title}</h2>
    ${body}
    <p style="margin-top:40px;color:#666;font-size:0.8rem">Snapdini · <a href="mailto:support@snapdini.com" style="color:#888">support@snapdini.com</a></p>
  </div>
  <style>.btn{display:inline-block;background:#f5c518;color:#111;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold}</style>
</body></html>`;
}
