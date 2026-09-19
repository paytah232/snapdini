import nodemailer from 'nodemailer';
import { blocksFor } from './unsubscribe';
import { normaliseAddress } from './delivery';
import {
  C, button, buttonStyle, emailShell, footerLine, heading, link, para, fine,
  textEmail, textLink, SUPPORT_EMAIL,
} from './email-theme';

// The shell, the palette and the link/button helpers all live in email-theme.ts — read the header
// of that file for why an email is built the way it is. Re-exported here because `email.ts` is the
// module every sender already imports, and a caller should not have to know there are two.
export { C, button, link, para, fine, heading, emailShell, footerLine, textEmail, textLink } from './email-theme';

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

/**
 * Accept an SMTP certificate that does not verify.
 *
 * nodemailer 9 turned certificate validation ON by default, which is the right default and which
 * breaks a shape of deployment this project genuinely has: a relay on the same Docker network or
 * LAN, presenting a self-signed certificate or one issued for a different name. Before 1.5.0 those
 * sends worked; after it they fail with a certificate error.
 *
 * So the escape hatch is explicit and opt-in rather than a silent `rejectUnauthorized: false`. It
 * has to be TYPED to turn off — any other value, including empty, leaves validation on — because
 * the failure mode of getting this wrong is a connection that looks encrypted and authenticates
 * nobody. Fixing the certificate is the better answer and the docs say so; this is for the
 * operator who has weighed it up on a network they control.
 */
const smtpRejectUnauthorized = process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false';

const transporter = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      tls: { rejectUnauthorized: smtpRejectUnauthorized },
    })
  : null;

if (smtpConfigured && !smtpRejectUnauthorized) {
  // Said once, at boot, so it appears in the logs of the deployment it applies to rather than
  // living only in a config file nobody reads twice.
  console.warn('[email] SMTP_TLS_REJECT_UNAUTHORIZED=false — the SMTP certificate is NOT verified.');
}

const FROM = process.env.SMTP_FROM
  || process.env.SMTP_USER
  || (mailgunConfigured ? `Snapdini <postmaster@${process.env.MAILGUN_DOMAIN}>` : 'Snapdini <noreply@snapdini.com>');

export interface Mail {
  to: string; subject: string; html: string; replyTo?: string;
  /** The plain-text alternative part.
   *
   *  Optional so an internal sender that has not been given one still sends rather than throwing,
   *  but every CUSTOMER-FACING builder now supplies it, and the sweep test
   *  (__tests__/email-shell.test.ts) fails if one stops.
   *
   *  Three reasons it is not decoration. It is the genuine fallback for a client that cannot render
   *  our HTML — which is the whole class of bug this shell was rewritten to fix. It is what a
   *  text-mode or screen-reader-driven client prefers outright. And HTML-only mail is a
   *  deliverability penalty, which a domain that has already seen a DMARC quarantine can do
   *  without.
   *
   *  It is generated from the same DATA as the HTML by each builder, never by stripping tags off
   *  the rendered markup — that produces bare URLs mid-sentence and stranded button labels — and it
   *  carries RAW strings, never escaped ones: `&amp;` in a text part reaches the inbox literally. */
  text?: string;
  /** Metadata to attach to the message. Mailgun carries these through to its webhooks as
   *  `user-variables`, which is the ONLY thing that lets a delivery event arriving hours later be
   *  tied back to the row that sent it. Ignored by the SMTP transport, which has no such channel —
   *  and that absence is exactly why SMTP sends never gain a delivery state. */
  variables?: Record<string, string>;
  /** A Mailgun tag, so one kind of mail can be told from another in Mailgun's own dashboard. */
  tag?: string;
  /** Extra RFC 5322 headers on the message itself. This exists for List-Unsubscribe and
   *  List-Unsubscribe-Post (RFC 8058), which are headers rather than body content precisely so the
   *  mail CLIENT can offer the unsubscribe in its own chrome — right next to the report-spam button
   *  the recipient would otherwise reach for. Carried by both transports: Mailgun takes arbitrary
   *  headers as `h:`-prefixed form fields, nodemailer takes a headers object. */
  headers?: Record<string, string>;
  /** The event this message belongs to, when it belongs to one. Supplying it widens the suppression
   *  check from the global list to "and this event's own opt-outs" — someone who said stop about
   *  Jo's wedding has not said stop about Sam's birthday. */
  eventId?: string;
  /** Send even to a suppressed address.
   *
   *  For the handful of messages where NOT sending is the greater harm: a sign-in or verification
   *  link the person asked for seconds ago (suppressing it locks them out of their own account),
   *  and anything addressed to our own support inbox. Everything else is suppressible by default,
   *  which is the point — the next email someone adds is compliant without having to remember. */
  always?: boolean;
}

