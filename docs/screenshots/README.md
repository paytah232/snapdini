# Screenshots & demo GIF — capture guide

These assets power the **See it in action** section of the root `README.md`. Drop the files in
**this folder** with the exact filenames below, then the README block (at the bottom of this file)
renders on GitHub. Until the files exist, the README doesn't reference them (no broken images).

> Tip: capture against the **live demo** — open <https://snapdini.com> and hit
> *"See what it looks like →"* for a real throwaway event with the camera + gallery.

## The shot list

| File | What it shows | How to grab it |
|---|---|---|
| `hero-reveal.gif` | **The money shot.** Scan QR → browser camera opens → a photo "develops" into the shared gallery. | Screen-record the demo flow on a phone (or browser device-mode). 8–15s, loops. See GIF tips below. |
| `camera.png` | The in-browser camera with the **limited-roll counter** — proves "no app". | Phone screenshot, or Chrome DevTools device mode (iPhone) on `/join/<demo>`. Portrait. |
| `gallery.png` | The **shared gallery** grid, full of event photos. | Desktop or mobile, the demo gallery with a few shots in it. |
| `create-event.png` | The **create-event form** — shows how fast setup is (name, shots, reveal). | Desktop, `/app`. Crop to the card. |
| `poster.png` | The **printable QR table poster** (logo-in-QR). | From the manager → poster/QR view; screenshot the poster preview. |

Keep stills **landscape ~1400×900** (or portrait ~750×1334 for phone shots), PNG, and run them
through an optimizer (TinyPNG / `oxipng`) so the repo stays light.

## Making `hero-reveal.gif` crisp & small

1. Record the screen (macOS: [Kap](https://getkap.co); Windows: [ScreenToGif](https://www.screentogif.com); or any screen recorder → `.mp4`).
2. Convert with a shared palette so it's sharp but small:
   ```bash
   ffmpeg -i recording.mp4 -vf "fps=15,scale=720:-1:flags=lanczos,palettegen" palette.png
   ffmpeg -i recording.mp4 -i palette.png -lavfi "fps=15,scale=720:-1:flags=lanczos[x];[x][1:v]paletteuse" hero-reveal.gif
   ```
3. Aim for **< 5 MB** (GitHub will display up to 10 MB, but smaller loads faster). Trim to the
   essential 8–15s: scan → camera → snap → the reveal.

## README block to paste

Once the files are in, splice this into the root `README.md` right after the intro paragraph
(before **Quick start**). It uses HTML so the paired shots sit side-by-side on GitHub:

```html
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
```
