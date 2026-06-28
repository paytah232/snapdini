<script lang="ts">
  import Logo from '$lib/components/Logo.svelte';
  const updated = 'June 2026';
</script>

<svelte:head>
  <title>Terms & Conditions — Snapdini</title>
  <meta name="description" content="Snapdini terms of service: reliability, refunds, your photos and acceptable use." />
</svelte:head>

<main class="wrap">
  <a class="brand" href="/"><Logo /></a>
  <h1>Terms &amp; Conditions</h1>
  <p class="muted">Last updated {updated}</p>

  <p>By creating or joining an event on Snapdini, you agree to these terms. We've written them to be clear and concise.</p>

  <h2>1. The service</h2>
  <p>Snapdini lets you run a shared "disposable camera" for an event — guests scan a QR code, take a limited roll of photos, and the gallery is revealed when the event ends. We provide it as-is and continually work to improve it.</p>

  <h2>2. Reliability &amp; availability</h2>
  <p>We work hard to keep Snapdini fast, available, and your photos safe for the retention period of your plan, and we continue to invest in the resilience and redundancy of our infrastructure. While we aim for uninterrupted service, no online service can guarantee 100% uptime — occasional maintenance, updates, or unexpected outages may briefly affect availability. When they occur, restoring service quickly is our priority.</p>
  <p>To the fullest extent permitted by law, the service is provided "as is" and "as available", without warranties of any kind. We are not liable for any indirect, incidental, special, or consequential losses, nor for any loss of data, photos, profit, or goodwill, arising out of or in connection with your use of (or inability to use) Snapdini — including downtime, data loss, or the acts of guests or third parties. Where we are found liable despite this, our total liability to you is limited to the amount you paid us for the event in question. Nothing in these terms excludes any liability that cannot be excluded by law. Where supported, your device queues photos locally and uploads them automatically once a connection is restored; even so, we recommend keeping your own copies of anything important.</p>

  <h2>3. Issues, resolutions &amp; refunds</h2>
  <p>Your event matters to us, and we stand behind the service. If you experience a problem, contact us at <a href="mailto:support@snapdini.com">support@snapdini.com</a> and we'll work with you to resolve it promptly.</p>
  <p><strong>If a fault on our side prevents you from receiving what you paid for, we will make it right</strong> — by restoring the service, extending your event or photo retention at no charge, or issuing a refund, whichever is appropriate. Refund requests are reviewed on a case-by-case basis and, where due, returned to your original payment method.</p>

  <h2>4. Your photos &amp; content</h2>
  <p>You and your guests own the photos you take. We store them only to provide the service, and we delete them after your event's retention period (you can extend retention on paid plans). You're responsible for having the right to capture and share the content uploaded to your event, and for complying with the wishes of the people in it.</p>
  <p>If you add your own music, audio, images, or other content to a slideshow, poster, or anywhere else in Snapdini, you confirm that you own it or have obtained all the rights and licences needed to use it in this way. Music and other media are often protected by copyright; obtaining any necessary licences is your responsibility, and Snapdini accepts no responsibility or liability for content you supply. You agree to indemnify and hold Snapdini harmless against any claims, damages, or costs arising from content you upload or from your breach of these terms.</p>

  <h2>5. Acceptable use</h2>
  <p>Don't use Snapdini for anything unlawful, abusive, or infringing, and don't attempt to disrupt or misuse the service. We may suspend events that break these terms.</p>

  <h2>6. Pricing &amp; payment</h2>
  <p>Events for small gatherings are free. Larger events and optional add-ons are one-off purchases, with the price shown clearly before you pay. Payments are processed securely by our payment provider; applicable taxes may apply.</p>

  <h2>7. Changes</h2>
  <p>We may update these terms as the service evolves; material changes will be reflected here with a new "last updated" date.</p>

  <h2>8. Contact</h2>
  <p>Questions? <a href="mailto:support@snapdini.com">support@snapdini.com</a>.</p>

  <p class="foot"><a href="/">← Back to Snapdini</a> · <a href="/privacy">Privacy Policy</a></p>
  <p class="copyright">© 2026 Snapdini. All rights reserved.</p>
</main>

<style>
  .wrap { max-width: 720px; margin: 0 auto; padding: 28px 20px 72px; line-height: 1.6; }
  .brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 800; text-decoration: none; color: var(--text); }
  h1 { margin: 18px 0 2px; font-size: 1.8rem; }
  h2 { margin: 26px 0 6px; font-size: 1.1rem; }
  p { margin: 8px 0; }
  .muted { color: var(--text-muted); font-size: 0.85rem; }
  a { color: var(--accent); }
  .foot { margin-top: 32px; }
  .copyright { color: var(--text-muted); font-size: 0.78rem; margin-top: 6px; }
</style>