/** What a send tells us about itself.
 *
 *  `messageId` is the provider's id for the message, already stripped of the angle brackets that
 *  the Mailgun send API wraps it in — Mailgun's webhooks report the same id WITHOUT them, so
 *  normalising here is what lets the two be compared at all. Compared as sent, they never match.
 *
 *  `provider` is recorded against every invite, because it is what decides whether 'sent' means
 *  "we are waiting to hear" or "we will never hear". */
export interface SendResult {
  provider: 'mailgun' | 'smtp';
  messageId: string | null;
  /** Nothing was sent: the address is on the suppression list, or opted out of this event.
   *
   *  Returned rather than thrown on purpose. Callers stamp one-shot guards and write ledger rows
   *  around these calls; an exception would leave a claim un-made and the sweep would try the same
   *  suppressed address again on every tick, forever. A quiet, inspectable "no" lets a caller
   *  record the truth instead. */
  suppressed?: true;
}

const unbracket = (id: string | null | undefined): string | null =>
  (id ? id.replace(/^</, '').replace(/>$/, '') || null : null);

async function sendViaMailgun({ to, subject, html, text, replyTo, variables, tag, headers }: Mail): Promise<SendResult> {
  const base = process.env.MAILGUN_BASE || 'https://api.mailgun.net'; // EU: https://api.eu.mailgun.net
  const domain = process.env.MAILGUN_DOMAIN as string;
  const form = new URLSearchParams({ from: FROM, to, subject, html });
  // Mailgun builds the multipart/alternative for us: `html` plus `text` on the same request is one
  // message with two parts, in the right order. Set BEFORE the h:/v:/o: fields for no reason other
  // than reading order — it is part of the message, not an option on it.
  if (text) form.set('text', text);
  if (replyTo) form.set('h:Reply-To', replyTo);
  // `h:` = a header to set on the outgoing message. Worth knowing where this sits relative to
  // o:tracking below: with tracking off, Mailgun injects no unsubscribe of its own, so whatever is
  // passed here is the ONLY unsubscribe the message will carry. There is no provider fallback
  // behind it, and a send that drops these headers has no one-click unsubscribe at all.
  for (const [k, v] of Object.entries(headers || {})) form.set(`h:${k}`, v);
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
  if (!res.ok) {
    // Mailgun's body is the provider's own diagnostic — it names our domain, the API route and the
    // recipient — and this string has travelled all the way out to callers that put an error
    // message in a JSON response. The operator needs it; a stranger must not have it. Log one,
    // throw the other. The status stays on the thrown message because it is the part a caller can
    // reason about (4xx is ours to fix, 5xx is theirs) and it reveals nothing.
    console.error(`[email] Mailgun send failed (${res.status}): ${await res.text().catch(() => '')}`);
    throw new Error(`Mailgun send failed (${res.status})`);
  }
  // { id: "<2026...@mg.example.com>", message: "Queued. Thank you." }. A response body we cannot
  // parse is NOT a failed send — the message is already queued — so this degrades to a null id
  // rather than throwing and making the caller record a failure that did not happen.
  const body = await res.json().catch(() => null) as { id?: string } | null;
  return { provider: 'mailgun', messageId: unbracket(body?.id) };
}

export async function sendMail({ to, subject, html, text, replyTo, variables, tag, headers, eventId, always }: Mail): Promise<SendResult> {
  // ONE place, so every sender is covered — including the ones nobody has written yet.
  //
  // This check used to live in exactly one route (the guest invite), which meant a guest who chose
  // "never email me from Snapdini again" carried on receiving the gallery link, the thank-you, the
  // release reminder and every lifecycle message. The unsubscribe worked; it just did not reach
  // anything. Nine call sites each remembering to ask is nine chances to forget, so the transport
  // asks instead.
  if (!always) {
    const blocked = await blocksFor(eventId ?? '', [to]);
    if (blocked.get(normaliseAddress(to))) {
      return { provider: mailgunConfigured ? 'mailgun' : 'smtp', messageId: null, suppressed: true };
    }
  }
  if (mailgunConfigured) return sendViaMailgun({ to, subject, html, text, replyTo, variables, tag, headers });
  if (transporter) {
    // `text` goes to BOTH transports or it goes to neither. A field added to the Mail type and
    // quietly dropped by one of the two is this project's recurring silent-failure shape: the
    // plain-text part would exist on Mailgun deployments and vanish on SMTP ones, with nothing
    // anywhere saying so. nodemailer builds multipart/alternative from html + text.
    const info = await transporter.sendMail({ from: FROM, to, subject, html, text, replyTo, headers });
    return { provider: 'smtp', messageId: unbracket(info?.messageId) };
  }
  // This throws on a request path, and a caller's catch is what decides whether the text reaches a
  // stranger — so the fix-it instructions, which name our environment variables, go to the log and
  // a bare statement of fact goes to the caller. The operator is the one who can act on it anyway.
  console.error('[email] no transport configured — set MAILGUN_API_KEY+MAILGUN_DOMAIN, or SMTP_HOST/SMTP_USER/SMTP_PASS');
  throw new Error('Email is not configured on this server');
}

