// ONE email shell, ONE palette, ONE way to write a link or a button.
//
// ── Why this file exists ─────────────────────────────────────────────────────
//
// A host opened a real Snapdini email in Outlook and said: "it's awful dark, the link is in dark
// blue and very hard to read." Both halves of that sentence were the same bug.
//
// Snapdini had THREE email shells — one in email.ts (htmlEmail/authHtml), one in
// lifecycle-emails.ts, one in guest-emails.ts — and the oldest of the three was built the way
// ordinary web HTML is built: a <div> with `max-width`, a class on the call-to-action, a <style>
// element at the END OF <body>, and anchors with no colour of their own. Every one of those is a
// thing an email client is allowed to ignore, and the two that matter most ignore all of them:
//
//   · Outlook desktop (the Word rendering engine) does not honour `background` on <body> or on a
//     <div>, and does not reliably inherit `color` from <body>. So a dark email drawn that way
//     renders on WHITE with `#efe9dc` text on it — invisible. That is the worst failure available
//     here and it is almost certainly most of what the owner saw.
//   · Outlook.com strips <style> outright. The primary call-to-action was styled by `.btn` in a
//     <style> block, so the most important link in the message was the one that lost its styling
//     and fell back to the client default: a dark blue, on a dark ground, unreadable. That is the
//     "link is in dark blue" half, exactly.
//
// So the rules this file enforces are not stylistic preferences, they are the established practice
// that survives those clients:
//
//   1. Inline every style that MATTERS. A <style> block exists only for progressive enhancement
//      (a narrow-screen tweak), lives in <head> where clients that keep it expect it, and nothing
//      is unreadable if it is thrown away.
//   2. Layout is TABLES. A full-bleed outer table carrying the page ground, and a nested 600px
//      table for the column, because `max-width` on a <div> is not honoured by Outlook desktop.
//   3. Ground colours are set as the bgcolor ATTRIBUTE *and* as inline CSS, on every table and
//      every cell that has one. The attribute is the half Outlook reads.
//   4. Every cell that holds text sets its own `color`. Nothing inherits.
//   5. Every <a> carries an inline `color:`. There is no such thing here as a link that takes the
//      client's default — see `link()` and `button()`, and the chokepoint in email.ts that catches
//      an anchor written by hand anyway.
//   6. Sizes are px. Outlook's Word engine does not support `rem`.
//   7. `color-scheme` / `supported-color-schemes` are declared, as a meta AND in CSS, so a
//      dark-mode client stops second-guessing an already-dark email and inverting it into
//      light-on-light.
//
// ── Dark or light: THE SWITCH ────────────────────────────────────────────────
//
// `SCHEME` below is the whole decision, in one line. Dark is the brand choice (it matches the app)
// and it is the harder one to get right, which is why everything above exists. Flipping the
// constant to 'light' re-colours every email this product sends — the shell, the cards, the links,
// the buttons, the meta declarations — with no other edit anywhere.
//
// Whichever way it is set, `#f5c518` stays a BACKGROUND with near-black ink on it. Pale text on
// the brand gold measures about 1.6:1 and is effectively unreadable; the logo chip has always had
// this right and it is the one part of the old shell that was kept unchanged.
export type EmailScheme = 'dark' | 'light';

/** ── THE SWITCH ── Flip to 'light' to send light-bodied mail instead. Nothing else changes. */
export const SCHEME: EmailScheme = 'dark';

export interface Palette {
  /** The page ground, behind the column. */
  page: string;
  /** The card the copy sits on. */
  card: string;
  border: string;
  line: string;
  /** Brand gold. A SURFACE colour: things sit on it, never text of it on a pale ground. */
  gold: string;
  /** The only ink allowed on `gold`. */
  goldInk: string;
  /** Body copy. */
  ink: string;
  /** Headings and emphasis. */
  head: string;
  /** Secondary copy inside a card. */
  muted: string;
  /** Footer and fine print. */
  subtle: string;
  /** A link in body copy. */
  link: string;
  /** A link in the footer / fine print — quieter, still comfortably legible. */
  linkQuiet: string;
  /** Border for a ghost (outlined) button. */
  ghostBorder: string;
}

const DARK: Palette = {
  page: '#0f0e0b', card: '#14110b', border: '#2b2519', line: '#221d13',
  gold: '#f5c518', goldInk: '#111111',
  ink: '#efe9dc', head: '#fdfaf2', muted: '#b0a894', subtle: '#9d947f',
  // Gold on the dark ground measures ~12:1. On a dark email the accent is the BEST link colour
  // available, which is the happy part of this: the fix is also the on-brand one.
  link: '#f5c518', linkQuiet: '#c9bda1', ghostBorder: '#6b5c2e',
};

