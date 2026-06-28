// Generate the social-share (Open Graph) image for Snapdini.
// Run inside the app container (it has sharp + fonts), then copy the result into web/static:
//
//   docker compose -f docker-compose.dev.yml exec app node scripts/make-og.mjs /app/src/og.png
//   cp app/src/og.png web/static/og.png && docker compose -f docker-compose.dev.yml exec -u root app rm /app/src/og.png
//   # then rebuild web so the new asset is served
//
// (web/static isn't mounted in the app container, so we write to the bind-mounted src/ and copy out.)
import sharp from 'sharp';

const OUT = process.argv[2] || '/app/src/og.png';
const W = 1200, H = 630;

const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
 <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#2c1e0d"/><stop offset="0.55" stop-color="#1b1208"/><stop offset="1" stop-color="#100b05"/>
 </linearGradient></defs>
 <rect width="${W}" height="${H}" fill="url(#bg)"/>
 <!-- top-hat emblem -->
 <ellipse cx="600" cy="178" rx="122" ry="22" fill="#f5c518"/>
 <rect x="543" y="76" width="114" height="102" rx="10" fill="#f5c518"/>
 <rect x="543" y="150" width="114" height="20" fill="#2a1d0c"/>
 <text x="600" y="332" font-family="DejaVu Sans" font-weight="bold" font-size="116" fill="#f5c518" text-anchor="middle">Snapdini</text>
 <text x="600" y="400" font-family="DejaVu Sans" font-size="40" fill="#ffffff" text-anchor="middle">The vanishing camera for your event</text>
 <text x="600" y="456" font-family="DejaVu Sans" font-size="27" fill="#d8cdb8" text-anchor="middle">Disposable-camera photo sharing · scan a QR · no app to install</text>
 <rect x="442" y="502" width="316" height="54" rx="27" fill="none" stroke="#f5c518" stroke-width="2"/>
 <text x="600" y="537" font-family="DejaVu Sans" font-size="26" fill="#f5c518" text-anchor="middle">Free for up to 10 guests</text>
</svg>`;

const info = await sharp(Buffer.from(svg)).png().toFile(OUT);
console.log(`Wrote ${OUT} — ${info.width}x${info.height}, ${(info.size / 1024).toFixed(1)}KB`);