// ── Auth emails ────────────────────────────────────────────────────────────────
// When SMTP is unconfigured (dev), we log the link to the console so the flow stays
// testable without a mail server. Returns { delivered, devLink? }.
export async function sendAuthLink(
  { to, kind, link }: { to: string; kind: 'verify' | 'magic'; link: string }
): Promise<{ delivered: boolean; devLink?: string }> {
  const devFallback = process.env.NODE_ENV !== 'production' ? link : undefined;

  // No transport at all (local dev with neither Mailgun nor SMTP): log the link.
  if (!enabled) {
    console.log(`\n[auth:${kind}] email to ${to} (email disabled) → ${link}\n`);
    return { delivered: false, devLink: link };
  }

  try {
    // Never suppressed: this is a link the person asked for seconds ago, and withholding it locks
    // them out of their own account. It is also purely transactional — nothing is being sold.
    const m = authEmail(kind, link);
    await sendMail({ to, subject: m.subject, html: m.html, text: m.text, always: true });
    return { delivered: true, devLink: devFallback };
  } catch (err) {
    // Common in dev: the Mailgun sandbox only delivers to *authorised* recipients,
    // so an unverified address 4xx's. Don't block the flow — surface the link in dev.
    console.error(`[auth:${kind}] send to ${to} failed: ${(err as Error).message}`);
    return { delivered: false, devLink: devFallback };
  }
}

/** The sign-in / verify email, as a real builder rather than markup buried in the send path.
 *
 *  Exported for two reasons: `app/scripts/email-sampler.ts` used to reproduce this markup verbatim
 *  (and drifted from it the moment either copy was touched), and a builder can be asserted against
 *  by the sweep test. Nothing about it is secret — the LINK is the credential, and that is the
 *  caller's to hold. */
export function authEmail(kind: 'verify' | 'magic', url: string): { subject: string; preheader: string; html: string; text: string } {
  const copy = kind === 'verify'
    ? { subject: 'Verify your Snapdini email', heading: 'Confirm your email',
        preheader: 'One tap to confirm your email and finish setting up your account.',
        body: 'Tap below to verify your email and finish setting up your account.', cta: 'Verify email' }
    : { subject: 'Your Snapdini sign-in link', heading: 'Sign in to Snapdini',
        preheader: 'Your sign-in link — good for 30 minutes, and for one use.',
        body: 'Tap below to sign in. This link expires in 30 minutes and can be used once.', cta: 'Sign in' };

  const inner = [
    heading(copy.heading, 'h2'),
    para(copy.body),
    button(`${copy.cta} &rarr;`, url),
    fine('If you didn&rsquo;t request this, you can ignore this email.'),
  ].join('');

  // Sender identification (Spam Act 2003 s17): the name AND a contact address that is reasonably
  // likely to be valid for 30 days. This layout carried the logo and nothing to reach us by.
  // Contact details are expressly permitted alongside factual information (Sch 1 cl 3(2)), so
  // adding this cannot cost any message its designated status.
  return {
    subject: copy.subject,
    preheader: copy.preheader,
    html: emailShell({ preheader: copy.preheader, inner, footer: footerLine() }),
    text: textEmail([
      copy.heading,
      copy.body,
      textLink(copy.cta, url),
      'If you didn’t request this, you can ignore this email.',
    ]),
  };
}

/**
 * Shared Snapdini email layout for transactional mails (gallery links, invites, "your photos").
 *
 * ── The chokepoint ──
 *
 * `body` is markup written by a caller, and callers get two things wrong in the same two ways every
 * time: an <a> with no inline `color:`, and a call-to-action marked `class="btn"`. Both were fine
 * when there was a <style> block at the end of <body> to back them up. There is no longer one, and
 * there should never have been: Outlook.com and the Gmail mobile app both DELETE <style>, which is
 * how the owner came to see the primary call-to-action of a Snapdini email as a bare default-blue
 * link on a near-black ground in one client and an unstyled link in the other. Two clients, one
 * cause.
 *
 * So the shell repairs its own input, here, once — the same reasoning as sendMail's suppression
 * check. Colouring 18 anchors by hand fixes today's 18; a chokepoint fixes the nineteenth, which
 * somebody will write next month in a file nobody thought to look at. It is also the only way to
 * fix `routes/guests.ts`'s invite while that file is owned by someone else.
 *
 * `title` is interpolated RAW into the <h2>, exactly as before — every caller escapes it and there
 * are tests (release-hardening.test.ts) that pin both the raw interpolation and the escaping of
 * every host-written value that reaches it. Do not "fix" it here; that would double-escape the lot.
 */
