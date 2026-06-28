import nodemailer from 'nodemailer';

// Two interchangeable transports: SMTP (any provider) or Mailgun's HTTP API. Mailgun is
// preferred when configured; otherwise SMTP; otherwise email is disabled (dev logs links).
const smtpConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const mailgunConfigured = !!(process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN);
export const enabled = smtpConfigured || mailgunConfigured;

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

interface Mail { to: string; subject: string; html: string; replyTo?: string }

async function sendViaMailgun({ to, subject, html, replyTo }: Mail) {
  const base = process.env.MAILGUN_BASE || 'https://api.mailgun.net'; // EU: https://api.eu.mailgun.net
  const domain = process.env.MAILGUN_DOMAIN as string;
  const form = new URLSearchParams({ from: FROM, to, subject, html });
  if (replyTo) form.set('h:Reply-To', replyTo);
  const auth = Buffer.from(`api:${process.env.MAILGUN_API_KEY}`).toString('base64');
  const res = await fetch(`${base}/v3/${domain}/messages`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!res.ok) throw new Error(`Mailgun send failed (${res.status}): ${await res.text().catch(() => '')}`);
}

export async function sendMail({ to, subject, html, replyTo }: Mail) {
  if (mailgunConfigured) return sendViaMailgun({ to, subject, html, replyTo });
  if (transporter) return transporter.sendMail({ from: FROM, to, subject, html, replyTo });
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
    <p style="margin-top:40px;color:#666;font-size:0.8rem">Sent by Snapdini — your event camera</p>
  </div>
  <style>.btn{display:inline-block;background:#f5c518;color:#111;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold}</style>
</body></html>`;
}
