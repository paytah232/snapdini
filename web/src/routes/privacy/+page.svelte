<script lang="ts">
  import Logo from '$lib/components/Logo.svelte';
  import SiteFooter from '$lib/components/SiteFooter.svelte';
  const updated = 'June 2026';
</script>

<svelte:head>
  <title>Privacy Policy — Snapdini</title>
  <meta name="description" content="Snapdini privacy policy: what we collect, how we use it, how long we keep your photos and emails, the services we use, and our promise never to sell your data or send unsolicited marketing." />
</svelte:head>

<main class="wrap">
  <a class="brand" href="/"><Logo /></a>
  <h1>Privacy Policy</h1>
  <p class="muted">Last updated {updated}</p>

  <p>This policy explains what information Snapdini collects, why, how long we keep it, and the choices you have. We've written it to be clear and honest. It works alongside our <a href="/terms">Terms &amp; Conditions</a>.</p>

  <h2>1. Our promises</h2>
  <ul>
    <li><strong>We never sell, rent, or trade your personal information</strong> to anyone.</li>
    <li><strong>We never send unsolicited marketing.</strong> The only emails we send are the ones needed to run the service (see below).</li>
    <li>We collect the minimum we need to provide Snapdini, and we delete event photos automatically after your event's retention period.</li>
  </ul>

  <h2>2. What we collect</h2>
  <ul>
    <li><strong>Account details</strong> — your email address, optional display name, and a securely hashed password (we never store your password in plain text).</li>
    <li><strong>Event content</strong> — the photos and videos you and your guests upload to an event.</li>
    <li><strong>Guest details</strong> — a guest's chosen name and, optionally, an email address they provide to receive their photos.</li>
    <li><strong>Basic technical data</strong> — a single sign-in session cookie, and minimal server logs needed for security and reliability. We only set analytics or advertising cookies with your consent, and never for profiling — see "Advertising &amp; analytics" below.</li>
    <li><strong>Diagnostic / error reports</strong> — if something fails (e.g. a photo won't upload), we may record a short technical report (the error message, where it happened, the event code, and your browser type) so we can find and fix the problem. These contain <em>no</em> photos or personal content, and are used only to improve reliability.</li>
    <li><strong>Payment details</strong> — handled entirely by our payment provider (Stripe). We never see or store your full card number.</li>
  </ul>

  <h2>3. How we use it</h2>
  <p>We use your information solely to provide and operate Snapdini: creating and running your events, storing and revealing photos, sending the transactional emails you've asked for (account verification, magic-link sign-in, and gallery/photo links), processing payments, and keeping the service secure and reliable. We do not use your data for advertising or profiling.</p>

  <h2>4. Photos &amp; videos — storage &amp; deletion</h2>
  <p>Your event's photos and videos are stored only to provide the service. They are <strong>automatically deleted after your event's retention period</strong> (the default window, extendable on paid plans). After deletion we keep only a small summary record of the event (its settings and basic stats such as photo and participant counts) for your history and our records — the media itself is gone.</p>
  <p>You and your guests own your content. Please keep your own copies of anything important; once the retention period passes, deleted media cannot be recovered.</p>

  <h2>5. Emails &amp; how long we keep them</h2>
  <p>We keep your <strong>account email address for as long as your account exists</strong> — there is no automatic expiry, so in practice we retain it indefinitely unless you ask us to delete your account. Guest emails are kept with their event and are removed when the event's data is purged.</p>
  <p>We use email addresses only for the service messages described above. <strong>We will never add you to a marketing list or sell your address.</strong> You can ask us to delete your account and associated personal data at any time (see "Your choices").</p>

  <h2>6. Services we rely on</h2>
  <p>To run Snapdini we use a small number of trusted providers, who process data only on our behalf:</p>
  <ul>
    <li><strong>Stripe</strong> — secure payment processing. Card data is handled by Stripe under their own privacy terms; we receive only confirmation of payment.</li>
    <li><strong>Our email provider</strong> (e.g. Mailgun/SMTP) — to deliver verification, sign-in, and gallery emails.</li>
    <li><strong>Google Sign-In</strong> — only if you choose to sign in with Google, in which case Google shares your basic profile email with us to create or match your account.</li>
    <li><strong>Hosting &amp; infrastructure</strong> — to store your data and serve the application securely.</li>
  </ul>
  <p>We share information with these providers only to the extent needed to deliver the service, and not for their own marketing.</p>

  <h2>6a. Advertising &amp; analytics</h2>
  <p>Where analytics or advertising measurement is enabled on this deployment, we use Google (Google Ads / Google Analytics) to understand how our marketing performs. This is implemented with <strong>Google Consent Mode v2</strong>: visitors in the EEA, the UK and Switzerland are asked to consent <em>before</em> any such data is shared with Google, using the banner shown on your first visit. You can decline (nothing is shared), and you can change your choice at any time — <a href="/?consent=1">reopen the consent options</a>. Outside those regions the tag runs by default; you can opt out there the same way, and we honour your browser's Global Privacy Control signal automatically. When enabled, this shares some data (such as a device/cookie identifier and pages viewed) with Google, which may process it on servers overseas, including in the United States. If the operator hasn't configured a tag, no analytics or advertising scripts are loaded at all.</p>

  <h2>6b. Finding photos of yourself (face matching)</h2>

  <p>

    Some events offer an optional feature that finds the photos you appear in. It is

    <b>off unless the event host turns it on</b>, and it does nothing until <b>you</b> choose to use it

    and tick the consent box. We never switch it on for you and never infer your agreement.

  </p>

  <p>

    If you use it, we create a <b>face template</b> — a numeric representation of your facial geometry —

    from a selfie you supply. Under the Privacy Act 1988 (Cth) a face template is

    <b>sensitive information</b>, which is why we ask for your express consent first.

  </p>

  <ul>

    <li><b>Your selfie is not kept.</b> It is used to build the template and deleted in the same request.</li>

    <li><b>Only your own template is stored</b>, and only while you keep the feature on. It is never

        shown to the host, to other guests, or returned by our API.</li>

    <li>To find your photos we examine faces in that event's photos. Those comparisons are

        <b>momentary</b> — nothing about anyone else is stored, and no template is ever created for a

        person who has not asked for this.</li>

    <li>What we keep is a <b>list of which photos you appear in</b>. That is a list of photo

        references, not facial data.</li>

    <li>It applies to <b>that one event only</b>. We never match you across events, never build a

        profile, and never share face data with anyone.</li>

    <li><b>Stop whenever you like.</b> Withdrawing deletes your template and every match derived from

        it, immediately. Everything also goes when the event's photos are deleted.</li>

    <li>All of this runs on <b>our own servers in Australia</b>. Face data is never sent overseas

        and never sent to a third party.</li>

  </ul>

  <p>

    If you would rather not appear in anyone's results, tell the event host — they can turn the

    feature off for the whole event — or email us and we will remove any matches referring to you.

  </p>


  <h2>7. Security</h2>
  <p>We protect your data with measures such as encrypted connections (HTTPS), hashed passwords, scoped access controls, and stripping embedded metadata from uploaded images. No system can be guaranteed perfectly secure, but we work continually to keep your information safe.</p>

  <h2>8. Your choices</h2>
  <p>You can update your account details, delete an event, or request deletion of your account and associated personal data. For any privacy request, contact <a href="mailto:support@snapdini.com">support@snapdini.com</a> and we'll action it promptly.</p>

  <h2>9. Changes</h2>
  <p>We may update this policy as the service evolves; material changes will be reflected here with a new "last updated" date.</p>

  <h2>10. Contact</h2>
  <p>Questions about your privacy? <a href="mailto:support@snapdini.com">support@snapdini.com</a>.</p>

  <p class="foot"><a href="/">← Back to Snapdini</a> · <a href="/terms">Terms &amp; Conditions</a></p>
  <p class="copyright">© 2026 Snapdini. All rights reserved.</p>
</main>

<SiteFooter showUses />

<style>
  .wrap { max-width: 720px; margin: 0 auto; padding: 28px 20px 72px; line-height: 1.6; }
  .brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 800; text-decoration: none; color: var(--text); }
  h1 { margin: 18px 0 2px; font-size: 1.8rem; }
  h2 { margin: 26px 0 6px; font-size: 1.1rem; }
  p { margin: 8px 0; }
  ul { margin: 8px 0; padding-left: 22px; }
  li { margin: 4px 0; }
  .muted { color: var(--text-muted); font-size: 0.85rem; }
  a { color: var(--accent); }
  .foot { margin-top: 32px; }
  .copyright { color: var(--text-muted); font-size: 0.78rem; margin-top: 6px; }
</style>