// The light reversal, kept complete and in step so the switch above is a one-line change rather
// than a rewrite. Note `link`: `#b08b08` is the gold that is legible as TEXT on a pale ground
// (~4.7:1). `#f5c518` on white is ~1.6:1 and must never be used this way.
const LIGHT: Palette = {
  page: '#f4f1e9', card: '#ffffff', border: '#e3ddcd', line: '#ece6d6',
  gold: '#f5c518', goldInk: '#111111',
  ink: '#2c2719', head: '#14110a', muted: '#5f5847', subtle: '#6e6655',
  link: '#b08b08', linkQuiet: '#6e6655', ghostBorder: '#cdbf8a',
};

/** The resolved palette. Every colour in every Snapdini email comes from here. */
export const C: Palette = SCHEME === 'dark' ? DARK : LIGHT;

/** One font stack, unquoted on purpose: these strings live inside a double-quoted style attribute,
 *  and a nested quote is the kind of thing a mail client's sanitiser trips over. */
export const FONT = '-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif';

export const SUPPORT_EMAIL = 'support@snapdini.com';

/** HTML-escape. Kept here so every email module escapes identically — the copy modules each had
 *  their own copy of this four-line function. */
export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

// ── Links and buttons ────────────────────────────────────────────────────────

/** A link, with its colour on it.
 *
 *  Use this rather than writing an <a> by hand. An anchor with no inline `color:` inherits the
 *  client's default, which in Outlook is a dark blue that is unreadable on a dark ground — this is
 *  the reported bug, and a helper is the only way a future anchor cannot reintroduce it.
 *
 *  `tone: 'quiet'` is for the footer and the fine print. It is quieter, not illegible. */
export function link(href: string, text: string, tone: 'body' | 'quiet' = 'body'): string {
  const colour = tone === 'quiet' ? C.linkQuiet : C.link;
  return `<a href="${esc(href)}" style="color:${colour};text-decoration:underline">${text}</a>`;
}

/** The inline style of a call-to-action, as one string.
 *
 *  Exported because the chokepoint in email.ts needs it to rescue an anchor that was written with
 *  `class="btn"` — the class whose rule used to live in a <style> block that Outlook.com deletes. */
export const buttonStyle = (ghost = false): string =>
  `display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;line-height:20px;`
  + `font-weight:bold;text-decoration:none;border-radius:9px;`
  + (ghost
      ? `color:${C.link};border:1px solid ${C.ghostBorder}`
      : `color:${C.goldInk};background-color:${C.gold};border:1px solid ${C.gold}`);

/** A call-to-action, built as a table so Outlook desktop draws the box.
 *
 *  The cell carries the fill as the bgcolor ATTRIBUTE as well as inline CSS, and the anchor repeats
 *  the colour and the fill — so the button survives a client that keeps only one of the two, and
 *  degrades to a coloured, underlined, clearly-a-link anchor rather than to nothing. */
export function button(label: string, href: string, ghost = false): string {
  const cell = ghost
    ? `style="border-radius:9px;border:1px solid ${C.ghostBorder}"`
    : `bgcolor="${C.gold}" style="border-radius:9px;background-color:${C.gold}"`;
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:18px 0"><tr>`
    + `<td align="center" ${cell}>`
    + `<a href="${esc(href)}" style="${buttonStyle(ghost)}">${label}</a>`
    + `</td></tr></table>`;
}

// ── Copy elements ────────────────────────────────────────────────────────────
// Each sets its own colour and its own px size. Nothing here inherits anything.

export const heading = (text: string, tag: 'h1' | 'h2' = 'h1'): string =>
  `<${tag} style="margin:0 0 6px;color:${C.head};font-family:${FONT};font-size:23px;`
  + `line-height:28px;font-weight:bold;letter-spacing:-0.3px">${text}</${tag}>`;

export const para = (text: string, emphasis = false): string =>
  `<p style="margin:14px 0;font-family:${FONT};font-size:15px;line-height:24px;`
  + `color:${emphasis ? C.head : C.ink}">${text}</p>`;

export const fine = (text: string): string =>
  `<p style="margin:14px 0;font-family:${FONT};font-size:13px;line-height:20px;color:${C.subtle}">${text}</p>`;

// ── The shell ────────────────────────────────────────────────────────────────

/** The brand chip. Gold surface, near-black ink — the one part of the old shell that was already
 *  right, kept as it was. */
const chip = (): string =>
  `<span style="display:inline-block;background-color:${C.gold};color:${C.goldInk};`
  + `padding:8px 14px;border-radius:9px;font-family:${FONT};font-size:16px;line-height:20px;`
  + `font-weight:bold;letter-spacing:-0.2px">&#127913; Snapdini</span>`;

export interface ShellParts {
  /** The line a client shows beside the subject in the inbox list. Already written by every copy
   *  module; before this shell existed it was declared and then discarded. */
  preheader?: string;
  /** The card contents — already HTML, already escaped by its builder. */
  inner: string;
  /** The footer cell contents. Sender identification (Spam Act 2003 s17) lives here. */
  footer: string;
}

