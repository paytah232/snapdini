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

  test('leads with the deadline, because that is the useful part', () => {
    const html = surveyEmail(view({ slideshow })).html;
    // Derived, not spelled out: a hard-coded "31 October" passes here and fails on a machine an
    // hour the other side of UTC, which is a flake rather than a finding.
    const expected = new Date(slideshow.photosUntil).toLocaleDateString('en-AU', { day: 'numeric', month: 'long' });
    assert.ok(html.includes(expected), `no date the photos go (expected ${expected})`);
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
