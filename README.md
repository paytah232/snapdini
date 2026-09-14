# Snapdini

📸 A digital **disposable camera for events**. Guests scan a QR code — no app to install — snap a
limited roll, and the whole gallery reappears when the event ends. **Free for small events,
open-source, and self-hostable.**

🔗 Hosted version: **[snapdini.com](https://snapdini.com)**  ·  📖 How to use it: **[docs/GUIDE.md](docs/GUIDE.md)**

## See it in action

<p align="center">
  <img src="docs/screenshots/hero-reveal.gif" alt="Scan a QR code, shoot a limited roll, and the whole gallery reappears when the event ends" width="760">
</p>

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/camera.png" alt="In-browser camera with a limited roll — no app to install" width="100%"></td>
    <td width="50%"><img src="docs/screenshots/gallery.png" alt="Every guest's photos in one shared gallery" width="100%"></td>
  </tr>
  <tr>
    <td align="center"><b>Guests scan &amp; shoot</b><br><sub>A limited roll, right in the browser</sub></td>
    <td align="center"><b>One shared gallery</b><br><sub>Reveal at the end, download the lot</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/create-event.png" alt="Create an event in about a minute" width="100%"></td>
    <td width="50%"><img src="docs/screenshots/poster.png" alt="Printable QR table poster with the logo in the code" width="100%"></td>
  </tr>
  <tr>
    <td align="center"><b>Set up in a minute</b><br><sub>Name it, pick the roll size &amp; reveal</sub></td>
    <td align="center"><b>Print the QR poster</b><br><sub>Drop it on the tables — guests join in a tap</sub></td>
  </tr>
</table>

## What you get

- **A limited roll per guest.** The scarcity is the feature — a fixed number of shots makes people
  think before they press the shutter, which is the whole reason disposable cameras are back.
- **A real camera in the browser.** Tap-to-focus, flash, lens picker, photo shapes, and optional
  video clips. Photos are saved on the device first and uploaded one at a time, so a bad venue wifi
  queues rather than loses.
- **A reveal you choose.** Instantly as photos land, when the event ends (after a delay or at an
  exact moment you pick), or manually when you press the button. Optional moderation holds every
  photo until you approve it.
- **One shared gallery**, plus share links scoped to the whole gallery, your favourites, or photos
  you hand-pick. Downloads as a zip, or straight into the phone's own photo library.
- **A guest list that tells you what arrived.** Add guests by hand or import a spreadsheet, send
  branded invites, and see what happened to each one — delivered, bounced, reported as spam — in the
  mail server's own words. (Per-recipient delivery state needs Mailgun and a webhook key; without
  them an invite honestly reads "sent, delivery unknown".) Guests can ask for their own photos and
  get them when the gallery opens, and a one-click unsubscribe plus a suppression list keep the
  sending domain out of trouble.
- **Print for the tables.** A poster designer that also prints *trick cards* — a short list of shots
  for guests to hunt down and tick off in the camera as they take them.
- **A slideshow of the night**, rendered server-side with your own music.
- **Themes, a custom `/e/<name>` link, co-hosts, and a retention window** after which the photos and
  guest data are deleted.

Every page and control is written up in the **[page & feature guide](docs/GUIDE.md)**.

## Quick start — self-host it

No build step. Pulls the prebuilt images and runs them with Postgres + nginx.

**Before you start you need two things:**

- **Docker Engine with the Compose v2 plugin** (`docker compose version` should answer). Nothing
  else — no Node, no Postgres, no ffmpeg on the host; they are all inside the images.
- **A public HTTPS URL** pointing at the box, terminated by a reverse proxy you run (Traefik, Caddy,
  nginx, a tunnel — your choice). This is not optional polish: browsers only hand a page the camera
  and the microphone on a secure origin, so over plain `http://` on anything but `localhost` the
  guest camera simply never opens.

```bash
mkdir snapdini && cd snapdini
curl -O https://raw.githubusercontent.com/paytah232/snapdini/main/app/docker-compose.yml
mkdir nginx && curl -o nginx/default.conf https://raw.githubusercontent.com/paytah232/snapdini/main/app/nginx/default.conf
curl -o .env https://raw.githubusercontent.com/paytah232/snapdini/main/app/.env.example
# the upgrade helper — it checks the traps that `pull && up -d` alone will not
curl -o upgrade.sh https://raw.githubusercontent.com/paytah232/snapdini/main/app/scripts/upgrade.sh && chmod +x upgrade.sh

# edit .env — at minimum set BASE_URL (your public https URL) + POSTGRES_PASSWORD
docker compose pull
docker compose up -d
```