export function htmlEmail(title: string, body: string, opts: { preheader?: string } = {}): string {
  return emailShell({
    preheader: opts.preheader,
    inner: `${heading(title, 'h2')}${hardenAnchors(body)}`,
    footer: footerLine(),
  });
}

// ── hardenAnchors: no link leaves this building uncoloured ───────────────────

const attrOf = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return m ? m[1] : null;
};

const isBtn = (tag: string): boolean => /\bclass\s*=\s*"[^"]*\bbtn\b[^"]*"/i.test(tag);

/** Does this <a …> carry its own `color:`? Anchored on `;` / whitespace / start-of-value so
 *  `background-color:` does not count as one — that near-miss is how a sweep passes while every
 *  link in the message is still the client's default. */
export const anchorHasColour = (tag: string): boolean => {
  const style = attrOf(tag, 'style');
  return !!style && /(^|[;\s])color\s*:/i.test(style);
};

/** Make a caller's markup survive a client with no CSS at all. Three passes, narrowest first. */
export function hardenAnchors(html: string): string {
  // 1. `<p …><a class="btn" href=…>Label</a></p>` — the shape all six CTAs are written in — becomes
  //    a real table-cell button. A table is what Outlook desktop needs to draw a filled box at all:
  //    `background` and `border-radius` on an <a> are ignored by the Word engine even inline.
  //    The <p> goes with it; the button table brings its own margin.
  let out = html.replace(/<p\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*<\/p>/gi, (whole, attrs: string, label: string) => {
    const tag = `<a${attrs}>`;
    if (!isBtn(tag)) return whole;
    const href = attrOf(tag, 'href');
    return href ? button(label.trim(), href) : whole;
  });

  // 2. A `class="btn"` anchor in any other shape still gets every property the deleted rule had,
  //    inline on the anchor itself. Not as good as a table cell, and never reached by current
  //    callers — it is here so that "it degraded to a plain blue link" can never be the outcome.
  out = out.replace(/<a\b([^>]*)>/gi, (tag: string, attrs: string) => {
    if (!isBtn(tag)) return tag;
    // EVERY OTHER ATTRIBUTE SURVIVES. This used to rebuild the tag out of the href alone, which
    // threw away `rel="noopener"`, `target="_blank"` and anything else a caller had put on a
    // button — and, because attrOf only reads double-quoted values, turned a single-quoted href
    // into `href="#"`: a button that goes nowhere. Only the style is replaced, because replacing
    // it is the entire job; the href is now left exactly as the caller wrote it, in whatever
    // quoting they wrote it in.
    const rest = attrs.replace(/\s*\bstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    return `<a${rest} style="${buttonStyle()}">`;
  });

  // 3. Everything else gets an explicit colour. An anchor that already states one is left alone —
  //    a caller who chose a quieter grey for the fine print meant it.
  out = out.replace(/<a\b([^>]*)>/gi, (tag: string, attrs: string) => {
    if (anchorHasColour(tag)) return tag;
    const style = attrOf(tag, 'style');
    if (style === null) return `<a${attrs} style="color:${C.link};text-decoration:underline">`;
    const sep = !style.trim() || style.trim().endsWith(';') ? '' : ';';
    // A REPLACER FUNCTION, not a replacement string. In a string, `$&`, `` $` ``, `$'` and `$1`
    // are substitution patterns — so a style attribute containing one of them would have the
    // matched text spliced into the value, and `$'` (everything AFTER the match) ends the
    // attribute and writes the rest of the document back inside the tag. No builder puts caller
    // data in a style attribute today and esc() turns a quote into `&quot;`, so this is not
    // reachable; it is one character of difference, and the next builder that interpolates into a
    // style should not have to know any of the above.
    return tag.replace(/style\s*=\s*"[^"]*"/i, () => `style="${style}${sep}color:${C.link}"`);
  });

  return out;
}

/** The plain-text counterpart of `htmlEmail`'s footer, for a caller assembling a text part. */
export const textFooterAddress = SUPPORT_EMAIL;