/** The standard footer: who we are and how to reach us, plus whatever the message adds. */
export const footerLine = (extra = ''): string =>
  `Snapdini &middot; ${link(`mailto:${SUPPORT_EMAIL}`, SUPPORT_EMAIL, 'quiet')}${extra}`;

/**
 * THE shell. Every Snapdini email is this, with a different `inner`.
 *
 * Read the numbered rules at the top of this file before changing anything below: each attribute
 * here is carrying one of them, and the ones that look redundant (bgcolor beside background-color,
 * a colour on every cell) are the ones Outlook is relying on.
 */
export function emailShell({ preheader, inner, footer }: ShellParts): string {
  // A hidden preheader, then zero-width spaces: without the padding a client fills the rest of the
  // preview line with whatever body copy comes next, which is usually "Hi there,".
  const pre = preheader
    ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;`
      + `overflow:hidden;mso-hide:all;color:${C.page}">${esc(preheader)}`
      + '&#8203;'.repeat(60) + '</div>'
    : '';
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="${SCHEME}">
<meta name="supported-color-schemes" content="${SCHEME}">
<title>Snapdini</title>
<style>
  /* PROGRESSIVE ENHANCEMENT ONLY. Outlook.com deletes this element and the Word engine is
     unreliable with it, so nothing load-bearing may ever live here: every colour, size and
     background that matters is inline on the element itself. Verified mechanically — see
     app/src/server/__tests__/email-shell.test.ts, which strips this block and every class
     attribute and then asserts the message is still legible and the CTA still reads as a button. */
  :root { color-scheme: ${SCHEME}; supported-color-schemes: ${SCHEME}; }
  a { color: ${C.link}; }
  @media only screen and (max-width: 620px) {
    .sd-gutter { padding: 24px 14px !important; }
    .sd-card { padding: 24px 20px !important; }
  }
</style>
</head>
<body bgcolor="${C.page}" style="margin:0;padding:0;width:100%;background-color:${C.page};color:${C.ink};font-family:${FONT}">
${pre}
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="${C.page}" style="width:100%;background-color:${C.page}">
  <tr>
    <td align="center" bgcolor="${C.page}" class="sd-gutter" style="background-color:${C.page};padding:32px 16px">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" bgcolor="${C.page}" style="width:600px;max-width:600px;background-color:${C.page}">
        <tr>
          <td align="left" bgcolor="${C.page}" style="background-color:${C.page};padding:0 4px 22px;color:${C.ink};font-family:${FONT}">${chip()}</td>
        </tr>
        <tr>
          <td align="left" bgcolor="${C.card}" class="sd-card" style="background-color:${C.card};border:1px solid ${C.border};border-radius:16px;padding:32px 30px;color:${C.ink};font-family:${FONT};font-size:15px;line-height:24px">
            ${inner}
          </td>
        </tr>
        <tr>
          <td align="left" bgcolor="${C.page}" style="background-color:${C.page};padding:20px 6px 0;color:${C.subtle};font-family:${FONT};font-size:12px;line-height:19px">
            ${footer}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body></html>`;
}

// ── The plain-text part ──────────────────────────────────────────────────────
//
// Every email this product sends used to be HTML-only: `sendMail` had no `text` field and no
// caller passed one. That is three separate problems at once — it is the genuine fallback for the
// Outlook rendering this file exists to fix, it is what a text-mode or screen-reader-driven client
// prefers outright, and HTML-only mail is a deliverability penalty this domain does not need on top
// of a DMARC quarantine.
//
// Two rules, and both are the kind that fail silently:
//
//   · The text part is generated from the same DATA as the HTML, never by stripping tags off the
//     rendered markup. Tag-stripping produces bare URLs mid-sentence, stranded button labels and
//     raw entities — the classic unreadable soup.
//   · The text part takes RAW strings, never escaped ones. `&amp;` in a text part reaches the
//     inbox literally, which is the same bug as an escaped subject line: an event called
//     "Priya & Tom" arriving as "Priya &amp; Tom".

/** A labelled URL, on its own line. A text part whose call to action is the word "here" is
 *  useless, so every link says what it does and then gives the whole address. */
export const textLink = (label: string, url: string): string => `${label}:\n${url}`;

/** Assemble a text part: blocks separated by a blank line, with the sender identification the HTML
 *  footer carries. Falsy blocks drop out, so a conditional paragraph reads the same as in HTML. */
export function textEmail(
  blocks: Array<string | false | null | undefined>,
  footerExtra: Array<string | false | null | undefined> = [],
): string {
  const body = blocks.filter((b): b is string => typeof b === 'string' && !!b.trim()).map((b) => b.trim());
  const foot = ['—', `Snapdini · ${SUPPORT_EMAIL}`,
    ...footerExtra.filter((b): b is string => typeof b === 'string' && !!b.trim()).map((b) => b.trim())];
  return `${body.join('\n\n')}\n\n${foot.join('\n')}\n`;
}