Four containers come up — `app` (the API), `web` (the SvelteKit front end), `db` (Postgres) and
`nginx` (the one that publishes the port). Snapdini answers on `HTTP_PORT` (default `8080`); point
your TLS / reverse proxy at that, and make sure the address it serves is exactly what you put in
`BASE_URL`.

- **Fully free, no limits, when self-hosted.** Billing, email, the admin panel and analytics stay
  **off until you add their keys** (`STRIPE_*`, `MAILGUN_*`, `ADMIN_*`, `GTAG_ID`/`MSUET_ID` in
  `.env` — all optional; no tag id ⇒ zero third-party tracking). `.env.example` documents every
  setting.
- **Set `SEO_INDEXABLE=1` on exactly one deployment** — the public one named in `BASE_URL`. Unset
  means `noindex`, which is the right default for a staging copy and the reason a preview host
  cannot outrank your real one.
- **Pin a version** with `IMAGE_TAG` in `.env` (e.g. `IMAGE_TAG=1.4.3`; default `latest`). Point at
  your own registry with `IMAGE_PREFIX`.
- **Upgrades**: run `./upgrade.sh [version]`, or see **[UPGRADING.md](UPGRADING.md)**.
  DB migrations apply on boot, but `pull && up -d` alone is not always enough — a release can add
  settings that must go in **both** `.env` and `docker-compose.yml` (compose passes env explicitly,
  so a variable missing from it is silently ignored), and it never updates your `docker-compose.yml`
  or `nginx/default.conf`.

## Optional: "find the photos I'm in" (self-host only)

Guests can upload a selfie and pull out just the photos they appear in. It is **off in the hosted
service and shipped off by default**, because face templates are biometric data and the compliance
picture varies by jurisdiction — but if you run your own instance for your own events, it is a
genuinely good feature and it is fully built.

Point `MACHINE_LEARNING_URL` at an [Immich machine-learning](https://github.com/immich-app/immich)
container. It talks over plain HTTP with image bytes in the request, so **the ML container needs no
access to your photo storage** — no shared volume, no bind mount. It can live on the same box or a
different one.

```yaml
  machine-learning:                       # add to your docker-compose.yml
    image: ghcr.io/immich-app/immich-machine-learning:release
    volumes: [ model-cache:/cache ]       # models only — never your photos
    restart: unless-stopped
```
```bash
MACHINE_LEARNING_URL=http://machine-learning:3003
```

With it unset the feature does not exist: no host toggle, no guest control, no privacy-policy
section, and the endpoints return 503. With it set, it is still **off per event** until a host turns
it on, and then **off per guest** until that guest ticks an unticked consent box. A guest's selfie is
deleted in the same request that creates their template; every other face in a photo is compared and
discarded in memory. "Stop and delete" removes the template and every match it produced, and keeps
working even if you later switch the ML container off.

**Think carefully before turning this on for anyone other than yourself.** Face templates are
biometric data in most jurisdictions. Two things in particular need an answer you are comfortable
with: you necessarily process the faces of guests who never consented in order to find the one who
did, and events often include minors. Take your own advice on it — this project cannot give you
legal advice for your country.

## Built with

Express + TypeScript + Postgres (Drizzle ORM) for the API, SvelteKit for the web app, behind nginx —
all in Docker. Building from source, developing, or publishing your own images? See the
**[development & maintainer guide](docs/DEVELOPMENT.md)**.

## Docs

| | |
|---|---|
| **[docs/GUIDE.md](docs/GUIDE.md)** | Every page and every control, grouped by who uses it. Start here to learn the app. |
| **[UPGRADING.md](UPGRADING.md)** | The traps `pull && up -d` does not close, plus per-release notes. |
| **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** | Architecture, the dev stack, the gotchas worth knowing before you change something, and how releases are cut. |
| **[TESTING.md](TESTING.md)** | The manual QA checklist, and what the automated suites already cover. |

## Support

Snapdini is free and self-hostable. If it's useful to you and you'd like to support the work, you can
**[buy me a coffee ☕](https://buymeacoffee.com/paytah232)** — much appreciated, never required.

## License

Released under the [GNU AGPL-3.0](LICENSE). You're free to self-host, modify and redistribute it; if
you run a modified version as a network service, you must make your source available under the same
licence. © 2026 paytah232.

The poster designer bundles five typefaces — Playfair Display, Cormorant Garamond, Great Vibes,
Sacramento and Jost — each under the [SIL Open Font License 1.1](web/static/fonts/OFL.txt), which
covers redistributing them with the application. Per-family copyright notices are in
[`web/static/fonts/README.md`](web/static/fonts/README.md). The OFL is separate from the AGPL and
applies only to those files.
