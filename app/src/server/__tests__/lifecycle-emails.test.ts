// The post-event email is the one a host reads when the day is over and the photos are on a clock.
// It carries three things — a survey ask, a thank-you discount, and (new) the slideshow they may not
// know exists. These pin the rules that keep that from turning into spam: the slideshow is mentioned
// only when there is something to make one from, and the survey remains the point of the email.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { surveyEmail, type LifecycleView } from '../lifecycle-emails';

const view = (extra: Partial<LifecycleView> = {}): LifecycleView => ({
  ownerName: 'Sam', eventName: 'Ruby & Sam', guestCap: 40, shotsPerGuest: 12, framesAll: false,
  hasVideo: false, videoSeconds: 0, revealMode: 'at_end', retentionDays: 7,
  datesLabel: 'Sat 24 Oct 2026', manageUrl: 'https://snapdini.com/dashboard',
  surveyUrl: 'https://snapdini.com/survey/tok', ...extra,
});
const slideshow = { url: 'https://snapdini.com/admin/ABC123/review?view=slideshow', photoCount: 84,
                    photosUntil: Date.UTC(2026, 9, 31) };

describe('the post-event email', () => {
  test('asks for the survey whatever else it carries', () => {
    const html = surveyEmail(view({ slideshow })).html;
    assert.ok(html.includes('Take the 2-minute survey'));
    assert.ok(html.includes('https://snapdini.com/survey/tok'));
  });

  test('says nothing about a slideshow when there is nothing to make one from', () => {
    // A purged or empty event: pointing it at a feature that cannot work reads as spam.
    const html = surveyEmail(view()).html;
    assert.ok(!/slideshow/i.test(html), 'mentioned a slideshow with no photos');
  });

  test('offers the slideshow when the photos are still there', () => {
    const html = surveyEmail(view({ slideshow })).html;
    assert.ok(/slideshow/i.test(html));
    assert.ok(html.includes(slideshow.url), 'no link to the slideshow');
    assert.ok(html.includes('All 84 of them'), 'did not say how many photos');
  });

  test('always states the date the photos go', () => {
    // Derived, not spelled out: a hard-coded "31 October" passes here and fails on a machine an
    // hour the other side of UTC, which is a flake rather than a finding.
    const soon = Date.now() + 4 * 86_400_000;
    const html = surveyEmail(view({ slideshow: { ...slideshow, photosUntil: soon } })).html;
    const expected = new Date(soon).toLocaleDateString('en-AU', { day: 'numeric', month: 'long' });
    assert.ok(html.includes(expected), `no date the photos go (expected ${expected})`);
  });

  test('hurries the host only when the photos really are about to go', () => {
    // A week's retention: the survey lands with about four days left, so the nudge is honest.
    const html = surveyEmail(view({ slideshow: { ...slideshow, photosUntil: Date.now() + 4 * 86_400_000 } })).html;
    assert.ok(/worth doing before they go/i.test(html), 'did not nudge with four days left');
  });

  test('does not invent urgency on a month of retention', () => {
    // Half of real events keep their photos a month. "Make it before then" with 27 days left is a
    // lie the host notices, and then discounts everything else we tell them.
    const html = surveyEmail(view({ slideshow: { ...slideshow, photosUntil: Date.now() + 27 * 86_400_000 } })).html;
    assert.ok(/no rush/i.test(html), 'pressured a host who has a month');
    assert.ok(!/worth doing before they go/i.test(html), 'still nudged a host who has a month');
  });

  test('names the event the photos came from, not the couple', () => {
    // "turn Ruby & Sam into a slideshow" reads as turning the PEOPLE into one; event names are
    // usually names, so the phrasing has to survive that.
    const html = surveyEmail(view({ slideshow })).html;
    assert.ok(html.includes('the photos from Ruby &amp; Sam'), html.slice(html.indexOf('Did you know'), 160));
  });

  test('the slideshow sits after the survey ask, not in front of it', () => {
    const html = surveyEmail(view({ slideshow })).html;
    assert.ok(html.indexOf('Take the 2-minute survey') < html.indexOf('Make the slideshow'));
  });

  test('an event name cannot inject markup into the email', () => {
    const html = surveyEmail(view({ eventName: '<img src=x onerror=alert(1)>', slideshow })).html;
    assert.ok(!html.includes('<img src=x'), 'event name rendered as raw HTML');
    assert.ok(html.includes('&lt;img src=x'));
  });

  test('the subject names the event so it is not mistaken for a mailshot', () => {
    assert.ok(surveyEmail(view()).subject.includes('Ruby & Sam'));
  });
});

// ── Whether the slideshow is offered at all ──────────────────────────────────
// The renderer above is only half of it. These are the rules that decide whether a host is pointed
// at the feature, and each one exists to stop us emailing someone about something that cannot work.
import { slideshowOffer } from '../lifecycle';

const DAY = 86_400_000;
const ev = (over: Partial<{ purgedAt: number | null; purgeAt: number | null; joinCode: string }> = {}) =>
  ({ purgedAt: null, purgeAt: Date.now() + 4 * DAY, joinCode: 'ABC123', ...over });

describe('whether to mention the slideshow', () => {
  test('offers it when the photos are there and there are enough of them', () => {
    const o = slideshowOffer(ev(), 40, 'https://snapdini.com');
    assert.ok(o);
    assert.equal(o.photoCount, 40);
    assert.ok(o.url.endsWith('/admin/ABC123/review?view=slideshow'));
  });

  test('never on a purged event — the photos are already gone', () => {
    assert.equal(slideshowOffer(ev({ purgedAt: Date.now() - DAY }), 40, 'https://snapdini.com'), undefined);
  });

  test('never when the photos go before the host could act on it', () => {
    assert.equal(slideshowOffer(ev({ purgeAt: Date.now() - 1 }), 40, 'https://snapdini.com'), undefined);
    assert.equal(slideshowOffer(ev({ purgeAt: null }), 40, 'https://snapdini.com'), undefined);
  });

  test('not for an event that barely happened', () => {
    assert.equal(slideshowOffer(ev(), 0, 'https://snapdini.com'), undefined);
    assert.equal(slideshowOffer(ev(), 7, 'https://snapdini.com'), undefined);
    assert.ok(slideshowOffer(ev(), 8, 'https://snapdini.com'), 'eight photos should qualify');
  });

  test('the link carries no organizer code — an emailed code is a bearer credential', () => {
    const o = slideshowOffer(ev(), 40, 'https://snapdini.com');
    assert.ok(!/#/.test(o!.url) && !/code=/.test(o!.url), o!.url);
  });

  test('the deadline it reports is the event’s own, not a guess', () => {
    const purgeAt = Date.now() + 11 * DAY;
    assert.equal(slideshowOffer(ev({ purgeAt }), 40, 'https://snapdini.com')!.photosUntil, purgeAt);
  });
});
