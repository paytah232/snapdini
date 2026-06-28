# Snapdini — Code-Smell Audit (2026-06-21)

Audit of `src/` for issues independent of the SQLite→Postgres migration. Items marked
✅ were fixed during the migration; the rest are open.

## HIGH

1. **admin.js ↔ backend contract mismatches — several admin features are broken:**
   - `admin.js:257` POSTs `/:joinCode/unreveal` — **no such route** (only `/reveal` exists). "Hide" button 404s. Fix: add `/unreveal` (sets `revealed_at = NULL`) or make reveal a toggle.
   - `admin.js:342` POSTs `/api/photos/highlight` with `{photoIds, highlight}` — real route is `POST /api/events/:joinCode/highlights` (replace-all, takes only `photoIds`). Bulk highlight is broken.
   - `admin.js:239` email-gallery sends `{addresses}`; server reads `emails`. Always errors.
   - `admin.js:157` loads `GET /api/photos/:joinCode?organizerCode=` — photos GET ignores `organizerCode` and 403s. Admin photo grid can't load. Fix: add an organizer branch (or reuse photos from `/admin`).
   - `admin.js:143,149` read `joinedAt`/`photoCount`; `/admin` returns snake_case `joined_at`/`photos_taken`.
2. **No global Express error-handling middleware.** Multer errors (file too large / bad MIME) and thrown errors (`/qr` QRCode, `JSON.parse(theme)`) hit Express's default handler → HTML stack traces. Also async route rejections aren't caught. Fix: add a terminal `app.use((err,req,res,next)=>…)` returning JSON; wrap async handlers.
3. ✅ **`db.init()` never called** — FIXED (now awaited before `app.listen`).

## MEDIUM

4. **Duplicated `htmlEmail()` + `esc()`** in `events.js` and `participants.js` (identical). Move to `email.js`/shared util.
5. **Duplicated `isRevealed()`** in `events.js:17` and `photos.js:39`. Extract to shared module.
6. ✅ **Inconsistent `baseUrl`** — `/admin` + email-gallery hardcoded `localhost:3000` while `/qr` used the request host → broken links in emails. FIXED in events.js (now `baseUrl(req)` everywhere there). NOTE: `participants.js:106` (email-my-photos) still hardcodes localhost — open (needs shared `baseUrl`).
7. **`esc`/`escHtml` defined 3+ more times on the frontend** (`event.js`, `admin.js`, `gallery.html`). Make one shared `/js/util.js`.
8. **Triplicated frontend logic**: `downloadOne`/`downloadAll`, lightbox, `applyTheme`, `showToast` copied across event.js/admin.js/gallery.html. High divergence risk.
9. **Repeated fetch boilerplate + inconsistent error handling**; `gallery.html:55-61` parses `.json()` before checking `.ok`, so a 500 (HTML) throws and the gallery hangs on "Loading…". Add an `apiFetch()` helper.
10. **XSS-ish theme vectors** (NEW): `customCss` injected raw into `<style>` (up to 50k chars, unsanitized) on the public gallery — CSS exfiltration/beacons; and `theme.headerImage` interpolated into `url('${…}')` unquoted (`gallery.html:241`) — `')` breaks out. Sanitize/allowlist; validate headerImage is a `/uploads/...` path.
11. **Orphaned theme-image uploads**: image is stored on upload but only persisted on a later theme save; abandon = orphan file forever; replaced images never deleted.
12. **Event deletion leaves files on disk**: `DELETE /:joinCode` removes rows (cascade) but never unlinks `uploads/` files → unbounded disk leak.

## LOW

13. **Magic numbers/strings**: toast `2600`ms, download throttle `350/400`ms, `3_600_000`, photo-cap `1`/`100`, name slices `80/40/200/50_000`, join-code retry `< 10`. Note the join-code loop exits on attempt count, not success → a full collision streak inserts a dup code relying on the UNIQUE constraint to throw (unhandled). Name as constants; handle exhaustion.
14. **Input validation gaps**: emails never validated before send; `durationHours="abc"` passes the truthy check then yields `NaN` expiry; `photoIds` elements not type-checked.
15. **Dead code / misleading comments**: `event.js:521` email button always shown regardless of `emailEnabled`; `event.js:683` "prefill from localStorage" comment but value is cleared.
16. **Config nits**: email-gallery swallows per-address errors with bare `catch`; localStorage session-key built inconsistently across slug vs join-code (`home.js`/`event.js`) → a slug-join user may not match the stored key; `event.js:389` magic `99` fallback.

---

### Suggested fix order
- **Quick correctness wins**: #1 (admin features), #2 (error middleware). These make the admin panel actually work and stop stack-trace leaks.
- **Security pass** (with track 6): #10 (theme XSS), #12 (file cleanup), #14 (validation).
- **De-dup pass**: #4/#5/#7/#8/#9 — extract shared server util + frontend `util.js`.
